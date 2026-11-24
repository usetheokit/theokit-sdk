/**
 * Subagent delegation — declarative child agent invocable as a tool.
 *
 * Per ADR D2: `defineSubAgent(spec)` returns a `CustomTool` that, when
 * invoked by the LLM, creates a child agent and sends the input as a
 * message. EC-2: delegation depth is tracked across the RUN (#364) — each
 * delegation publishes its depth on the async scope its child executes in, so a
 * subagent that delegates to a subagent is bounded by `maxDelegationDepth`
 * without the caller threading a counter by hand.
 *
 * SE10 — the handler forwards the parent run's `AbortSignal` to the child.
 * SE11 — optional `onDelegationStart` / `onDelegationComplete` lifecycle hooks
 * let the caller reject, rewrite, observe, or annotate a delegation.
 *
 * @public
 */

import { z } from "zod";
import { TheokitAgentError } from "../errors.js";
import {
  currentDelegationDepth,
  withDelegationDepth,
} from "../internal/concurrency/delegation-depth.js";
import {
  currentInheritedSubAgentCredentials,
  type InheritedCredentials,
} from "../internal/concurrency/subagent-credentials.js";
import { getAgentFacade } from "../internal/runtime/registry/agent-factory-registry.js";
import type {
  AgentDefinition,
  AgentOptions,
  BuiltinToolName,
  CustomTool,
  ToolContextMessage,
} from "../types/agent.js";
import type { ModelSelection } from "../types/agent-prims.js";
import type { Run } from "../types/run.js";

/** Arguments passed to {@link SubAgentSpec.messageFilter} (SE12). */
export interface MessageFilterArgs {
  /** The supervisor transcript (read-only text projection) available to this delegation. */
  messages: readonly ToolContextMessage[];
  /** The prompt about to be delegated (after any `onDelegationStart` rewrite). */
  input: string;
  /** The subagent's name. */
  name: string;
}

/** Context passed to {@link SubAgentSpec.onDelegationStart} before the child runs. */
export interface DelegationStartContext {
  input: string;
  name: string;
  /**
   * SE15 — 1-based count of times THIS subagent tool has been invoked (a
   * per-`defineSubAgent`-instance counter). Incremented before this hook runs;
   * a rejected delegation still counts. Enables reject-after-N patterns.
   */
  iteration: number;
}

/**
 * Decision returned from {@link SubAgentSpec.onDelegationStart}. Discriminated on
 * `proceed` so a rejection (`proceed: false` + `rejectionReason`) and an approval
 * (`modifiedInput`) cannot be mixed into one nonsensical object.
 */
export type DelegationStartDecision =
  | { proceed: false; rejectionReason?: string }
  | {
      proceed?: true;
      modifiedInput?: string;
      /** SE13 — cap the child's iteration count (forwarded as `SendOptions.maxIterations`). */
      modifiedMaxSteps?: number;
    };

/** Context passed to {@link SubAgentSpec.onDelegationComplete} after the child settles. */
export interface DelegationCompleteContext {
  input: string;
  name: string;
  /** The child's text result (present on success). */
  result?: string;
  /** The error the child threw (present on failure); the error is still re-thrown. */
  error?: unknown;
  /** SE15 — the same 1-based iteration this delegation's `onDelegationStart` saw. */
  iteration: number;
}

/**
 * The return of a delegation hook: a decision, a promise of one, or nothing —
 * `void` lets a side-effect-only callback (`(ctx) => { log(ctx) }`) type-check,
 * which is the common case (mirrors a peer framework's `async ctx => { ... }` hooks).
 */
// biome-ignore lint/suspicious/noConfusingVoidType: `void` is the idiomatic return for an optional-return callback; the rule false-positives on callback return unions.
type DelegationHookResult<T> = T | void | Promise<T | void>;

/** Decision returned from {@link SubAgentSpec.onDelegationComplete}. */
export interface DelegationCompleteDecision {
  /** Appended to the child's result string. */
  feedback?: string;
}

