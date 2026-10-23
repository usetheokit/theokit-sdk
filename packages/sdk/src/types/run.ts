/**
 * Owner: `internal/local-agent/` (8 of 34 importers). Derived from the import graph, not
 * declared — `tests/lint/types-name-their-owner.test.ts` re-derives it.
 *
 */
// T4.1 / D438 — import primitives from leaf to break the run<->agent cycle (#5).
import type { TheokitAgentError } from "../errors.js";
import type { CustomTool, ModelSelection, PermissionMode, RunOperation } from "./agent-prims.js";
import type { ConversationStep, ConversationTurn } from "./conversation.js";
import type { McpServerConfig } from "./mcp.js";
import type { SDKMessage } from "./messages.js";
import type { InteractionUpdate } from "./updates.js";
import type { CostBreakdown, TokenUsage } from "./usage.js";

// `RunOperation` lives in the `./agent-prims.ts` leaf so `errors.ts` can name it without importing
// this module, which imports `errors.ts` for `RunErrorDetail.cause` (a cycle madge refuses).
export type { RunOperation } from "./agent-prims.js";

/**
 * Options for the tool-result guard (spotlighting + PII redaction on tool
 * output). Contract type owned by `types/` (SE45 / D435) — the implementation
 * lives in `internal/agent-loop/tool-result-guard.ts`, which re-exports this.
 *
 * @public
 */
export interface ToolResultGuardOptions {
  /** Wrap tool-result content in explicit data boundaries (spotlighting). */
  delimit?: boolean;
  /** Redact common PII patterns (email, phone) in tool-result content. */
  redactPii?: boolean;
}

/**
 * Lifecycle status of a {@link Run}.
 *
 * @public
 */
export type RunStatus = "running" | "finished" | "error" | "cancelled";

/**
 * Git metadata attached to cloud runs.
 *
 * @public
 */
export interface RunGitInfo {
  branches: Array<{ repoUrl: string; branch?: string; prUrl?: string }>;
}

/**
 * SE3 — provenance of the turn that produced a run: WHO triggered it. Metadata-only —
 * it never changes routing or dispatch. Stamped in the multi-agent path (Squad / a2a /
 * handoff / background-delegation) and forwarded onto {@link RunResult.origin}, so
 * consumers can attribute/route turns by their trigger; discriminate on `kind`. Mirrors
 * the Anthropic Agent SDK's `origin` shape.
 *
 * Producers: `peer` (Squad step / a2a envelope), `coordinator` (subagent delegation) and
 * `auto-continuation` (the run-to-completion / stream-to-completion driver's continuation
 * rounds) are stamped BY the SDK. `human` and `task-notification` are positive markers a
 * HOST stamps (e.g. re-sending an agent after a background task completed).
 *
 * Encoding note (distinct from absence): an ABSENT origin (`undefined`) means the
 * provenance was NOT stamped — the default for a plain `agent.send()`. The explicit
 * `{ kind: "human" }` is a positive marker a HOST stamps to say "this turn is
 * definitely from a human" (e.g. to distinguish a real user message from an
 * un-attributed one in an audit UI). The two are not interchangeable: `undefined`
 * = unknown/unstamped; `{ kind: "human" }` = explicitly human. Consumers writing an
 * exhaustive `switch (origin?.kind)` therefore handle `undefined` (unstamped) and
 * `"human"` (explicit) as separate, meaningful cases.
 *
 * @public
 */
export type MessageOrigin =
  /** Explicitly a human-triggered turn — a positive marker a host stamps (NOT the
   *  same as an absent/unstamped origin, which is `undefined`). */
  | { readonly kind: "human" }
  /** Another agent (a Squad peer or an a2a sender) triggered this turn. */
  | { readonly kind: "peer"; readonly from: string }
  /** A background task's completion re-entered the agent as a follow-up turn. */
  | { readonly kind: "task-notification" }
  /** A delegating/handoff coordinator triggered this turn. `from` is the coordinator's
   *  id when known, omitted for an anonymous coordinator. */
  | { readonly kind: "coordinator"; readonly from?: string }
  /** The loop's continuation driver re-sent to continue truncated work. */
  | { readonly kind: "auto-continuation" };

