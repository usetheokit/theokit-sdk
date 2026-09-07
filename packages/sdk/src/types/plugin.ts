/**
 * Owner: `internal/plugins/` (3 of 3 importers). Derived from the import graph, not
 * declared — `tests/lint/types-name-their-owner.test.ts` re-derives it.
 *
 * Plugin contract types (T1.1, ADRs D97-D101).
 *
 * Discriminated union by `kind`:
 *   - `"general"` — registers tools/hooks/commands via `register(ctx)`.
 *   - `"model-provider"` — declares a `ProviderProfile` consumed by router.
 *   - `"memory"` — supplies a memory provider factory.
 *
 * Hooks are a fixed enum (D100) to prevent sprawl; `pre_tool_call` supports
 * veto via `{ block: true, message }` (D101) so plugins can implement safety
 * guards without crashing the agent loop.
 *
 * SE45/SE46 — the pure `Plugin` *type* (and its type companions) live here in
 * `types/` so the public contract sits above the DIP boundary. The RUNTIME
 * value (`definePlugin` / `Plugin.create`) stays in `internal/plugins/types.ts`,
 * which imports the type from here and re-exports these names for back-compat.
 *
 * @public
 */

// Import `CustomTool` from the leaf `agent-prims.ts` where it is DEFINED (not via
// the `agent.ts` re-export) so this module does not close a type-only import
// cycle `agent → plugin → agent`.
import type { CustomTool, PermissionMode } from "./agent-prims.js";
import type { MemoryAdapter } from "./memory-adapter.js";
import type { ProviderProfile } from "./provider-profile.js";

/**
 * The fixed set of points a `"general"` plugin may attach to through `PluginContext.on`. A closed
 * enum rather than an open string, so a plugin cannot register for a hook the loop never fires.
 *
 * What separates them is what the SDK does with the handler's return value, and that is the thing to
 * settle before writing one:
 *
 * - `pre_tool_call` is the only VETO point. Return `{ block: true, message }` to stop the call; the
 *   first handler that blocks wins and the remaining handlers are not consulted.
 * - `transform_tool_result` and `transform_llm_output` are CHAINED. Each handler receives what the
 *   previous one returned; `undefined` keeps the current value and anything else — `null` included —
 *   replaces it.
 * - `pre_user_send` returns `{ recalledContext }`, which the loop concatenates across handlers and
 *   injects ahead of the user prompt.
 * - Everything else (`post_tool_call`, `pre_llm_call`, `post_llm_call`, `on_session_start`,
 *   `on_session_end`, `post_assistant_reply`) is fire-and-forget: the return value is DISCARDED. A
 *   policy that needs to change a tool result belongs on `transform_tool_result` — put it on
 *   `post_tool_call` and it quietly degrades to observation.
 * - `on_session_start` / `on_session_end` fire once per **run**, not once per agent lifetime — see
 *   {@link SessionLifecycleContext}. Build an agent per turn and they fire on every message.
 *
 * Failure is asymmetric too. A fire-and-forget or transform handler that throws is caught, logged to
 * stderr, and the run continues. A `pre_tool_call` handler that throws is NOT caught by the hook
 * dispatcher, so its exception escapes into the tool-dispatch path — a permission-style handler
 * should resolve its own errors to an explicit block rather than relying on that.
 */
export type HookName =
  | "pre_tool_call"
  | "post_tool_call"
  | "pre_llm_call"
  | "post_llm_call"
  | "on_session_start"
  | "on_session_end"
  | "transform_tool_result"
  | "transform_llm_output"
  // Memory adapter hooks (ADRs D141 / D145).
  | "pre_user_send"
  | "post_assistant_reply";

/**
 * What a `pre_tool_call` handler is given: the tool about to run, the arguments the model produced
 * for it, and the identity of the run asking.
 *
 * `args` came from the model, not from a validated caller. A handler that gates on argument values
 * must treat every field as untrusted and survive one that is missing or of the wrong type.
 *
 * `permissionMode` is the run's resolved mode — `SendOptions.permissionMode` falling back to
 * `AgentOptions.permissionMode` — threaded here so a permission-style plugin can gate per run rather
 * than at construction time. Absent means neither was set, and the plugin's own default applies;
 * plugins that are not about permissions ignore it.
 */
export interface PreToolCallContext {
  name: string;
  args: Record<string, unknown>;
  agentId: string;
  runId: string;
  /**
   * SE1 — the run's resolved `PermissionMode` (from `SendOptions.permissionMode`
   * ?? `AgentOptions.permissionMode`), threaded so a permission-style plugin can
   * gate per-run rather than at construction time. Absent ⇒ the plugin's own
   * default applies. Ignored by non-permission plugins.
   */
  permissionMode?: PermissionMode;
}

/**
 * The veto a `pre_tool_call` handler returns to stop a tool call. Returning `undefined` allows it —
 * there is no approval value, and `block` is the literal `true`, so `{ block: false }` is not
 * expressible and cannot be used to force a call through.
 *
 * The first blocking handler decides; later `pre_tool_call` handlers never run.
 *
 * `message` is not a log line. The loop turns the veto into a `tool_result` reading "Plugin blocked
 * this tool call: <message>", deliberately NOT flagged as an error, so the model reads it and can
 * choose another route instead of the run failing. Write it for the model: say what was refused and
 * what it might do instead. It also reaches observability — as the `stderr` of a tool-completed event
 * with exit code 126, and as the message on a `permission_denied` run event.
 */