/**
 * The declaration of a delegating child agent, handed to `SubAgent.create(spec)`.
 *
 * `name`, `description` and `instructions` are the only required fields: the first
 * two become the tool the supervisor's model sees, the third becomes the child's
 * system prompt. Everything else narrows what the child inherits.
 *
 *   const research = SubAgent.create({
 *     name: "research",
 *     description: "Look a fact up",
 *     instructions: "You answer with one sentence.",
 *   });
 *   const agent = await Agent.create({ tools: [research] });
 *
 * The tool's own input schema is fixed — one required string property, `input`.
 * It is not derived from this spec and cannot be widened here.
 *
 * What the child inherits from the parent AT DISPATCH TIME, not from this object:
 * the API key, the model (unless `model` is set), the parent's plugins, and the
 * parent's sandbox posture (unless `sandbox` is set). An absent `sandbox` inherits;
 * an explicit `sandbox: false` turns confinement OFF for a child of a confined
 * parent, which is not the same thing.
 *
 * How it fails: the child's failure is re-thrown to the supervisor as a tool error
 * — a run ending in `status: "error"` becomes
 * `subagent "<name>" run failed: <cause>`. `onDelegationStart` and `messageFilter`
 * propagate their own throws; only a throw from `onDelegationComplete` ON THE
 * ERROR PATH is suppressed, so it cannot mask the real cause.
 *
 * Traps:
 *  - `model` as a bare string drops reasoning parameters. Pass the
 *    {@link ModelSelection} object form when the child needs `params`.
 *  - `maxDelegationDepth` (default 3) bounds the delegation CHAIN, counted at
 *    dispatch across the run (#364) — the depth is not something you thread. The
 *    `parentDepth` argument of `SubAgent.create` still offsets it, for a supervisor
 *    that wants a lower ceiling than the chain it sits in.
 *  - Context isolation is the DEFAULT. Without `messageFilter` the child sees only
 *    the delegated string; without `includeToolResults` the supervisor gets only
 *    the child's final text.
 */
export interface SubAgentSpec {
  name: string;
  description: string;
  instructions: string;
  /**
   * A bare id string (back-compat) OR a full {@link ModelSelection} carrying
   * `params` (e.g. `[{ id: "thinking", value: "low" }]` for reasoning effort). The
   * object form is required for per-subagent reasoning effort to survive to the child
   * — the pre-M33 path took only `.id` and dropped params.
   */
  model?: string | ModelSelection;
  tools?: CustomTool[];
  /** Per-subagent shell sandbox toggle (M33). `true` ⇒ child `local.sandboxOptions.enabled`. */
  sandbox?: boolean;
  /**
   * #580 — builtin tools this role removes from its child's catalog, UNIONED with whatever the
   * parent already withheld.
   *
   * A role declared read-only in prose is not read-only: a `shell` tool is always registered on a
   * local agent, including when `tools: []` is passed, so withholding is the only mechanism that
   * removes it — and until #580 a spec could not ask for it and a parent's withholding did not
   * survive delegation either.
   *
   * ## Union, not override — and this is the one field here that works that way
   *
   * `model` and `sandbox` let the role's own value WIN, including `sandbox: false` turning
   * confinement off for a child of a confined parent. That asymmetry is deliberate: a posture is
   * declared, whereas withholding removes a capability from the catalog. Letting a role override a
   * withholding would let a child recover a tool its parent revoked, which is the defect #580
   * reports — so a child may only ever ADD to the set.
   */
  withheldBuiltinTools?: readonly BuiltinToolName[];
  /**
   * Maximum length of the delegation CHAIN rooted at this tool, counted at dispatch
   * (default 3). Depth 1 is this subagent; a subagent it delegates to is depth 2.
   * Exceeding it throws {@link MaxDelegationDepthError} from the tool handler.
   */
  maxDelegationDepth?: number;
  /**
   * SE11 — called before the supervisor delegates. Return `{ proceed: false }`
   * to reject (the child never runs and `rejectionReason` becomes the tool
   * result), or `{ modifiedInput }` to rewrite the delegated prompt. A throwing
   * hook surfaces (never silently swallowed).
   */
  onDelegationStart?: (
    ctx: DelegationStartContext,
  ) => DelegationHookResult<DelegationStartDecision>;
  /**
   * SE11 — called after the delegation settles. On success `ctx.result` is set
   * and an optional `{ feedback }` is appended to it. On failure `ctx.error` is
   * set and the original error is ALWAYS re-thrown after this hook runs — a throw
   * from this hook on the error path is suppressed so it cannot mask the
   * delegation's real failure (on the success path a throw does propagate).
   */
  onDelegationComplete?: (
    ctx: DelegationCompleteContext,
  ) => DelegationHookResult<DelegationCompleteDecision>;
  /**
   * SE12 — opt-in parent-context forwarding. When set, the supervisor transcript
   * (`ctx.messages`, a read-only text projection) is passed to this filter and the
   * returned subset is forwarded to the child as a role-tagged context preamble
   * prepended to the delegated input. When ABSENT the child runs input-only —
   * memory isolation stays the default. A filter returning `[]` forwards nothing.
   * A throwing filter propagates (fail-fast, never swallowed — same contract as
   * `onDelegationStart`); the delegation surfaces as a tool error.
   */
  messageFilter?: (args: MessageFilterArgs) => readonly ToolContextMessage[];
  /**
   * SE14 — opt-in subagent result-context control. When `true`, the child's
   * completed tool-call results (name + result) are appended to the delegation
   * payload returned to the supervisor, inside a `<subagent-tool-results>` block.
   * When absent/`false` the delegation returns the child's final text only —
   * text-only stays the default (a peer framework's scoped posture). See ADR 0006.
   */
  includeToolResults?: boolean;
}