/**
 * Terminal result of a {@link Run}.
 *
 * @public
 */
export interface RunResult {
  id: string;
  status: "finished" | "error" | "cancelled";
  result?: string;
  /**
   * SE24 — set when a guardrail processor called `abort()`. The run stops
   * (`status: "cancelled"`) and `tripwire` carries the blocking reason +
   * processor id. `undefined` on every non-guardrail outcome. A
   * `throwOnError: true` agent resolves normally on a tripwire (status is
   * `"cancelled"`, not `"error"`). On an OUTPUT block the model already ran, so
   * `usage`/`cost` survive (billing) while `result` is suppressed; an INPUT
   * block never reaches the model, so `usage` is absent.
   *
   * @public
   */
  tripwire?: import("./processors.js").ProcessorTripwire;
  model?: ModelSelection;
  durationMs?: number;
  git?: RunGitInfo;
  /**
   * SE3 — provenance forwarded from {@link SendOptions.origin}: who triggered
   * this turn (human / peer / task-notification / coordinator / auto-continuation).
   * `undefined` means the provenance was not stamped (a plain `agent.send()`).
   * Metadata-only — never affects routing.
   *
   * @public
   */
  origin?: MessageOrigin;
  /**
   * Structured error detail, populated when `status === "error"`. Surfaces
   * the diagnostic that emit-error-event pushes into the stream so callers
   * that don't drain `run.stream()` still get the cause via `run.wait()`.
   *
   * For successful runs (`status: "finished"`) this is undefined.
   *
   * @public
   */
  error?: RunErrorDetail;
  /**
   * Token usage observed for this run (ADR D376). Populated in every
   * status where ≥1 LLM call COMPLETED — including partial-failure
   * runs (EC-5). `undefined` when zero LLM calls executed (e.g. an
   * abort before send) and, for the same reason, when the only call was
   * cut mid-stream: the counts arrive with the provider's terminating
   * frame, which a severed connection never delivers. Such a run can
   * therefore return partial text (#371) with no usage to bill it
   * against — the tokens were generated and are not reported here.
   *
   * @public
   */
  usage?: TokenUsage;
  /**
   * Estimated/actual USD cost for this run (ADR D377). Always paired
   * with `usage` when populated. `cost.status` tells caller how to
   * trust the figure.
   *
   * @public
   */
  cost?: CostBreakdown;
  /**
   * M1-2: `true` when the run stopped because the agent loop hit its iteration
   * ceiling (`SendOptions.maxIterations` or the default of 8) while the model
   * still wanted to call tools — i.e. the work was silently truncated rather
   * than finished. `undefined`/absent on a clean finish. A continuation driver
   * (or a careful caller) inspects this to decide whether to send again.
   *
   * @public
   */
  stoppedAtIterationLimit?: boolean;
  /**
   * `true` when the run stopped because the **doom-loop guard** detected the model repeating
   * IDENTICAL tool calls (same name + same input) to the hard threshold — making no progress (e.g.
   * a tool that keeps failing and is retried unchanged). `undefined`/absent otherwise. Through the
   * continuation driver this surfaces as `terminal: "no_progress"` (a controlled stop, NOT a
   * truncation to re-send). Tune or disable via {@link SendOptions.doomLoop}.
   *
   * @public
   */
  stoppedByDoomLoop?: boolean;
  /**
   * SE34 — the per-send completion verdict, populated when
   * {@link SendOptions.completionCheck} was set AND the run finished. Absent on
   * non-finished runs and when no completion check was requested. Reuses the
   * shipped LLM-as-judge (same one `runUntil` drives). @public
   */
  completionCheck?: CompletionCheckResult;
}

/**
 * Doom-loop guard thresholds (see {@link SendOptions.doomLoop}). Both are counts of CONSECUTIVE
 * identical tool calls: `softThreshold` injects a one-time guidance nudge; `hardThreshold` stops.
 *
 * @public
 */
export interface DoomLoopThresholds {
  /** Consecutive-identical count at which a one-time guidance nudge is injected. Default 3. */
  softThreshold?: number;
  /** Consecutive-identical count at which the run stops (`no_progress`). Default 5. */
  hardThreshold?: number;
}

