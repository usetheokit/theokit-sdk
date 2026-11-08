import type { BuiltinToolName, ModelSelection } from "../../types/agent.js";
import type { ConversationTurn } from "../../types/conversation.js";
import type { SDKMessage } from "../../types/messages.js";
import type { RunStatus, SendOptions } from "../../types/run.js";
// From the declaring module, not the `internal/session/` barrel: that barrel reaches back into
// local-agent through `compact-session.ts`, and this import used to close the loop.
import type { SessionMessage } from "../../types/session-message.js";
import type { LlmClient } from "../llm/types.js";
import type { McpClient } from "../mcp/client.js";
import type { HooksExecutor } from "../runtime/hooks/hooks-executor.js";

/**
 * Minimal memory-tool spec accepted by the agent loop. Concrete shape lives
 * in `internal/memory/tools.ts`; we declare it inline here to avoid pulling
 * the memory module into the cheap loop-types contract.
 *
 * @internal
 */
export interface MemoryToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(input: Record<string, unknown>): Promise<string>;
}

/**
 * Internal mirror of the public {@link import("../../types/agent.js").CustomTool}
 * passed through the loop. Declared inline so the cheap loop-types contract
 * doesn't import the public types barrel.
 *
 * @internal
 */
export interface CustomToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  // SE7 — a handler may return structured content blocks (text + image), not just a string.
  handler: (input: Record<string, unknown>) => ToolHandlerResult | Promise<ToolHandlerResult>;
}

/** SE7 — what a custom tool handler may return: a string or structured content blocks. */
export type ToolHandlerResult =
  | string
  | import("../../types/content-blocks.js").ToolResultContentBlock[];

/**
 * Resolved tool descriptor used by dispatch + executor modules.
 * Lives in loop-types so both tool-dispatch.ts and tool-executors.ts can
 * import it without creating a circular dependency.
 *
 * @internal
 */
export interface ResolvedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  origin: "shell" | "mcp" | "memory" | "custom";
  mcpServerName?: string;
  mcpToolName?: string;
  /** Direct handler for `origin === "memory"` tools — returns JSON-encoded result string. */
  memoryHandler?: (input: Record<string, unknown>) => Promise<string>;
  /** Direct handler for `origin === "custom"` tools — user-supplied via `AgentOptions.tools`.
   *  SE7 — may return a string or structured content blocks. */
  customHandler?: (
    input: Record<string, unknown>,
  ) => ToolHandlerResult | Promise<ToolHandlerResult>;
}

export interface SteerQueue {
  /** Take every pending message. */
  drain(): string[];
  /** Like `drain`, but atomically refuses further pushes when nothing was pending. */
  drainOrClose(): string[];
}

/**
 * Shared agent-loop types. Kept in their own module so the dispatch helpers
 * can import `AgentLoopInputs` without pulling the whole orchestrator file.
 *
 * @internal
 */