/**
 * Raised by `SubAgent.create(spec, parentDepth)` when `parentDepth + 1` exceeds
 * `spec.maxDelegationDepth` (default 3). Carries `currentDepth`, `maxDepth` and a
 * stable `code: "max_delegation_depth"`.
 *
 * Thrown from the subagent tool's handler when a delegation would exceed
 * `maxDelegationDepth` (default 3), so it surfaces as the tool call's failure —
 * catching it around the dispatching `agent.send()` works.
 *
 * Also thrown eagerly at TOOL-CONSTRUCTION time when a caller threads its own
 * `parentDepth` that is already past the limit; such a tool could never be
 * dispatched, so refusing to build it fails earlier and clearer.
 *
 * Before #364 the construction-time check was the ONLY one, against a depth
 * nothing in the SDK incremented — so under the documented `SubAgent.create(spec)`
 * call this error could not fire at all and nested delegation was unbounded. The
 * chain length now travels with the run (`internal/runtime/concurrency/delegation-depth.ts`),
 * and a caller-threaded `parentDepth` still adds to it.
 */
export class MaxDelegationDepthError extends TheokitAgentError {
  override readonly name = "MaxDelegationDepthError";
  override readonly code = "max_delegation_depth" as const;
  constructor(
    public readonly currentDepth: number,
    public readonly maxDepth: number,
  ) {
    // Not retryable: the depth is a property of the call graph, and it is the same on a retry.
    super(`Max delegation depth ${maxDepth} exceeded (current: ${currentDepth})`, {
      code: "max_delegation_depth",
      isRetryable: false,
    });
  }
}

/**
 * Run the `onDelegationStart` hook; returns either a rejection or the (possibly
 * rewritten) input plus the optional SE13 `maxSteps` cap.
 */
async function applyDelegationStart(
  spec: SubAgentSpec,
  input: string,
  iteration: number,
): Promise<{ reject: string } | { input: string; maxSteps?: number }> {
  if (spec.onDelegationStart === undefined) return { input };
  const decision = await spec.onDelegationStart({ input, name: spec.name, iteration });
  if (decision === undefined) return { input };
  if (decision.proceed === false)
    return { reject: decision.rejectionReason ?? "(delegation rejected)" };
  return {
    input: decision.modifiedInput ?? input,
    ...(decision.modifiedMaxSteps !== undefined ? { maxSteps: decision.modifiedMaxSteps } : {}),
  };
}

/**
 * SE14 — replay the child run's stream (a safe post-`wait()` idiom — the run buffers
 * events, `stream()` replays them) and collect every completed tool-call result into
 * a delimited block. Returns `""` when the child ran no completed tool calls. See ADR 0006.
 */