/**
 * Options for {@link SDKAgent.runToCompletion} (M1 Phase 3 — continuation driver).
 *
 * @public
 */
export interface RunToCompletionOptions {
  /**
   * Maximum number of continuation rounds (re-sends) before giving up with
   * `terminal: "step_limit"`. Default 5. A hard ceiling that prevents a
   * runaway loop when the model keeps truncating.
   */
  maxRounds?: number;
  /**
   * The short prompt re-sent after a truncated round to make the (stateful)
   * agent resume. Defaults to a generic "continue" instruction. The original
   * conversation is preserved by the agent's session, so this need not repeat
   * the task.
   */
  continuationPrompt?: string;
  /** Called once per truncated round that triggers a re-send (for metrics/logging). */
  onTruncated?: (event: { round: number }) => void | Promise<void>;
  /** Abort signal; checked between rounds — once aborted, no further round starts. */
  signal?: AbortSignal;
  /** Per-send options forwarded to each underlying `send()` (e.g. `maxIterations`). */
  sendOptions?: SendOptions;
}

/**
 * Result of {@link SDKAgent.runToCompletion}.
 *
 * @public
 */
export interface RunToCompletionResult {
  /**
   * Why the driver stopped:
   * - `"done"` — a round finished without truncating (the model is done).
   * - `"step_limit"` — `maxRounds` exhausted (or aborted) while still truncating.
   * - `"no_progress"` — two consecutive rounds produced empty output.
   */
  terminal: "done" | "step_limit" | "no_progress";
  /**
   * Index of the final round. Round 0 is the initial `send`; rounds ≥ 1 are
   * continuation re-sends. So `terminal: "done"` with `rounds: 0` means the
   * first send finished without truncating; `rounds: N` means N continuation
   * re-sends happened. For `step_limit`, `rounds` equals `maxRounds`.
   */
  rounds: number;
  /** The `RunResult` of the final round. */
  lastResult: RunResult;
  /** Token usage summed across all rounds; `undefined` when no round reported usage. */
  usage?: TokenUsage;
}

/**
 * Result of {@link SDKAgent.streamToCompletion} (V3-4 — the STREAMING continuation
 * driver). Same shape + terminal semantics as {@link RunToCompletionResult}; it is
 * the generator's RETURN value (read it via a manual `gen.next()` loop — a plain
 * `for await...of` consumes the yielded `SDKMessage`s but discards this return value).
 *
 * @public
 */
export type StreamToCompletionResult = RunToCompletionResult;

/**
 * Structured error attached to a {@link RunResult} when the underlying run
 * transitioned to `"error"` status. `message` is always present; `code` is
 * a stable identifier suitable for branching (e.g. `"llm_4xx"`,
 * `"tool_dispatch_failed"`, `"mcp_init_failed"`); `cause` is the typed
 * {@link TheokitAgentError} behind the failure, so `instanceof` works on it
 * directly (e.g. `result.error?.cause instanceof AuthenticationError`).
 *
 * A failure whose original cause was missing or not an SDK error carries an
 * `UnknownAgentError` with the same message and code, holding the original
 * value at its own `cause`.
 *
 * With `AgentOptions.throwOnError`, `run.wait()` rejects with this same `cause`
 * instead of resolving.
 *
 * @public
 */
export interface RunErrorDetail {
  message: string;
  code?: string;
  cause?: TheokitAgentError;
}

/**
 * Dimensions of an inline image attachment.
 *
 * @public
 */
export interface SDKImageDimension {
  width: number;
  height: number;
}

/**
 * Either a remote URL or inline base64 payload.
 *
 * @public
 */
export type SDKImage =
  | { url: string; dimension?: SDKImageDimension }
  | { data: string; mimeType: string; dimension?: SDKImageDimension };

/**
 * Structured form of `agent.send()`'s message argument. Use it to send images
 * alongside text.
 *
 * @public
 */
export interface SDKUserMessage {
  text: string;
  images?: SDKImage[];
}

