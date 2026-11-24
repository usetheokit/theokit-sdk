/**
 * Owner: `internal/agent-loop/` (3 of 11 importers). Derived from the import graph, not declared —
 * `tests/lint/types-name-their-owner.test.ts` re-derives it.
 *
 * SE2 — typed runtime EVENT stream, ADDITIVE to the `SDKMessage` content stream.
 *
 * `Run.stream()` yields `SDKMessage`s (the conversation content). `RunEvent`s are
 * out-of-band runtime-OBSERVABILITY signals — the model's content is unaffected —
 * delivered opt-in via `SendOptions.onRunEvent`. Discriminate on `type`. Mirrors
 * the Anthropic `SDKMessage`-union approach (rate-limit, permission-denied, task
 * lifecycle, compaction boundary).
 *
 * The union is the forward-compatible CONTRACT (discriminate exhaustively). The
 * runtime EMITS every variant end-to-end: `tool_progress` + `permission_denied`
 * (agent-loop tool-dispatch seam), `rate_limit` (pool-aware LLM client 429 retry),
 * `compact_boundary` (session auto-compaction), and `task_*` (opt-in bridge from a
 * `Task.submit({ onRunEvent })` task's lifecycle). A consumer switching on `type`
 * sees the real signal.
 *
 * @public
 */
export type RunEvent =
  | RunToolProgressEvent
  | RunRateLimitEvent
  | RunPermissionDeniedEvent
  | RunTaskStartedEvent
  | RunTaskUpdatedEvent
  | RunTaskCompletedEvent
  | RunCompactBoundaryEvent
  | RunCompactionFallbackEvent
  | RunTripwireEvent
  | RunCompletionCheckEvent
  | RunMcpServerFailedEvent
  | RunMcpServerReadyEvent
  | RunMemoryDegradedEvent;

/**
 * theokit#188 — an MCP server was configured but its tools could not be listed, so NONE of its
 * tools exist for this run.
 *
 * The failure was always caught (`safeListTools` returns `[]` so one broken server cannot take the
 * turn down) and always DIAGNOSED — to `diag()`, i.e. the SDK's stderr. Nothing reached the
 * consumer, so a UI listing configured servers could show one as present while every tool it
 * provides had silently vanished. Degrading gracefully is right; degrading INVISIBLY is not.
 *
 * Emitted once per failing server per run, on the same catch path that already had both the name
 * and the reason.
 */
export interface RunMcpServerFailedEvent {
  readonly type: "mcp_server_failed";
  /** The server as named in the MCP configuration, so the consumer can match it to what it lists. */
  readonly serverName: string;
  /** Why listing failed — a spawn error, a handshake timeout, a protocol error. */
  readonly message: string;
}

/**
 * usetheokit/theokit#426 — an MCP server came up, and these are the tools it delivered.
 *
 * The sibling of {@link RunMcpServerFailedEvent}, emitted from the same function, on the other
 * branch. Without it a consumer could see what was CONFIGURED and what BROKE, and could not tell a
 * server that came up with twelve tools from one that came up with none — which is exactly the case
 * an operator opens a server-status panel to find. `tools: []` on a healthy server is a real and
 * previously unreportable state.
 *
 * An EVENT rather than a getter, because the state is scoped to the run: with
 * `mcpLifecycle: "run"` a server may not exist by the time anyone asks, so a getter would have to
 * answer about something already gone. This says what was true when the run started.
 *
 * Emitted once per successfully-listed server per run.
 */
export interface RunMcpServerReadyEvent {
  readonly type: "mcp_server_ready";
  /** The server as named in the MCP configuration — the key a consumer already lists it under. */
  readonly serverName: string;
  /**
   * The tool names the server reported, as IT names them.
   *
   * Not the `mcp_<server>_<tool>` form the model sees: that spelling is sanitized for the provider,
   * and a consumer matching it back to a server's own documentation would have to undo the mangling.
   */
  readonly tools: readonly string[];
}

/**
 * SE24 — a guardrail processor called `abort()`; the run stops with a tripwire.
 * Delivered via {@link SendOptions.onRunEvent} (mirrors the `RunResult.tripwire`
 * surfaced on `wait()`).
 */
export interface RunTripwireEvent {
  readonly type: "tripwire";
  readonly reason: string;
  readonly processorId: string;
}

/** A tool call is being dispatched (before its result). */
export interface RunToolProgressEvent {
  readonly type: "tool_progress";
  readonly toolName: string;
  readonly toolCallId: string;
}

