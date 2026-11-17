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
import { redactSecrets } from "./internal/security/redact.js";
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
  /** Dispose the SDKAgent members passed in after each run. Default false. */
  ownsMembers?: boolean;
  /** Receives a member disposal failure. Default: diagFailure. Disposal failures never fail the run. */
  onDisposeError?: (error: unknown, memberIndex: number) => void;
}

/**
 * Options for {@link Squad.run}.
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
  /** True when the run was cancelled because `timeoutMs` expired. */
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
async function materialize(
  def: AgentDefinition,
  index: number,
  signal?: AbortSignal,
): Promise<SDKAgent> {
  const { Agent } = await import("./agent.js");
  // The import is asynchronous: re-check immediately before creating, so an abort during it creates nothing.
  if (signal?.aborted) throw new SquadAborted("aborted before member was created");
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
    run: (input: unknown, runOptions?: SquadRunOptions): Promise<SquadRun> =>
      runSquad(options, input, runOptions),
  };
}

/** Joins the caller's signal with a `timeoutMs` timer. `timedOut()` reports whether the timer won. */
function withTimeout(runOptions: SquadRunOptions | undefined): {
  signal: AbortSignal | undefined;
  timedOut: () => boolean;
  clear: () => void;
} {
  const ctrl = new AbortController();
  const external = runOptions?.signal;
  let fired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onExternal = (): void => {
    // The external abort won: the timer must not later claim the run as timed out.
    if (timer !== undefined) clearTimeout(timer);
    ctrl.abort(external?.reason);
  };
  if (external?.aborted) ctrl.abort(external.reason);
  else external?.addEventListener("abort", onExternal, { once: true });
  const ms = runOptions?.timeoutMs;
  if (ms !== undefined && !ctrl.signal.aborted) {
    timer = setTimeout(() => {
      if (ctrl.signal.aborted) return;
      fired = true;
      ctrl.abort(new Error(`Squad run timed out after ${String(ms)}ms`));
    }, ms);
  }
  const needed = external !== undefined || ms !== undefined;
  return {
    signal: needed ? ctrl.signal : undefined,
    timedOut: () => fired,
    clear: () => {
      if (timer !== undefined) clearTimeout(timer);
      external?.removeEventListener("abort", onExternal);
    },
  };
}

/** Disposes with `allSettled`; a failure goes to `onDisposeError` and never reaches the run result. */
async function disposeMembers(
  owned: ReadonlyArray<{ agent: SDKAgent; index: number }>,
  onError: SquadOptions["onDisposeError"],
): Promise<void> {
  const settled = await Promise.allSettled(
    owned.map((m) => Promise.resolve().then(() => m.agent.dispose())),
  );
  settled.forEach((r, k) => {
    if (r.status !== "rejected") return;
    const index = owned[k]?.index ?? -1;
    try {
      if (onError !== undefined) onError(r.reason, index);
      else {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        diagFailure(redactSecrets(`squad member ${String(index)} failed to dispose: ${msg}`));
      }
    } catch {
      // a throwing error handler must not fail the run
    }
  });
}

async function runSquad(
  options: SquadOptions,
  input: unknown,
  runOptions: SquadRunOptions | undefined,
): Promise<SquadRun> {
  const timer = withTimeout(runOptions);
  const owned: Array<{ agent: SDKAgent; index: number }> = [];
  try {
    const pipeline = await buildPipeline(
      options.agents,
      options.name,
      owned,
      options.ownsMembers === true,
      timer.signal,
      (agent, index) => {
        void disposeMembers([{ agent, index }], options.onDisposeError);
      },
    );
    const run = await pipeline.run(input, timer.signal ? { signal: timer.signal } : undefined);
    return {
      result: run.output,
      status: run.status,
      steps: run.stepResults,
      ...(timer.timedOut() && run.status === "cancelled" ? { timedOut: true } : {}),
    };
  } catch (err) {
    if (err instanceof SquadAborted) {
      return {
        result: undefined,
        status: "cancelled",
        steps: [],
        ...(timer.timedOut() ? { timedOut: true } : {}),
      };
    }
    throw err;
  } finally {
    timer.clear();
    await disposeMembers(owned, options.onDisposeError);
  }
}

/** Raised by `buildPipeline` when the signal aborted before every member was built. */
class SquadAborted extends Error {}

async function resolveMember(
  member: SDKAgent | AgentDefinition,
  index: number,
  owned: Array<{ agent: SDKAgent; index: number }>,
  signal: AbortSignal | undefined,
  onLate: (agent: SDKAgent, index: number) => void,
): Promise<SDKAgent> {
  if (isBuiltAgent(member)) return member;
  const creation = materialize(member, index, signal);
  if (signal === undefined) {
    const agent = await creation;
    owned.push({ agent, index });
    return agent;
  }
  // Race creation against the abort: a stalled `Agent.create` must not hold the run past its signal.
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<"aborted">((resolve) => {
    onAbort = () => resolve("aborted");
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const winner = await Promise.race([creation, aborted]);
    if (winner === "aborted") {
      // An agent that arrives after cancellation is disposed, never leaked.
      creation.then(
        (late) => onLate(late, index),
        () => {},
      );
      throw new SquadAborted("aborted while member was being created");
    }
    owned.push({ agent: winner, index });
    return winner;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function registerPassedIn(
  agents: ReadonlyArray<SDKAgent | AgentDefinition>,
  owned: Array<{ agent: SDKAgent; index: number }>,
): void {
  agents.forEach((m, index) => {
    if (isBuiltAgent(m)) owned.push({ agent: m, index });
  });
}

/**
 * Builds the sequential pipeline, materializing the members that are still raw data. Members to dispose
 * are pushed onto `owned`: materialized agents always, passed-in agents only with `ownsMembers`, and the
 * latter are registered before any definition is materialized.
 */
async function buildPipeline(
  agents: ReadonlyArray<SDKAgent | AgentDefinition>,
  name: string | undefined,
  owned: Array<{ agent: SDKAgent; index: number }>,
  ownsMembers: boolean,
  signal: AbortSignal | undefined,
  onLate: (agent: SDKAgent, index: number) => void,
): Promise<ReturnType<ReturnType<typeof Workflow.create>["commit"]>> {
  if (ownsMembers) registerPassedIn(agents, owned);
  // Compose Workflow + agentStep — identity threading: each agent's prompt is the previous agent's
  // output (the run input for the first agent).
  let builder = Workflow.create({ name: name ?? "squad" });
  for (let i = 0; i < agents.length; i++) {
    const member = agents[i];
    if (member === undefined) continue;
    if (signal?.aborted) throw new SquadAborted("aborted before member was built");
    // M81 — materializes at RUN time, not at construction (`Squad.create` is synchronous).
    const agent = await resolveMember(member, i, owned, signal, onLate);
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