/**
 * Per-send overrides and callbacks.
 *
 * ## Which options do I need?
 *
 * Twenty-one optional fields with genuinely different audiences, so most callers read all of them to
 * find their two. This table is the fix that was chosen; the alternative — nesting the groups under
 * `observe?` and `toolPolicy?` and carrying the flat keys as deprecated aliases for one major — would
 * have added surface to remove surface, and the harm here is the READING cost, not a representable
 * illegal state. There is no measured defect behind this grouping and no consumer census; the fields
 * and the audiences are what was measured.
 *
 * | If you are… | you want |
 * |---|---|
 * | rendering a live UI | `onDelta`, `onStep`, `onRunEvent` |
 * | applying a policy | `permissionMode`, `activeTools`, `toolChoice`, `toolResultGuard`, `perToolTimeoutMs` |
 * | running an eval or a harness | `maxIterations`, `completionCheck`, `doomLoop`, `signal` |
 * | orchestrating agents | `origin`, `task`, `context` |
 * | overriding this one send | `model`, `systemPrompt`, `tools`, `mcpServers`, `contextPaths`, `local` |
 *
 * Every field appears in exactly one row, and
 * `tests/lint/send-options-audience-table.test.ts` fails when one is added without a row — a table
 * that silently stops covering the type is worse than none, because a reader trusts it and stops
 * looking.
 *
 * @public
 */