export interface AgentLoopInputs {
  /**
   * Consecutive tool-error streak that terminates the run. Default 3.
   *
   * Declared here because it is real and load-bearing, and until now appeared nowhere in the
   * codebase except as an inline cast at its single read site — so this interface was SMALLER than
   * the effective contract. A consumer could not discover the knob from the type, and a typo in the
   * name compiled and silently took the default.
   */
  maxConsecutiveToolErrors?: number;
  /**
   * Upper bound on tool-dispatch concurrency. Default 4.
   *
   * Same story as `maxConsecutiveToolErrors`, with one extra consequence: `tool-dispatch.ts`
   * documented "overrides via `AgentLoopInputs.maxConcurrentTools`" for a field this interface did
   * not have, so that comment was false until this line existed.
   */
  maxConcurrentTools?: number;
  agentId: string;
  runId: string;
  model: ModelSelection;
  systemPrompt?: string;
  userMessage: string;
  /** M35 (multimodal) — images to attach to the first user turn as image content blocks. */
  userImages?: import("../../types/run.js").SDKUserMessage["images"];
  llm: LlmClient;
  mcp: Map<string, McpClient>;
  hooks: HooksExecutor;
  /** T4.2 — PluginManager whose `pre_tool_call` hooks fire BEFORE file-based hooks. */
  pluginManager?: import("../plugins/manager.js").PluginManager;
  /**
   * SE1 — the run's resolved permission mode (`SendOptions.permissionMode` ??
   * `AgentOptions.permissionMode`), threaded into the `pre_tool_call` context so a
   * registered `PermissionPlugin` gates per-run.
   */
  permissionMode?: import("../../permission-engine.js").PermissionMode;
  /**
   * SE2 — opt-in typed runtime-event sink (from `SendOptions.onRunEvent`). The loop
   * emits `RunEvent`s (permission_denied, tool_progress, rate_limit, task_*,
   * compact_boundary) to it out-of-band, best-effort (a throwing sink never breaks
   * the run). Absent ⇒ no events emitted.
   */
  runEventSink?: import("../../types/run-events.js").RunEventSink;
  shellCwd: string;
  shellSandbox: boolean;
  maxIterations?: number;
  /** Doom-loop guard config (from `SendOptions.doomLoop`): `false` disables; an object tunes the
   *  soft/hard thresholds; absent = on with defaults (3/5). See `doom-loop-tracker.ts`. */
  doomLoop?: import("./doom-loop-tracker.js").DoomLoopOption;
  /**
   * Production-Readiness #5 (ADR D318): caller-supplied `AbortSignal` from
   * `SendOptions.signal`, plus the agent's lifecycle controller. When fired
   * (user cancel, dispose, SIGTERM), the LLM `fetch()` is aborted at
   * transport level — tokens stop billing mid-stream.
   *
   * When undefined the loop uses a never-aborting placeholder signal
   * (legacy behavior).
   */
  signal?: AbortSignal;
  /**
   * Steer queue (`SendOptions.queueMode: "steer"`). The loop drains it before each LLM call and,
   * when the model would finish, once more — a message found there keeps the run going. It closes
   * the queue when the loop ends so a late message is refused rather than lost.
   */
  steerQueue?: SteerQueue;
  /**
   * M7 — caller-supplied run `context` from `SendOptions.context`, forwarded to
   * every tool handler's `ctx.context`. Shared config (e.g. `projectRoot`) is set
   * once here instead of baked into each tool factory. Opaque to the loop.
   */
  context?: unknown;
  /**
   * SE12 — a read-only, text-only projection of the current turn's transcript,
   * set per-dispatch by the loop and forwarded to every custom tool handler's
   * `ctx.messages`. Consumed by `defineSubAgent`'s `messageFilter`. Opaque to the
   * loop; undefined when there is nothing to project.
   */
  messages?: readonly import("../../types/agent-prims.js").ToolContextMessage[];
  /**
   * SE18 — per-send tool whitelist from `SendOptions.activeTools`. When set, the
   * loop runs inside a `withToolWhitelist` scope so a call to a tool outside this
   * set is vetoed at dispatch (same path as `Agent.fork`'s `allowedTools`).
   */
  activeTools?: readonly string[];
  /**
   * #58 — per-tool execution timeout in ms. When set, each tool call is bounded
   * by `AbortSignal.timeout(perToolTimeoutMs)` merged with `signal`, so a hung
   * tool rejects (exit 124) instead of wedging the loop. Undefined = no timeout.
   */
  perToolTimeoutMs?: number;
  /**
   * #57 — opt-in tool-result content guard applied before results reach the
   * LLM: `{ delimit: true }` frames untrusted tool output as data (prompt-
   * injection mitigation); `{ redactPii: true }` redacts email/phone PII.
   * Undefined = no guard (unchanged behavior).
   */
  toolResultGuard?: import("./tool-result-guard.js").ToolResultGuardOptions;
  /**
   * B-564 — opt-in pruning of aged tool results from each LLM request (a copy; the transcript
   * keeps full results). Undefined = no pruning.
   */
  pruneToolResults?: import("./prune-tool-results.js").PruneToolResultsOptions;
  /**
   * Production-Readiness #4 (ADRs D315-D317): tool lifecycle observability
   * callbacks forwarded from `AgentOptions`. Wrapped around tool dispatch
   * so cost-tracking + audit log can correlate start/end/error events via
   * `callId`. Errors thrown by callbacks are swallowed.
   */
  onToolStart?: import("../../types/agent.js").AgentOptions["onToolStart"];
  onToolEnd?: import("../../types/agent.js").AgentOptions["onToolEnd"];
  onToolError?: import("../../types/agent.js").AgentOptions["onToolError"];
  /**
   * T4.2 (ADRs D90-D91): explicit iteration budget. When omitted, the loop
   * constructs one from `maxIterations`. Tests can inject a pre-configured
   * instance to verify grace-call / compression-cap semantics.
   */
  budget?: import("../budget/tracker/budget.js").IterationBudget;
  /** Fires after each completed conversation step (text turn or tool batch). */
  onStep?: SendOptions["onStep"];
  /** Fires per raw incremental update (text-delta, …) — finer than onStep. */
  onDelta?: SendOptions["onDelta"];
  /**
   * theokit#140 - live subscriber for the loop's own events, invoked as each one is appended.
   *
   * The loop still returns the full list on AgentLoopOutput.events; this is additive. It exists so
   * the run that owns the loop can surface events in true order instead of receiving one batch
   * after completion - which is what forced consumers to fuse this surface with onDelta by hand.
   *
   * Assigned by the caller after building the inputs, so it is mutable.
   */
  onLoopEvent?: (event: SDKMessage) => void;
  /** Step-cap force-close: per-run tool gate forwarded to the LLM request (`tool_choice`). */
  toolChoice?: SendOptions["toolChoice"];
  /**
   * Prior conversation history (user + assistant turns) from previous
   * `agent.send()` calls on the same agent. Excludes the current user
   * message — that is supplied via `userMessage` and appended by the
   * loop. Empty array for first-send agents.
   */
  priorMessages?: ReadonlyArray<SessionMessage>;
  /**
   * Memory tools (`memory_search`, `memory_get`) to register with the LLM
   * when `AgentOptions.memory.enabled === true`. Appended to the shell + MCP
   * tool catalog in `collectTools`.
   */
  memoryTools?: ReadonlyArray<MemoryToolSpec>;
  /**
   * Inline custom tools declared via `AgentOptions.tools`. Appended to the
   * tool catalog after shell + MCP + memory, before the LLM call.
   */
  customTools?: ReadonlyArray<CustomToolSpec>;
  /**
   * usetheokit/theokit-sdk#381 — builtin tool names this run must NOT declare, forwarded from
   * `AgentOptions.withheldBuiltinTools`. Applied where each builtin is assembled, never as a
   * post-hoc filter over the finished catalog: a consumer that withholds `shell` may then supply
   * their OWN tool of that name, and a blanket name filter would delete theirs too.
   *
   * Absent ⇒ nothing is withheld (the pre-#381 catalog, byte for byte).
   */
  withheldBuiltinTools?: ReadonlyArray<BuiltinToolName>;
  /** Telemetry handle (D34). No-op when disabled. */
  telemetry?: import("../telemetry/tracer.js").TelemetryHandle;
  /**
   * Pluggable budget tracker (SDK 2.0 Phase 2 / T2.1 — ADR D1 interface
   * inversion). When provided, the loop calls `track()` after each LLM
   * completion AND gates each iteration through `evaluateBudgetGate`. When
   * undefined, the legacy internal `IterationBudget` + `UsageAccumulator`
   * remain the sole authority.
   *
   * The calls are in this same slice: `loop.ts:78-81` (gate), `:110`
   * (`nextIteration()`), `:390`/`:397` (`track(...)`). This block used to say
   * "plumbed at the type surface only ... land in a follow-up iteration", stale-claim-ok: verbatim quote of the corrected text
   * which stopped being true when those calls landed and was never revisited.
   */
  budgetTracker?: import("../budget/tracker/budget-tracker.js").BudgetTracker;
  /**
   * Pluggable memory provider (SDK 2.0 Phase 1 / T1.4 — Hexagonal
   * Architecture interface inversion). When provided, the loop calls
   * `init()` / `buildTools()` / `runActivePass()` / `sync()` / `dispose()` at
   * the kernel hooks. When undefined, the legacy `Memory` class +
   * `internal/memory/*` runtime files remain the sole authority.
   *
   * The calls are in this same slice: `loop-context-init.ts:95` (`init`),
   * `:129` (`buildTools`), `:166` (`runActivePass`), and `loop.ts:176`/`:204`
   * (`sync`, `dispose`). This block used to say "plumbed at the type surface
   * only ... land in T1.5"; T1.5 landed and the note did not move.
   */
  memoryProvider?: import("../runtime/memory-glue/memory-provider.js").MemoryProvider;
}

