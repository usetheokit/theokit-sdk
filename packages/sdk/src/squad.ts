/**
 * `createSquad` — a sequential team of agents.
 *
 * A Squad is a thin convenience that COMPOSES `Workflow` + `agentStep` — it
 * adds NO new orchestration logic. Agents run in array order; each agent's
 * output is threaded into the next agent's prompt. For branching/parallel/
 * foreach teams use `Workflow` directly; for manager→worker delegation use
 * subagents or `@theokit/sdk-handoff`.
 *
 * Mirrors the `createAgentFactory` composition-LEGO precedent (a factory over
 * existing primitives, not a new subsystem).
 *
 * @public
 */

import { ConfigurationError } from "./errors.js";
import { diagFailure } from "./internal/diagnostics.js";
import type { AgentDefinition, SDKAgent } from "./types/agent.js";
import type { StepResult } from "./types/workflow.js";
import { agentStep, Workflow } from "./workflow.js";

/**
 * Options for {@link createSquad}.
 *
 * @public
 */
export interface SquadOptions {
  /**
   * Agents run in array order (sequential pipeline). Must be non-empty.
   *
   * M81 — accepts an `AgentDefinition` (plain data) as well as a constructed `SDKAgent`. Building a
   * team used to force the caller to materialize every member by hand first: resolve the credential,
   * assemble the options, call `Agent.create`, await. That is precisely the work this milestone moves
   * into the framework elsewhere, so leaving it here would be inconsistent — and with
   * `discoverSubagents` now public (`@theokit/sdk/subagents-loader`), the data that describes an
   * agent is reachable, which closes the loop: discover → build a team, with no manual step between.
   *
   * Mixing both forms in one list is supported on purpose: a real team usually has members from
   * different origins.
   */
  agents: ReadonlyArray<SDKAgent | AgentDefinition>;
  /**
   * Orchestration process. Only `"sequential"` is supported (the default).
   * `"hierarchical"` is accepted by the type but rejected at runtime with
   * guidance — use subagents or `@theokit/sdk-handoff` for manager→worker
   * delegation (those already cover it).
   */
  process?: "sequential" | "hierarchical";
  /** Optional squad name (surfaced on the underlying workflow). Default `"squad"`. */
  name?: string;
  /** Dispose the `SDKAgent` members passed in after each run. Default false. Members built from an `AgentDefinition` are always disposed. */
  ownsMembers?: boolean;
  /** Receives a member disposal failure. Default: `diagFailure`. Disposal failures never fail the run. */
  onDisposeError?: (error: unknown, memberIndex: number) => void;
}

/**
 * Per-run options for {@link Squad.run}.
 *
 * @public
 */
export interface SquadRunOptions {
  /** Aborting cancels the member run in flight and resolves with status "cancelled". */
  signal?: AbortSignal;
  /** Shorthand for a timer signal. On expiry the run is cancelled and resolves with status "cancelled" and `timedOut: true`. */
  timeoutMs?: number;
}

/**
 * Result of a {@link Squad.run}. `result` is the final (last agent's) output;
 * `steps` is the per-agent trace from the underlying workflow run.
 *
 * @public
 */
export interface SquadRun {
  readonly result: unknown;
  readonly status: "running" | "completed" | "failed" | "suspended" | "cancelled";
  readonly steps: ReadonlyArray<StepResult>;
  /** `true` when the run was cancelled because `timeoutMs` elapsed. */
  readonly timedOut?: boolean;
}

/**
 * A sequential agent team produced by {@link createSquad}.
 *
 * @public
 */
export interface Squad {
  /** Run the team over `input`, threading each agent's output to the next. */
  run(input: unknown, options?: SquadRunOptions): Promise<SquadRun>;
}

/**
 * M81 — an `SDKAgent` is recognised by having `send`; an `AgentDefinition` is plain data.
 *
 * Structural, not `instanceof`: the definition crosses package boundaries as data (that is the whole
 * interop contract the layer relies on), so an identity check would fail exactly when two copies of
 * the SDK are loaded — the failure mode M79 measured.
 */