async function collectChildToolResults(run: Run): Promise<string> {
  const lines: string[] = [];
  for await (const event of run.stream()) {
    if (event.type === "tool_call" && event.status !== "running") {
      const rendered =
        typeof event.result === "string" ? event.result : JSON.stringify(event.result ?? null);
      lines.push(`${event.name}: ${rendered}`);
    }
  }
  if (lines.length === 0) return "";
  return `\n\n<subagent-tool-results>\n${lines.join("\n")}\n</subagent-tool-results>`;
}

/**
 * The child's `local` slice, accumulated ONCE from all three contributors — or `undefined` when the
 * parent declared none of them, so the pre-#578 shape (no `local` key at all) is preserved.
 *
 * #578 — this exists as a function rather than three spreads in the return, and the reason is a
 * hazard rather than tidiness. `local` is a single object: the old code wrote it whole from the
 * sandbox posture alone, so adding a second `...{ local: … }` spread beside it would have silently
 * DROPPED that posture — turning a missing-capability bug into a default-open one, which is the
 * wrong direction to trade. One accumulator makes that collision impossible to reintroduce.
 *
 * The configuration surfaces are the parent's RESOLVED values. Inheriting cannot widen: the child
 * receives what the parent already resolved and runs in the parent's cwd, so it reads no directory
 * the parent could not. Without this, a parent declaring `compatSources: ["claude-code"]` saw
 * `.claude/agents/` and its child did not — a team could delegate TO a role by name while the child
 * could not resolve the rest of the team.
 */
function buildChildLocalOptions(
  sandbox: boolean | undefined,
  inherited: InheritedCredentials | undefined,
): AgentOptions["local"] | undefined {
  const local: NonNullable<AgentOptions["local"]> = {};
  if (sandbox !== undefined) local.sandboxOptions = { enabled: sandbox };
  if (inherited?.settingSources !== undefined) local.settingSources = [...inherited.settingSources];
  if (inherited?.compatSources !== undefined) local.compatSources = [...inherited.compatSources];
  return Object.keys(local).length > 0 ? local : undefined;
}

/**
 * The builtins withheld from the child: the UNION of the parent's set and the role's own — or
 * `undefined` when neither withheld anything.
 *
 * #580 — union rather than override, and that is the security property rather than a preference.
 * The role's own value wins for `model` and for `sandbox`; copying that here would let a child
 * un-withhold what its parent revoked, which is the defect being fixed, reintroduced by its own fix.
 * **A restriction may be tightened by a child and never loosened.** So `withheldBuiltinTools: []` on
 * a role subtracts nothing — it is an empty contribution to a union, not a reset.
 */
function buildChildWithheldBuiltins(
  spec: SubAgentSpec,
  inherited: InheritedCredentials | undefined,
): readonly BuiltinToolName[] | undefined {
  const own = spec.withheldBuiltinTools;
  const parent = inherited?.withheldBuiltinTools;
  if (own === undefined && parent === undefined) return undefined;
  return [...new Set([...(parent ?? []), ...(own ?? [])])];
}

/**
 * Build the child agent's `Agent.create` options: the child inherits the parent's
 * apiKey (else `Agent.create` throws "Missing API key"), its model (unless the spec
 * overrides it), — #55 — the parent's plugins (permission gate/guards) so the
 * child's inner tool calls run under the same policy, and — #578 — the configuration
 * surfaces the parent was declared to read (see {@link buildChildLocalOptions}).
 */