/** The provider returned a rate-limit (HTTP 429); the loop will back off + retry. */
export interface RunRateLimitEvent {
  readonly type: "rate_limit";
  /** Retry attempt number (1-based) about to be delayed. */
  readonly attempt: number;
  /** Delay in ms before the retry, when the provider/policy supplied one. */
  readonly retryAfterMs?: number;
}

/**
 * A tool call was DENIED before dispatch — by the permission gate/plugin (SE1),
 * an operator file-hook `preToolUse`, or the fork tool-whitelist. `source`
 * discriminates which. `toolCallId` joins the event to the tool-call log.
 */
export interface RunPermissionDeniedEvent {
  readonly type: "permission_denied";
  readonly toolName: string;
  readonly toolCallId: string;
  /** Which layer blocked the call. `floor` is the protected-path / critical-path floor. */
  readonly source: "plugin" | "file_hook" | "fork_whitelist" | "floor";
  /** The rejection message surfaced to the model. */
  readonly message: string;
}

/** A background task/subagent started. */
export interface RunTaskStartedEvent {
  readonly type: "task_started";
  readonly taskId: string;
  readonly description?: string;
}

/** A background task/subagent changed state. */
export interface RunTaskUpdatedEvent {
  readonly type: "task_updated";
  readonly taskId: string;
  readonly status: string;
}

/** A background task/subagent finished. */
export interface RunTaskCompletedEvent {
  readonly type: "task_completed";
  readonly taskId: string;
  readonly status: "completed" | "failed" | "stopped";
}

/**
 * SE34 — the per-send completion check (`isTaskComplete`) produced a verdict.
 * Emitted once, after a finished run's reply is judged against
 * {@link SendOptions.completionCheck}. Distinct from `task_completed` (which is
 * background-task/subagent lifecycle). Mirrors {@link RunResult.completionCheck}.
 */
export interface RunCompletionCheckEvent {
  readonly type: "completion_check";
  readonly complete: boolean;
  readonly reason: string;
}

/** The conversation crossed a compaction boundary (history was summarized). */
export interface RunCompactBoundaryEvent {
  readonly type: "compact_boundary";
  readonly trigger: "manual" | "auto";
  /** Token count before compaction, when known. */
  readonly preTokens?: number;
}

/**
 * M77 — auto-compaction is budgeting against a FLOOR, because neither the catalog nor the caller
 * supplied a context window for this model.
 *
 * The prior behaviour was to disable auto-compaction entirely and write one line to stderr per
 * process. That is fail-OPEN: the conversation grows until the provider rejects it. This event exists
 * so a surface can say "I am running without a real budget" instead of the user discovering it at the
 * moment of failure.
 *
 * Not emitted when the window came from the catalog (the normal path) or from an explicit caller
 * override (the caller already knows).
 */
export interface RunCompactionFallbackEvent {
  readonly type: "compaction_fallback";
  /** The model whose window is unknown — what the user needs to fix in configuration. */
  readonly model: string;
  /** The floor being budgeted against, after the safety margin. */
  readonly window: number;
}

/**
 * A memory stage failed and the run continued without it.
 *
 * The same shape of gap {@link RunMcpServerFailedEvent} closed for MCP, in the module next door.
 * `initLoopContext` had three bare `catch { <field> = <empty> }` blocks: an init failure meant no
 * memory tool was registered, a `buildTools` failure meant no provider tools, and a `runActivePass`
 * failure meant no recalled context in the system prompt. The agent then answered without the memory
 * it was configured with, and nothing recorded it — not stderr, not this sink, not the span in scope.
 *
 * Degrading to a working agent is the right BEHAVIOUR. This event exists because the degradation was
 * unobservable, so a host UI showed a healthy run.
 *
 * Emitted once per failing stage per run.
 *
 * @public
 */
export interface RunMemoryDegradedEvent {
  readonly type: "memory_degraded";
  /** Which stage failed: `init`, `buildTools`, or `activePass`. */
  readonly stage: string;
  /** Why it failed, as the provider reported it. */
  readonly message: string;
}

/**
 * Receives every {@link RunEvent} a run emits, in emission order.
 *
 * Wired through `onRunEvent` on the run options. The sink is observability, never control flow: it
 * cannot cancel, alter, or delay the run, and {@link emitRunEvent} swallows anything it throws — a
 * broken sink degrades what you can see, never what the agent does.
 *
 * Synchronous by signature, so a slow sink slows the run. Hand work off rather than awaiting inside
 * it; returning a promise here would be ignored, not awaited.
 *
 * @public
 */
export type RunEventSink = (event: RunEvent) => void;