/**
 * Structured error surfaced from the loop catch/error-event paths
 * (transport/provider failures). Set-once invariant — the first reaching
 * error wins; later errors in the same run are ignored (ADR D3, EC-3-A).
 *
 * @internal — finding-b fix (sdk-error-packaging-fix-plan v1.1)
 */
export interface AgentLoopErrorDetail {
  message: string;
  code?: string;
  cause?: unknown;
}

export interface AgentLoopOutput {
  events: SDKMessage[];
  finalStatus: RunStatus;
  result: string;
  conversation: ConversationTurn[];
  /**
   * Aggregated token usage across every LLM call in this loop (ADR D376).
   * Populated whenever ≥1 LLM call completed — including partial-failure
   * runs (EC-5). Undefined when zero LLM calls fired (e.g., abort before
   * first send, or fixture-mode path that bypasses this loop).
   */
  usage?: import("../../types/usage.js").TokenUsage;
  /**
   * Inferred pricing-based cost matching `usage` (ADR D377). Set when the
   * model has a pricing entry in the registry; `cost.status` is
   * `"estimated"` / `"unknown"` / `"included"` per D377.
   */
  cost?: import("../../types/usage.js").CostBreakdown;
  /**
   * Structured error from transport / provider failure (Finding B fix).
   * When set, `finalStatus === "error"`. Downstream surfaces (runtime,
   * `RunResult.error`) copy this verbatim. NEVER leaks as an assistant
   * message (the previous bug — sdk-error-packaging-fix-plan).
   */
  error?: AgentLoopErrorDetail;
  /**
   * M1-2 (T2.2): true when the loop stopped at its iteration ceiling with the
   * model still wanting to call tools (silent truncation). Copied verbatim onto
   * `RunResult.stoppedAtIterationLimit`.
   */
  stoppedAtIterationLimit?: boolean;
  /**
   * Doom-loop guard: true when the loop stopped because the model repeated IDENTICAL tool calls to
   * the hard threshold. Copied verbatim onto `RunResult.stoppedByDoomLoop`; the continuation driver
   * classifies it as a `no_progress` terminal (a controlled stop, not a truncation to re-send).
   */
  stoppedByDoomLoop?: boolean;
}