function isBuiltAgent(m: SDKAgent | AgentDefinition): m is SDKAgent {
  return typeof (m as SDKAgent).send === "function";
}

/**
 * M81 — turns an `AgentDefinition` into an executable agent.
 *
 * `Agent` is imported dynamically because `squad.ts` is consumed by paths that do not want to drag the
 * whole agent in just to declare a team; the cost is only paid by callers actually passing raw data.
 */
async function materialize(def: AgentDefinition, index: number): Promise<SDKAgent> {
  const { Agent } = await import("./agent.js");
  return Agent.create({
    // `AgentDefinition.model` admits the sentinel `'inherit'`, which is not a model id. Inheriting
    // here means "declare nothing and let the default apply" — forwarding the literal would create
    // an agent asking for a model literally named `inherit`.
    ...(def.model !== undefined && def.model !== "inherit" ? { model: def.model } : {}),
    ...(def.prompt !== undefined ? { systemPrompt: def.prompt } : {}),
    agentId: `squad-member-${String(index)}`,
    local: {},
  });
}

/**
 * Build a sequential agent team. The returned {@link Squad} composes a
 * `Workflow` of `agentStep`s under the hood — all orchestration is delegated
 * to the workflow engine.
 */
function createSquad(options: SquadOptions): Squad {
  const { agents } = options;
  if (!Array.isArray(agents) || agents.length === 0) {
    throw new ConfigurationError("createSquad requires a non-empty `agents` array", {
      code: "invalid_squad",
    });
  }
  if (options.process !== undefined && options.process !== "sequential") {
    throw new ConfigurationError(
      `createSquad only supports process "sequential"; for manager→worker delegation use subagents or @theokit/sdk-handoff`,
      { code: "squad_process_unsupported" },
    );
  }

  return {
    run: async (input: unknown, runOptions?: SquadRunOptions): Promise<SquadRun> => {
      const owned: Array<{ agent: SDKAgent; index: number }> = [];
      const ctrl = new AbortController();
      let timedOut = false;
      const outer = runOptions?.signal;
      const onOuterAbort = (): void => ctrl.abort(outer?.reason);
      if (outer?.aborted) onOuterAbort();
      else outer?.addEventListener("abort", onOuterAbort, { once: true });
      const timer = startTimer(ctrl, runOptions?.timeoutMs, () => {
        timedOut = true;
      });
      try {
        const pipeline = await buildPipeline(agents, options.name, {
          signal: ctrl.signal,
          onMember: (agent, index, created) => {
            if (created || options.ownsMembers === true) owned.push({ agent, index });
          },
          onLate: (agent, index) => disposeMembers([{ agent, index }], options.onDisposeError),
        });
        if (pipeline === undefined) {
          return {
            result: undefined,
            status: "cancelled",
            steps: [],
            ...(timedOut ? { timedOut } : {}),
          };
        }
        const run = await pipeline.run(input, { signal: ctrl.signal });
        return {
          result: run.output,
          status: run.status,
          steps: run.stepResults,
          ...(timedOut && run.status === "cancelled" ? { timedOut: true } : {}),
        };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        outer?.removeEventListener("abort", onOuterAbort);
        await disposeMembers(owned, options.onDisposeError);
      }
    },
  };
}

/** Aborts `ctrl` after `ms` (unless it already aborted) and reports the timeout through `onTimeout`. */
function startTimer(
  ctrl: AbortController,
  ms: number | undefined,
  onTimeout: () => void,
): ReturnType<typeof setTimeout> | undefined {
  if (ms === undefined) return undefined;
  return setTimeout(() => {
    if (ctrl.signal.aborted) return; // the caller's signal won the race
    onTimeout();
    ctrl.abort(new Error("Squad run timed out"));
  }, ms);
}