export interface PreToolCallDecision {
  block: true;
  message: string;
}

/**
 * #65 — a 2nd argument passed to a tool handler, carrying the run's cancellation
 * signal (ties into #58) so a cooperative tool can stop when the run is
 * cancelled. Optional and additive — existing single-arg handlers are unaffected.
 * (requestConfirmation/requestCredential are a documented follow-up.)
 *
 * @public
 */
export interface ToolContext {
  signal?: AbortSignal;
}

/** #65 — context for the `post_tool_call` hook (fired after a tool runs). @public */
export interface PostToolCallContext {
  name: string;
  args: Record<string, unknown>;
  result: { stdout: string; stderr: string; exitCode?: number | null };
  agentId: string;
  runId: string;
}

/** #65 — context for the `pre_llm_call` / `post_llm_call` hooks. @public */
export interface LlmCallContext {
  agentId: string;
  runId: string;
  /** Iteration index (0-based) of the current turn, when available. */
  iteration?: number;
}

/**
 * #65 — context for the `on_session_start` / `on_session_end` hooks.
 *
 * **These fire once per RUN, not once per agent lifetime**, and the `runId` on this very context is
 * the tell: it changes every time they fire. "Session" here means one pass through the agent loop.
 *
 * The distinction is invisible to an application that creates an agent once and sends many messages
 * — there, per-run and per-session coincide. It is decisive for one that builds an agent **per
 * turn**: `on_session_start` then fires on every message, which is the opposite of what a handler
 * named for a session start usually assumes.
 *
 * Stated here because it was not stated anywhere a consumer could read it. The only accurate
 * sentence lived in an internal comment at the firing site, and in 2026-09 that cost two people
 * hours and produced a defect report filed against this package for behaviour that is correct.
 * `test_on_session_start_fires_once_per_run_and_again_on_the_next_run` now pins it.
 *
 * @public
 */
export interface SessionLifecycleContext {
  agentId: string;
  runId: string;
}

/** #65 — context for the `transform_tool_result` / `transform_llm_output` hooks. @public */
export interface TransformContext {
  agentId: string;
  runId: string;
}

/**
 * M82 — one tool call of the turn, as seen by `transform_tool_result`. `id` is the correlation key
 * back into the batch: it equals the `toolUseId` of the matching `tool_result` part.
 *
 * @public
 */