export interface SendOptions {
  /**
   * Per-send model override. SE8 — accepts a bare-string id shorthand
   * (`"openai/gpt-4o-mini"`, normalized to `{ id }`) OR a {@link ModelSelection}
   * object (use the object form to pass `params`).
   */
  model?: string | ModelSelection;
  /**
   * SE3 — provenance of this turn (who triggered it). Stamped by the multi-agent
   * path (Squad peer, a2a sender, coordinator/handoff, background task-notification)
   * and forwarded onto {@link RunResult.origin}. Metadata-only — the value never
   * changes routing or dispatch. Omit to leave the turn un-attributed; a host may
   * pass `{ kind: "human" }` to positively mark a human turn.
   */
  origin?: MessageOrigin;
  /**
   * SE2 — opt-in typed runtime-EVENT sink. Receives out-of-band `RunEvent`s
   * (permission_denied, tool_progress, rate_limit, task_*, compact_boundary) for
   * observability, ADDITIVE to the `SDKMessage` content stream. Best-effort: a
   * throwing sink never breaks the run. Discriminate on `event.type`.
   */
  onRunEvent?: import("./run-events.js").RunEventSink;
  /**
   * Doom-loop guard config. The loop stops (with `terminal: "no_progress"`, `RunResult.stoppedByDoomLoop`)
   * when the model repeats IDENTICAL tool calls to the hard threshold. On by default with generous
   * thresholds (soft 3 / hard 5). Set `false` to disable, or an object to tune the thresholds.
   */
  doomLoop?: false | DoomLoopThresholds;
  /**
   * Per-call system prompt override. Wins over `AgentOptions.systemPrompt`.
   * String only — for dynamic resolvers, configure on `AgentOptions`. An
   * empty string is honoured (it explicitly clears the system context).
   */
  systemPrompt?: string;
  /** Fully replaces creation-time servers for this run (not merged). */
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * Per-call inline custom tools. Fully replaces `AgentOptions.tools` for
   * this run (not merged). Local runtime only — cloud agents reject any
   * non-empty per-call tools array with the same error code as creation
   * (`cloud_custom_tools_rejected`). Semantics:
   * - `undefined` → fall back to `AgentOptions.tools`
   * - `[]` → explicitly clear (no custom tools for this run)
   * - `[t1, t2]` → use exactly these tools for this run
   */
  tools?: CustomTool[];
  /**
   * The set of repo-relative file paths in scope for THIS send (local runtime).
   * Declares "which files am I working on" so path-scoped rule files
   * (`.theokit/rules/*.md` with `paths:`/`globs:`, and `.cursor/rules/*.mdc`
   * globs) activate when a pattern matches one of these paths. `alwaysApply`
   * rules load regardless. Omit ⇒ only unconditional rules load (the create-time
   * snapshot is untouched). Matching is glob-based (`**`, `*`, `?`).
   */
  contextPaths?: readonly string[];
  /**
   * SE1 — the permission mode for THIS run, threaded to a registered
   * `PermissionPlugin`'s pre-tool gate. Precedence: this per-send value wins over
   * `AgentOptions.permissionMode` (creation-time default). Modes: `default` (rules
   * decide; unmatched ⇒ fail-closed ask), `plan` (read-only — allow rules pass,
   * everything else denied), `acceptEdits` (auto-approve unmatched, honor explicit
   * ask rules), `bypass` / `bypassPermissions` (allow all except an explicit deny).
   * Absent ⇒ the plugin's own construction-time mode applies. Local runtime.
   */
  permissionMode?: PermissionMode;
  onStep?: (args: { step: ConversationStep }) => void | Promise<void>;
  onDelta?: (args: { update: InteractionUpdate }) => void | Promise<void>;
  /**
   * Per-call tool gate (OpenAI/OpenRouter `tool_choice`). `"none"` forces a text answer even when
   * the agent has tools registered — used by an agent loop to force a closing summary at its step
   * ceiling (a cached agent's tools cannot be un-registered, so the gate is per-send). `"required"`
   * forces a tool call; `"auto"` (or omitted) is the default. Local runtime; OpenAI-compat providers.
   */
  toolChoice?: "auto" | "none" | "required";
  /**
   * SE18 — per-send runtime tool subset (**local runtime only**; cloud agents
   * ignore it). When set, only tools whose name is in this list may be called for
   * this send; a call to any other registered tool is vetoed at dispatch (the same
   * `withToolWhitelist` path `Agent.fork`'s `allowedTools` uses — NOT
   * `PermissionEngine`). Composes with `toolChoice`: `activeTools` narrows the set,
   * `toolChoice` gates calling within it. Absent ⇒ the full toolset is available.
   *
   * Matching is EXACT against the tool's registered name — the same name the
   * dispatch sees after tool-name repair (mirrors `Agent.fork`'s `allowedTools`;
   * it is NOT lowercased for you, so a mixed-case registered tool needs its exact
   * registered name here). An empty list (`[]`) vetoes EVERY tool (fail-closed —
   * "restrict to the empty set"); pass `undefined` (or omit) for no restriction.
   * A subagent invoked within this send inherits the whitelist via async-context
   * propagation unless it declares its own tool scope.
   */
  activeTools?: string[];
  /** Local agents only. Expire a stuck active run before starting this message. */
  local?: { force?: boolean };
  /**
   * Optional `AbortSignal` propagated to memory adapter `pre_user_send`
   * hooks (EC-H). Note: the LLM HTTP call itself is NOT cancellable
   * mid-stream — same constraint as `Agent.batch` (ADR D140).
   *
   * @public
   */
  signal?: AbortSignal;
  /**
   * M7 — an opaque user `context` forwarded to every tool handler's `ctx.context`
   * for this run. Set shared config (e.g. `projectRoot`) once here instead of
   * baking it into each tool factory (mirrors a framework `experimental_context`,
   * a peer framework `RuntimeContext`, a peer SDK `RunContext`).
   *
   * @public
   */
  context?: unknown;
  /**
   * #58 — per-tool execution timeout in ms. Each tool call is bounded by this
   * deadline (merged with `signal`); a hung tool yields a typed timeout result
   * (exit 124) instead of wedging the run. Undefined = no per-tool timeout.
   *
   * @public
   */
  perToolTimeoutMs?: number;
  /**
   * #57 — opt-in tool-result content guard applied before tool output reaches
   * the LLM. `{ delimit: true }` frames untrusted tool output as data
   * (prompt-injection mitigation); `{ redactPii: true }` redacts email/phone.
   * Undefined = no guard.
   *
   * @public
   */
  toolResultGuard?: ToolResultGuardOptions;
  /**
   * Opt-in task wrapping (ADRs D363, D374). When truthy, the entire
   * run is registered as a `Task` in the SDK's observable registry —
   * caller can list / inspect / cancel / subscribe via the `Task`
   * namespace. Default behavior (no `task` option) is byte-identical
   * to v1.1 (no Task overhead).
   *
   * Accepts:
   * - `true` — auto-generate task id; no extra metadata.
   * - `{ id, meta }` — user-supplied id (D368 grammar enforced) and/or
   *   metadata attached to the handle's `meta` field.
   *
   * The work-fn `signal` is **merged** with `options.signal` (whichever
   * aborts first wins). Local agents only — CloudAgent throws
   * `UnsupportedTaskOperationError` (D370).
   *
   * @public
   */
  task?: true | { id?: string; meta?: Record<string, unknown> };
  /**
   * Per-send ceiling on the agent loop's tool-calling turns (M1-2). Raises (or
   * lowers) the default cap of 8 for this single send — useful when one heavy
   * task needs more rounds than the agent's default. Must be a positive
   * integer; invalid values throw `ConfigurationError` at the boundary. When
   * unset, the loop uses the default of 8.
   *
   * @public
   */
  maxIterations?: number;
  /**
   * SE34 — per-send completion check (`isTaskComplete`). After this single
   * `send()` reaches a terminal `finished` state, the shipped LLM-as-judge
   * scores the final reply against `criteria` and surfaces the verdict on
   * {@link RunResult.completionCheck} + a `completion_check` run-event. This is
   * the finer-grained, single-`send()` gate (contrast `runUntil`, which judges
   * the FULL response BETWEEN sends). Opt-in — absent ⇒ the send is byte-identical
   * to today (no extra judge call). Non-finished runs skip the check. The judge
   * runs when `wait()` is called on the returned `Run`; a stream-only consumer
   * must call `wait()` to trigger the verdict + the `completion_check` event.
   *
   * @public
   */
  completionCheck?: CompletionCheck;
}