export function buildChildCreateOptions(
  spec: SubAgentSpec,
  inherited: InheritedCredentials | undefined,
): AgentOptions {
  // M33 — carry the WHOLE model (a bare id becomes `{ id }`; a ModelSelection with
  // `params` keeps its reasoning effort). The pre-M33 path wrapped `spec.model` as
  // `{ id: spec.model }`, which only worked because spec.model was a string and
  // silently dropped reasoning params.
  const model: string | ModelSelection | undefined =
    spec.model !== undefined
      ? typeof spec.model === "string"
        ? { id: spec.model }
        : spec.model
      : inherited?.model;
  // M33 — the role's own `sandbox` wins; when it omits the field, inherit the parent's posture. A role's
  // explicit `sandbox: false` therefore confines-OFF a child of a sandboxed parent (distinct from absent).
  const sandbox = spec.sandbox ?? inherited?.sandbox;
  const local = buildChildLocalOptions(sandbox, inherited);
  const withheld = buildChildWithheldBuiltins(spec, inherited);
  return {
    ...(inherited?.apiKey !== undefined ? { apiKey: inherited.apiKey } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(local !== undefined ? { local } : {}),
    ...(withheld !== undefined ? { withheldBuiltinTools: withheld } : {}),
    ...(inherited?.plugins !== undefined ? { plugins: inherited.plugins } : {}),
    systemPrompt: spec.instructions,
    tools: spec.tools ?? [],
  };
}

/**
 * Create the transient child agent and send the input, composing every forwarded
 * `SendOptions` onto ONE `send` call — SE10 `signal` + SE13 `maxIterations`. Absent
 * every option ⇒ the pre-SE10 single-arg `send(input)` shape. SE14 — when
 * `includeToolResults` is set, append the child's completed tool results. Dispose in `finally`.
 */
async function runChildAgent(
  spec: SubAgentSpec,
  input: string,
  signal: AbortSignal | undefined,
  maxSteps: number | undefined,
  inherited: InheritedCredentials | undefined,
  depth: number,
): Promise<string> {
  // #364 — publish THIS delegation's depth for the whole child run. The child's loop, and every
  // tool it dispatches, runs inside this scope, so a nested subagent reads the real chain length
  // instead of the 0 every construction-time check saw.
  return withDelegationDepth(depth, () =>
    runChildAgentInScope(spec, input, signal, maxSteps, inherited),
  );
}

async function runChildAgentInScope(
  spec: SubAgentSpec,
  input: string,
  signal: AbortSignal | undefined,
  maxSteps: number | undefined,
  inherited: InheritedCredentials | undefined,
): Promise<string> {
  // SE45 cycle 3 — use the registered Agent facade via the DIP seam
  // (agent-factory-registry) instead of a dynamic `import("../agent.js")`.
  // This removes the last madge cycle (a2a/subagent -> agent -> ... -> real-local-run-tools
  // -> a2a/subagent): the facade registers itself at module-init via setAgentFacade,
  // so subagent depends only on the registry port, never on the facade module.
  const agent = await getAgentFacade().create(buildChildCreateOptions(spec, inherited));
  try {
    const sendOptions: {
      signal?: AbortSignal;
      maxIterations?: number;
      origin?: import("../types/run.js").MessageOrigin;
    } = {
      ...(signal !== undefined ? { signal } : {}),
      ...(maxSteps !== undefined ? { maxIterations: maxSteps } : {}),
      // SE3 — a delegated child's turn is initiated by the coordinating parent.
      origin: { kind: "coordinator" },
    };
    const run = await agent.send(input, sendOptions);
    const result = await run.wait();
    // Fail-fast, don't swallow (Rule 8): a child that ended in error must surface — otherwise a real
    // failure (e.g. `provider_unresolved`) is hidden behind "(no response)" and the parent loops on it.
    if (result.status === "error") {
      const cause = (result as { error?: { message?: string } }).error;
      throw new Error(
        `subagent "${spec.name}" run failed: ${cause?.message ?? "unknown error"}`,
        cause !== undefined ? { cause } : undefined,
      );
    }
    const text = result.result ?? "(no response)";
    // SE14 — text-only by default; opt-in appends the child's tool results.
    return spec.includeToolResults === true ? text + (await collectChildToolResults(run)) : text;
  } finally {
    agent.dispose();
  }
}

/**
 * Best-effort error-path notification: run `onDelegationComplete` with the child's
 * error so the caller can observe the failure. The observer's own throw (sync or
 * async) is suppressed here so it cannot mask the delegation's real error, which the
 * handler re-throws next.
 */
async function notifyDelegationError(
  spec: SubAgentSpec,
  input: string,
  error: unknown,
  iteration: number,
): Promise<void> {
  if (spec.onDelegationComplete === undefined) return;
  try {
    await spec.onDelegationComplete({ input, name: spec.name, error, iteration });
  } catch {
    // Subordinate to `error`; the child's real cause wins.
  }
}

/**
 * SE12 — apply `messageFilter` (if set) and prepend the filtered supervisor
 * transcript to the delegated input as a role-tagged context preamble. Absent
 * filter OR no messages OR an empty filtered subset ⇒ the original input
 * (isolation-by-default preserved).
 */
function applyMessageFilter(
  spec: SubAgentSpec,
  input: string,
  messages: readonly ToolContextMessage[] | undefined,
): string {
  if (spec.messageFilter === undefined || messages === undefined) return input;
  const filtered = spec.messageFilter({ messages, input, name: spec.name });
  if (filtered.length === 0) return input;
  const preamble = filtered.map((m) => `${m.role}: ${m.content}`).join("\n");
  return `Prior conversation:\n${preamble}\n\nTask:\n${input}`;
}

/** Run the success-path `onDelegationComplete` hook; appends its `feedback` to the result. */
async function applyDelegationComplete(
  spec: SubAgentSpec,
  input: string,
  result: string,
  iteration: number,
): Promise<string> {
  if (spec.onDelegationComplete === undefined) return result;
  const completion = await spec.onDelegationComplete({ input, name: spec.name, result, iteration });
  return completion?.feedback !== undefined ? result + completion.feedback : result;
}

function defineSubAgent(spec: SubAgentSpec, _parentDepth = 0): CustomTool {
  const maxDepth = spec.maxDelegationDepth ?? 3;

  // A caller that threads its own depth still gets the eager failure it always got: a spec that is
  // already too deep to ever be dispatchable is worth refusing at construction. What this check
  // CANNOT see is the runtime chain — constructing a tool says nothing about how deep it will later
  // be invoked — which is why the guard that actually bounds recursion lives at dispatch (#364).
  if (_parentDepth + 1 > maxDepth) {
    throw new MaxDelegationDepthError(_parentDepth + 1, maxDepth);
  }

  // Zod for RUNTIME validation of the tool_use input …
  const inputZod = z.object({
    input: z.string().describe("Task for the subagent"),
  });
  // … and a real Draft-7 JSON Schema for the LLM. `CustomTool.inputSchema` is sent
  // to the model verbatim; a raw Zod object would serialize to garbage, so the
  // model emits malformed input that fails `inputZod.parse` and the delegation
  // never runs (the previous bug — the schema and the validator are now distinct).
  const inputSchema: Record<string, unknown> = {
    type: "object",
    properties: {
      input: { type: "string", description: "Task for the subagent" },
    },
    required: ["input"],
    additionalProperties: false,
  };

  // SE15 — per-instance delegation counter, surfaced as `iteration` on the hook
  // contexts. Incremented once per handler invocation before onDelegationStart.
  let iteration = 0;

  const tool: CustomTool = {
    name: spec.name,
    description: spec.description,
    inputSchema,
    handler: async (
      rawInput: Record<string, unknown>,
      ctx?: {
        signal?: AbortSignal;
        context?: unknown;
        messages?: readonly ToolContextMessage[];
      },
    ): Promise<string> => {
      const { input: parsed } = inputZod.parse(rawInput);
      // theokit#148 — read the parent's credentials from the RUN's async scope, at dispatch time.
      // They used to be stashed on this tool object by the runtime, which meant any layer that
      // rebuilt the object (e.g. `@theokit/agents`' `toCompiledTool`) silently dropped them and the
      // child failed with `provider_unresolved`. The scope travels with the call, so nothing about
      // the object's shape matters — and two concurrent runs sharing one tool each read their own.
      const inherited = currentInheritedSubAgentCredentials();
      // #364 — the real bound. `currentDelegationDepth()` is the length of the chain that led here,
      // published by each ancestor's `runChildAgent`; a caller-threaded `_parentDepth` still adds to
      // it, so the pre-#364 hand-threaded behaviour is unchanged when the ambient depth is 0.
      const currentDepth = _parentDepth + currentDelegationDepth() + 1;
      if (currentDepth > maxDepth) {
        throw new MaxDelegationDepthError(currentDepth, maxDepth);
      }
      iteration += 1; // SE15 — before onDelegationStart; a rejected delegation still counts.
      // Pin THIS invocation's iteration before any await so a concurrent invocation
      // bumping the shared counter cannot change the value onDelegationComplete /
      // notifyDelegationError observe — they see the same iteration onDelegationStart did.
      const capturedIteration = iteration;

      const start = await applyDelegationStart(spec, parsed, capturedIteration);
      if ("reject" in start) return start.reject;
      // SE12 — opt-in: forward the filtered supervisor transcript as a preamble.
      const input = applyMessageFilter(spec, start.input, ctx?.messages);

      let result: string;
      try {
        // SE13 — apply the optional onDelegationStart maxSteps cap on the child send.
        result = await runChildAgent(
          spec,
          input,
          ctx?.signal,
          start.maxSteps,
          inherited,
          currentDepth,
        );
      } catch (error) {
        // SE11 — notify the completion hook of the failure (best-effort observer),
        // then re-throw the ORIGINAL error (Rule 8: never swallow the delegation's
        // own failure).
        await notifyDelegationError(spec, input, error, capturedIteration);
        throw error;
      }
      return applyDelegationComplete(spec, input, result, capturedIteration);
    },
  };

  // theokit#148 — nothing is installed on the tool. The credentials arrive through the run's async
  // scope (see `internal/runtime/concurrency/subagent-credentials.ts`), so there is no extra
  // property for a normalizing layer to drop.
  return tool;
}

/** SE36 — `SubAgent.create` replaces `defineSubAgent` (ADR 0015). @public  *
 * `SubAgent.create` returns a **`CustomTool`** — the sub-agent is exposed to the
 * parent as a callable tool, not as a `SubAgent` instance.
 */
export class SubAgent {
  private constructor() {}
  static create(spec: SubAgentSpec, parentDepth = 0): CustomTool {
    return defineSubAgent(spec, parentDepth);
  }
}

/**
 * Convert a parent's declarative `agents` map ({@link AgentDefinition} per key)
 * into delegation tools for the LOCAL runtime — the counterpart of the
 * cloud/fixture subagent wiring. Each child inherits the parent's `apiKey`/model
 * from the CALL, not from the tool object: `inheritSubAgentCredentials` used to
 * attach them to the tool, and any layer that rebuilt that object dropped them —
 * including the SDK's own rebuild (theokit#148). Credentials now ride the
 * dispatch, so a rebuilt tool cannot lose them. `def.model` overrides the model
 * (`"inherit"` keeps the parent's), and `def.tools` scopes the child to that
 * subset of the parent's tools (absent → the parent's full toolset, per the
 * `AgentDefinition.tools` contract).
 *
 * M33 — per-subagent `model` (with reasoning `params`) and `sandbox` are now wired
 * into local delegation: each is carried onto the {@link SubAgentSpec} and applied to
 * the child in {@link buildChildCreateOptions}. `"inherit"` (or an absent field) keeps
 * the parent's value. Per-subagent `mcp` is rejected at load (see subagents-loader) —
 * resolving server names→config on the local path is a follow-up.
 *
 * @internal
 */
export function subAgentToolsFromDefinitions(
  agents: Record<string, AgentDefinition>,
  parentTools: readonly CustomTool[],
): CustomTool[] {
  return Object.entries(agents).map(([name, def]) => {
    const whitelist =
      Array.isArray(def.tools) && def.tools.length > 0 ? new Set(def.tools) : undefined;
    const childTools = whitelist ? parentTools.filter((t) => whitelist.has(t.name)) : parentTools;
    return defineSubAgent({
      name,
      description: def.description,
      instructions: def.prompt,
      // Carry the FULL ModelSelection (id + reasoning params), not just the id, so
      // per-subagent reasoning effort survives to buildChildCreateOptions.
      ...(def.model !== undefined && def.model !== "inherit" ? { model: def.model } : {}),
      ...(def.sandbox !== undefined ? { sandbox: def.sandbox } : {}),
      tools: [...childTools],
    });
  });
}
