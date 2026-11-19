/**
 * Background-work runtime extensions for {@link LocalAgent} (T4.2 + T4.3).
 *
 * Extracted from `local-agent.ts` to keep that file under the 400-LoC
 * guard (G8). The two helpers below implement
 * `LocalAgent.runUntil(goal, options)` and `LocalAgent.fork(options)`
 * by lazy-importing the implementation modules and resolving
 * `Agent.create` through the DI registry (see
 * `agent-factory-registry.ts` for the cycle-avoidance rationale).
 *
 * @internal
 */

import type { AgentOptions, MemorySettings, SDKAgent } from "../../types/agent.js";
import type { GoalEvent, GoalOptions, GoalResult } from "../../types/goal-events.js";
import type { RunToCompletionOptions, RunToCompletionResult } from "../../types/run.js";
import { diagFailure } from "../diagnostics.js";
import type { JudgeContext, JudgeOptions } from "../judge/judge-call.js";
import type { ForkOptions, ForkResult } from "../runtime/lifecycle/fork-agent.js";
import type { RunUntilDeps } from "../runtime/lifecycle/run-until.js";
import {
  appendMemoryFact,
  extractMemoryFact,
  extractMemoryKind,
  isMemoryWritePrompt,
  unstoredRememberWarning,
} from "../runtime/memory-glue/memory-store.js";

/**
 * Drive {@link runUntilImpl} with the registered `Agent.create` so
 * `LocalAgent.runUntil` returns the canonical
 * `AsyncGenerator<GoalEvent, GoalResult, void>` shape (ADR D116).
 *
 * SE40 (v4.0) — the DURABLE objective path (SE33) was removed: `runUntil` is now
 * exclusively the ephemeral, explicit-goal judge loop. A call with no goal pauses.
 *
 * @internal
 */
export function localAgentRunUntil(
  agent: SDKAgent,
  goal: string | undefined,
  options: GoalOptions | undefined,
): AsyncGenerator<GoalEvent, GoalResult, void> {
  async function* wrap(): AsyncGenerator<GoalEvent, GoalResult, void> {
    const { runUntilImpl } = await import("../runtime/lifecycle/run-until.js");
    const buildDeps = async (): Promise<RunUntilDeps> => {
      const { judgeCallImpl } = await import("../judge/judge-call.js");
      const { getAgentFacade } = await import("../runtime/registry/agent-factory-registry.js");
      const create = getAgentFacade().create;
      return {
        judge: (ctx: JudgeContext, opts?: JudgeOptions) => judgeCallImpl(ctx, opts, { create }),
      };
    };

    if (goal === undefined) {
      yield {
        type: "status_change",
        status: "paused",
        reason: "runUntil() requires an explicit goal (durable objectives removed in v4.0)",
      };
      return { status: "paused", turnsUsed: 0, tokensUsed: 0, finalResponse: undefined };
    }
    return yield* runUntilImpl(agent, goal, options, await buildDeps());
  }
  return wrap();
}

/**
 * Drive {@link runToCompletionImpl} bound to this agent's stateful `send`
 * (M1 Phase 3). The agent's session preserves conversation history, so the
 * driver only re-sends a short continuation prompt after each truncated round.
 *
 * @internal
 */
export function localAgentRunToCompletion(
  agent: SDKAgent,
  message: string,
  options: RunToCompletionOptions | undefined,
): Promise<RunToCompletionResult> {
  async function run(): Promise<RunToCompletionResult> {
    const { runToCompletionImpl } = await import("../runtime/lifecycle/run-to-completion.js");
    return runToCompletionImpl({ send: (m, o) => agent.send(m, o) }, message, options);
  }
  return run();
}

/**
 * Drive the STREAMING continuation twin (V3-4) bound to this agent's stateful
 * `send` — yields each round's `SDKMessage`s live, reusing the M1 terminal policy.
 *
 * @internal
 */
export async function* localAgentStreamToCompletion(
  agent: SDKAgent,
  message: string,
  options: RunToCompletionOptions | undefined,
): AsyncGenerator<
  import("../../types/messages.js").SDKMessage,
  import("../../types/run.js").StreamToCompletionResult
> {
  const { streamToCompletionImpl } = await import("../runtime/lifecycle/stream-to-completion.js");
  return yield* streamToCompletionImpl({ send: (m, o) => agent.send(m, o) }, message, options);
}

/**
 * Spawn a forked auxiliary agent (ADR D110). Reads `Agent.create` from
 * the DI registry.
 *
 * @internal
 */
export async function localAgentFork(
  parent: { agentId: string; options: AgentOptions; personalitySlugSnapshot: string | undefined },
  options: ForkOptions,
): Promise<ForkResult> {
  const { forkAgentImpl } = await import("../runtime/lifecycle/fork-agent.js");
  const { getAgentFacade } = await import("../runtime/registry/agent-factory-registry.js");
  const { withPersonalityContext } = await import("../personality/context.js");
  const create = getAgentFacade().create;
  // ADR D168 + EC-A — capture the slug ONCE at fork-construction time.
  // Subsequent parent `usePersonality` calls do NOT mutate this snapshot.
  return withPersonalityContext({ slug: parent.personalitySlugSnapshot, isFork: true }, () =>
    forkAgentImpl(parent, options, { create }),
  );
}

/**
 * Extract a memory fact from a "Remember:" user prompt and persist it
 * via `appendMemoryFact`. No-op when memory is disabled, the prompt is
 * not a write directive, or the extracted fact is empty (EC-3/EC-4).
 *
 * The two no-op paths REPORT (#462). They used to return in silence, so a phrase one token from the
 * supported one — `Remember, please:` — answered normally, stored nothing, and told nobody; the
 * caller could only find out by listing the store afterwards. `diagFailure`, not `diag`: the user
 * asked for something durable and did not get it, and `diag` is dropped entirely with no sink
 * installed. That is the `#189` distinction — a silently dropped failure is neither visible nor
 * recoverable, while a diagnostic in a busy terminal is both.
 *
 * Moved here from `LocalAgent` to keep the class file under G8.
 *
 * @internal
 */
export async function persistMemoryFactIfWritePrompt(
  workspaceCwd: string,
  memoryConfig: MemorySettings | undefined,
  userText: string,
  mirror?: { write(text: string): Promise<void> },
): Promise<void> {
  if (memoryConfig?.enabled !== true) return;
  const unstored = unstoredRememberWarning(userText);
  if (unstored !== undefined) {
    diagFailure(unstored);
    return;
  }
  if (!isMemoryWritePrompt(userText)) return;
  const fact = extractMemoryFact(userText);
  if (fact.length === 0) return;
  const kind = extractMemoryKind(userText);
  try {
    await appendMemoryFact(
      workspaceCwd,
      memoryConfig,
      {
        text: fact,
        ...(kind === undefined ? {} : { kind }),
      },
      mirror,
    );
  } catch (cause) {
    // NOT `safeCall`: it reports on `diag`, which is dropped entirely when the host installed no
    // sink — so a permission error on the memory directory looked exactly like a successful
    // capture. The swallow itself stays: one unwritable memory must not abort the turn. What
    // changes is that the swallow now says so on the channel a failure cannot be dropped from.
    const message = cause instanceof Error ? cause.message : String(cause);
    diagFailure(`[theokit-sdk] memory write failed, nothing was stored: ${message}`);
  }
}