/**
 * SE34 — the per-send completion criterion (see {@link SendOptions.completionCheck}).
 *
 * @public
 */
export interface CompletionCheck {
  /** What "complete" means for this send — fed to the judge as the goal. */
  criteria: string;
  /** Judge model identifier. Default `"openai/gpt-4o-mini"`. */
  judgeModel?: string;
  /** Override env for the judge auxiliary agent. Default `OPENROUTER_API_KEY`. */
  apiKey?: string;
}

/**
 * SE34 — the resolved per-send completion verdict (see {@link RunResult.completionCheck}).
 *
 * @public
 */
export interface CompletionCheckResult {
  /** `true` when the judge ruled the send's reply satisfies the criteria. */
  complete: boolean;
  /** The judge's stated reason. */
  reason: string;
  /** `true` when the judge output could not be parsed — fail-safe `complete: false`. */
  parseFailed: boolean;
}

/**
 * theokit#140 - one element of {@link Run.events}: either a structural SDK message or a live delta.
 *
 * A discriminated union rather than a widened `SDKMessage`, because a token delta is not a message
 * and pretending otherwise would force every consumer to guess which of the two it is holding.
 *
 * @public
 */
export type RunTimelineEvent =
  | {
      kind: "message";
      message: SDKMessage;
      /**
       * theokit#140 - `true` when this message's TEXT content already crossed the timeline as
       * `kind: "delta"` events. Absent when the question does not apply (no text to duplicate).
       *
       * Unifying the source fixed ordering and the `callId` namespace; it did NOT stop the same
       * text arriving twice, because the run's event log carries the complete assistant message and
       * the deltas are additional. Without this field a consumer has to infer the relation by
       * COMPARING TEXT - which is where the `callId`-namespace and timestamp-fallback bugs came
       * from. The SDK emitted the deltas and emits the message from the same scope, so it knows the
       * answer as a fact; stating it replaces the inference with a boolean.
       *
       * Marked rather than suppressed: the message also carries tool calls and metadata, so
       * dropping it would trade a duplicate for a hole. Optional, so no existing consumer breaks.
       */
      textAlreadyStreamed?: boolean;
    }
  | { kind: "delta"; update: import("./updates.js").InteractionUpdate };