export interface ToolCallSummary {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * M82 — context for `transform_tool_result`, the only tool-stage hook whose return value the SDK
 * actually applies (`#runTransform` folds it; `#runFireAndForget` discards `post_tool_call`'s).
 *
 * Before M82 this seam knew only `{agentId, runId}`, so a hook could transform results but could not
 * tell WHICH tool produced which one. A policy scoped to a tool name — the common case — therefore
 * had to live on `post_tool_call`, whose return is discarded, and silently degraded to observation.
 *
 * `toolCalls` is PLURAL because the seam is batch-shaped: `dispatchTools` runs every tool call of the
 * turn and the hook receives all results together. A singular `name` would have to lie in any
 * multi-tool turn. Correlate with `LlmToolResultPart.toolUseId === ToolCallSummary.id`.
 *
 * Kept separate from {@link TransformContext} on purpose: that type is shared with
 * `transform_llm_output`, which has no tool call at all, and an optional field there would be
 * permanently `undefined` for half its consumers.
 *
 * @public
 */
export interface ToolResultTransformContext extends TransformContext {
  toolCalls: readonly ToolCallSummary[];
}

/**
 * Context passed to `pre_user_send` hook handlers (ADR D145).
 *
 * @public
 */
export interface PreUserSendContext {
  prompt: string;
  agentId: string;
  runId: string;
  /** Caller-supplied memory context, flowing through from `AgentOptions.memoryContext`. */
  memoryContext?: import("./memory-adapter.js").MemoryContext;
  /** Forwarded `AbortSignal` so adapter recall HTTP can be cancelled mid-flight (EC-H). */
  signal?: AbortSignal;
}

/**
 * Optional result returned by `pre_user_send` handlers. The agent loop
 * concatenates `recalledContext` from all handlers and injects it as a
 * `<memory-context>...</memory-context>` block before the user prompt.
 *
 * @public
 */
export interface PreUserSendResult {
  recalledContext?: string;
}

/**
 * Context passed to `post_assistant_reply` hook handlers (ADR D145).
 * Fire-and-forget — exceptions are caught and surfaced to stderr; the
 * caller's `wait()` never blocks on this dispatch.
 *
 * @public
 */
export interface PostAssistantReplyContext {
  prompt: string;
  reply: string;
  agentId: string;
  runId: string;
  /**
   * `true` when the run that produced `reply` called at least one tool (#358).
   *
   * A reply produced by a tool call is not safely replayable: re-serving the text hands a later
   * caller the RESULT of a `write_file` / HTTP POST / payment without the side effect having
   * happened. A semantic cache must skip storing such a reply, and before this field existed it
   * had nothing to key on and assumed `false`.
   *
   * Derived from the run's replayed event stream, so it counts tool calls the run actually made,
   * not tools the agent merely has.
   */
  usedTools: boolean;
  memoryContext?: import("./memory-adapter.js").MemoryContext;
}

export type HookHandler = (ctx: unknown) => unknown | Promise<unknown>;

export type CommandHandler = (args: Record<string, unknown>) => Promise<string> | string;

export interface CommandOptions {
  description?: string;
}

/**
 * Detaches a hook handler attached with {@link PluginContext.on}. Idempotent.
 *
 * @public
 */
export type PluginHookDisposer = () => void;

/**
 * The registration surface passed to a `"general"` plugin's `register(ctx)`, and the plugin's only
 * route into the agent. Outside production it is a sealed Proxy that throws when a plugin assigns a
 * property of its own, so smuggling state onto the context fails loudly in development.
 *
 * `register` runs ONCE, when the plugin is registered — never per run. Anything the plugin wants to
 * do during a turn has to be attached here as a hook; there is no later entry point. Each plugin gets
 * its own context, so registrations stay attributable to the plugin that made them.
 *
 * Two things worth knowing before writing one. Commands registered here are consumed by CLI and bot
 * wrappers only — the agent loop never dispatches them, so a plugin that ships nothing but commands
 * has no effect on a programmatic run. And `on` drops a handler that is not a function, with a
 * warning on stderr rather than an error at registration: the gentler failure, and the easier one to
 * miss.
 *
 * `on` returns a {@link PluginHookDisposer}: calling it detaches that one handler, and calling it
 * again is a no-op. A plugin that registers a hook per run and never detaches is the leak this
 * exists to make fixable.
 *
 * @public
 */
export interface PluginContext {
  /** Register a custom tool. Equivalent to passing in `AgentOptions.tools`. */
  registerTool(tool: CustomTool): void;
  /** Register a slash-command-style handler. Consumed by CLI/bot wrappers; NOT used by the agent loop. */
  registerCommand(name: string, handler: CommandHandler, opts?: CommandOptions): void;
  /**
   * Attach a hook handler. `pre_tool_call` supports veto via `PreToolCallDecision`.
   *
   * Returns a disposer that detaches THIS handler. Calling it twice is a no-op, and a handler the
   * SDK refused (a non-function, which is warned and ignored) returns a disposer that does nothing —
   * so the caller never has to branch on whether the registration took.
   *
   * It used to return `void`, which made this a one-way door: a plugin registered through
   * `initialize()` had no removal path and its handlers ran for the life of the process. The one
   * documented dynamic case — the ACP permission plugin, re-installed on every prompt — worked only
   * because `#byName` keys the replacement, so re-registering the WHOLE plugin was the only way to
   * detach one hook. Two observers in this package already return their own disposer
   * (`FixtureRunBase.onDidChangeStatus`) or offer an explicit removal (`MessageBus.unregister`).
   */
  on(hook: HookName, handler: HookHandler): PluginHookDisposer;
  /** Inject a user/system message into the next agent turn. v1 supports only `on_session_start` context. */
  injectMessage(content: string, role?: "user" | "system"): void;
}

interface BasePlugin {
  name: string;
  version: string;
}

/**
 * Memory provider factory shape (ADR D141). Returns a `MemoryAdapter`
 * (sync) or a Promise resolving to one (lazy HTTP probe / config load).
 *
 * Adapters live in `@theokit-memory-*` packages; the SDK never imports
 * them. Factory rejection is caught by the plugin manager and surfaced
 * as `ConfigurationError(code: "plugin_factory_failed")` (EC-F) — never
 * an unhandled rejection.
 *
 * PUBLIC, deliberately (#335). This type is the shape a consumer must satisfy
 * to write a memory plugin: it is named by the PUBLIC `Plugin` union below, in
 * the `createProvider` position. It used to carry the internal-visibility JSDoc
 * tag, which made `stripInternal` delete the declaration while the union went
 * on referencing it — so the published `.d.ts` named a type it did not declare.
 * Invisible under `skipLibCheck`, and an `error`-typed graph for any consumer
 * running type-aware lint. A type reachable from a public signature is public
 * whatever the tag says; the tag was the thing that was wrong.
 *
 * Do NOT write that tag's literal spelling anywhere in this comment. It is
 * matched as text, so a JSDoc block that merely MENTIONS it is stripped exactly
 * as if it had declared it — which is how the first attempt at this fix failed,
 * with a build error naming a symbol whose own explanation had re-hidden it.
 */
export type MemoryProviderFactory = (cwd: string) => MemoryAdapter | Promise<MemoryAdapter>;

export type Plugin =
  | (BasePlugin & {
      kind: "general";
      register: (ctx: PluginContext) => void | Promise<void>;
    })
  | (BasePlugin & {
      kind: "model-provider";
      profile: ProviderProfile;
    })
  | (BasePlugin & {
      kind: "memory";
      createProvider: MemoryProviderFactory;
    });