/** Disposes members with `Promise.allSettled`; a failure is reported, never thrown. */
async function disposeMembers(
  owned: ReadonlyArray<{ agent: SDKAgent; index: number }>,
  onError: ((error: unknown, memberIndex: number) => void) | undefined,
): Promise<void> {
  const settled = await Promise.allSettled(owned.map(async ({ agent }) => agent.dispose()));
  settled.forEach((r, i) => {
    if (r.status !== "rejected") return;
    const index = owned[i]?.index ?? i;
    try {
      if (onError !== undefined) onError(r.reason, index);
      else diagFailure(`squad: failed to dispose member ${String(index)}: ${String(r.reason)}`);
    } catch {
      // A throwing error handler must not replace the run result.
    }
  });
}

/** Materializes a member unless the run aborts first; an agent that arrives late is handed to `onLate`. */
async function materializeUntilAborted(
  def: AgentDefinition,
  index: number,
  hooks: { signal: AbortSignal; onLate: (agent: SDKAgent, index: number) => Promise<void> },
): Promise<SDKAgent | undefined> {
  const pending = materialize(def, index);
  const agent = await untilAborted(pending, hooks.signal);
  if (agent === undefined)
    void pending.then((late) => hooks.onLate(late, index)).catch(() => undefined);
  return agent;
}

/** Resolves with `pending`'s value, or `undefined` as soon as `signal` aborts. */
function untilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  return Promise.race([
    pending,
    new Promise<undefined>((resolve) => {
      if (signal.aborted) resolve(undefined);
      else signal.addEventListener("abort", () => resolve(undefined), { once: true });
    }),
  ]);
}

/**
 * Builds the sequential pipeline, materializing the members that are still raw data.
 *
 * Extracted from `run` because the cognitive-complexity gate rejected the combined function — and because
 * "building the pipeline" and "running it and translating the result" are two responsibilities that were only
 * together by proximity.
 */
async function buildPipeline(
  agents: ReadonlyArray<SDKAgent | AgentDefinition>,
  name: string | undefined,
  hooks: {
    signal: AbortSignal;
    onMember: (agent: SDKAgent, index: number, created: boolean) => void;
    onLate: (agent: SDKAgent, index: number) => Promise<void>;
  },
): Promise<ReturnType<ReturnType<typeof Workflow.create>["commit"]> | undefined> {
  const { onMember } = hooks;
  // Compose Workflow + agentStep — identity threading: each agent's prompt is the previous agent's
  // output (the run input for the first agent).
  let builder = Workflow.create({ name: name ?? "squad" });
  for (let i = 0; i < agents.length; i++) {
    const member = agents[i];
    if (member === undefined) continue;
    // M81 — materializes at RUN time, not at construction: `Squad.create` is synchronous and an
    // `AgentDefinition` only becomes an agent with an `await`. Deferring to here keeps construction cheap and
    // avoids requiring a resolved credential to assemble a team before the first run.
    const built = isBuiltAgent(member);
    const agent = built ? member : await materializeUntilAborted(member, i, hooks);
    if (agent === undefined) return undefined;
    onMember(agent, i, !built);
    // SE3 — the first agent receives the human input (no peer origin); every subsequent agent
    // receives its predecessor's output, so its turn carries `{ kind: "peer", from: "agent-<i-1>" }`.
    const opts = i > 0 ? { origin: { kind: "peer" as const, from: `agent-${i - 1}` } } : undefined;
    builder = builder.then(agentStep(`agent-${i}`, agent, (prev) => String(prev), opts));
  }
  return builder.commit();
}

/** SE36 — `Squad.create` replaces `createSquad` (ADR 0015). Merges with the `Squad` interface. @public */
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: SE36 namespace class merges with the `Squad` instance interface (ADR 0015) — intentional; `create()` returns the interface type, `new` is blocked by the private ctor.
export class Squad {
  private constructor() {}
  static create(options: SquadOptions): Squad {
    return createSquad(options);
  }
}