/**
 * Handle to a single prompt submission, returned by `agent.send()` before the model has answered.
 *
 * It is a live handle rather than a result — `status` is `"running"` when you receive it — and how
 * you consume the turn is the decision it asks of you. Call `wait()` when only the final answer
 * matters. Call `events()` when you want the whole timeline: structural messages and token/tool
 * deltas interleaved in true order, from one source. That is the one to reach for instead of fusing
 * `stream()` with `SendOptions.onDelta` yourself, which is what produced the ordering and
 * duplicate-text bugs it replaces. `stream()` remains the SDKMessage-only view, and
 * `conversation()` returns the finished turn grouped per turn instead of as a stream.
 *
 * `cancel()` moves the run to `"cancelled"`, aborts the stream and stops in-flight tool calls.
 *
 * Not every method is available on every runtime — see {@link RunOperation}. Ask `supports(op)`
 * before calling an optional one and surface `unsupportedReason(op)`, rather than calling it and
 * catching. The optional fields (`result`, `model`, `durationMs`, `git`, `createdAt`) fill in as the
 * run progresses, so treat their absence as "not yet", not as an error.
 */
export interface Run {
  readonly id: string;
  readonly agentId: string;
  readonly status: RunStatus;
  readonly result?: string;
  readonly model?: ModelSelection;
  readonly durationMs?: number;
  readonly git?: RunGitInfo;
  readonly createdAt?: number;
  /** AsyncGenerator of normalized stream events. Discriminate on `event.type`. */
  stream(): AsyncGenerator<SDKMessage, void>;
  /**
   * theokit#140 - every event of this run in TRUE order, from one source: structural messages and
   * live token/tool deltas interleaved as they occurred.
   *
   * Use this instead of fusing `stream()` with `SendOptions.onDelta` by hand. Neither of those is
   * complete alone - `onDelta` carries no `run_started`/`system`, `stream()` carries no token
   * granularity - and reconciling them in the consumer is what produced the ordering and dedup
   * bugs this replaces.
   *
   * `stream()` is unchanged and remains the SDKMessage-only view.
   */
  events(): AsyncGenerator<RunTimelineEvent, void>;
  /** Resolves to the terminal {@link RunResult}. */
  wait(): Promise<RunResult>;
  /** Move status to `"cancelled"`, abort the stream, stop in-flight tool calls. */
  cancel(): Promise<void>;
  /** Structured per-turn view of the conversation. */
  conversation(): Promise<ConversationTurn[]>;
  /** Whether the given operation is available on this run's runtime. */
  supports(operation: RunOperation): boolean;
  /** Human-readable reason that `supports(operation)` returned `false`. */
  unsupportedReason(operation: RunOperation): string | undefined;
  /** Subscribe to status changes. Returns an unsubscribe function. */
  onDidChangeStatus(listener: (status: RunStatus) => void): () => void;
}

/**
 * SE9 — options for the integrated structured-output method `agent.generate`: the
 * {@link SendOptions} that drive the tool loop (phase 1) plus the required `output`
 * Zod schema and structuring knobs (phase 2). Co-located with `SendOptions` /
 * `RunResult` (which they extend/use) so the public `SDKAgent` interface does not
 * import the runtime `agent-generate` module (breaks the type cycle).
 *
 * @public
 */
export interface GenerateOptions<T extends import("zod").ZodType> extends SendOptions {
  /** Zod schema the final answer is coerced into (the structuring contract). */
  output: T;
  /** Retry budget on the structuring phase's parse-failures (reused from generateObject). Default 1. */
  maxRetries?: number;
  /**
   * What the STRUCTURING phase (phase 2) does when the model's output still fails
   * Zod validation after retries. Default `"throw"`. `"return-partial"` / `"return-raw"`
   * salvage the object; the salvaged/raw value is in {@link GenerateRunResult.raw}
   * (the pre-parse structuring input) — NOT the phase-1 text answer, which is in
   * `result.result`.
   */
  errorStrategy?: "throw" | "return-partial" | "return-raw";
}

/**
 * SE9 — result of `agent.generate`: the validated typed object plus the underlying
 * tool-loop {@link RunResult} (status / usage / model) and the raw pre-parse input.
 *
 * @public
 */
export interface GenerateRunResult<O> {
  /** The validated object — inferred type from the `output` schema. */
  object: O;
  /** The underlying tool-loop run (phase 1). */
  result: RunResult;
  /** Raw model input to the synthetic `output` tool, before the Zod parse. */
  raw: unknown;
  /** Combined token usage of the structuring phase. */
  usage: { inputTokens: number; outputTokens: number };
}
