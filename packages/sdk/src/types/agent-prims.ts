/**
 * Owner: `internal/agent-loop/` (3 of 11 importers). Derived from the import graph, not
 * declared — `tests/lint/types-name-their-owner.test.ts` re-derives it.
 *
 * Type-leaf — primitives shared between `agent.ts`, `run.ts`, and
 * `messages.ts`. Extracted to break LOW type-only cycles #5 and #7
 * (audit `architecture-output/final_report.md`) per plan
 * arch-review-fixes-2026-06-06 § Phase 4 / T4.1 (D438).
 *
 * Public surface unchanged — `types/agent.ts` re-exports these from this
 * leaf so `import type { ModelSelection, CustomTool } from "@theokit/sdk"`
 * keeps resolving.
 *
 * @public
 */

/**
 * One slot in a {@link ModelSelection.params} array.
 *
 * The `thinking` param sets the reasoning effort and takes a non-empty value, for example
 * `{ id: "thinking", value: "high" }`. An empty or whitespace-only value is refused with a
 * `ConfigurationError` (code `invalid_model_param`) at `Agent.create` and at a `send` override,
 * before any request. To request no reasoning, leave the `thinking` param out.
 *
 * @public
 */
export interface ModelParameterValue {
  id: string;
  value: string;
}

/**
 * Identifies a model plus optional per-model parameters (e.g. reasoning effort).
 *
 * Use `Theokit.models.list()` to discover valid ids and parameter definitions.
 *
 * @public
 */
export interface ModelSelection {
  id: string;
  params?: ModelParameterValue[];
  /**
   * M94 — the model's context window, in tokens. Becomes the window resolver's `override`.
   *
   * It exists for models with NO catalog entry: without it, a 400k model was budgeted against the
   * 128k floor and compacted ~3x more than it needed to. A value above what the catalog knows is
   * clamped — declaring 10M does not blow past the provider.
   */
  contextWindow?: number;
  /**
   * #332 — the endpoint THIS model should reach, for OpenAI-compatible and local servers.
   *
   * Without it the base URL came only from a process-wide env var (`OLLAMA_HOST`) or the provider
   * profile's shipped default, so every `ollama/*` model in a process shared one host — an app
   * could not run a small model on localhost and a large one on a GPU box.
   *
   * It outranks the env var deliberately: with the env var winning, whoever set it for one model
   * would keep hijacking every other one, which is the same bug wearing a hat.
   *
   * Leaving it unset keeps the zero-config path exactly as it was — `ollama/qwen2.5:3b` still
   * resolves to `http://localhost:11434` from the profile, with no key and no setup.
   */
  url?: string;
}

/**
 * SE12 — a read-only, text-only projection of one turn of the run's conversation,
 * exposed to a tool handler via `ctx.messages`. Content is flattened to text; tool
 * calls / results and non-text parts are dropped, and turns that project to empty
 * text are omitted. Consumed by `defineSubAgent`'s `messageFilter` to forward
 * (a subset of) the supervisor transcript to a subagent.
 *
 * `role` includes `"system"` for type-completeness with the wire message shape,
 * but the system prompt travels on a separate request field — a `"system"` entry
 * does NOT appear in the current projection.
 *
 * @public
 */
export interface ToolContextMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Local function tool declared per-agent via {@link AgentOptions.tools}. The
 * handler runs in-process; no MCP server is involved. The SDK serializes
 * `name`, `description`, and `inputSchema` into the model's tool catalog.
 *
 * Handlers MUST be re-passed on `Agent.resume()` because closures cannot be
 * persisted. The tool catalog (name + description + schema) is NOT serialized.
 *
 * @public
 */
export interface CustomTool {
  /**
   * Tool name surfaced to the LLM. Must match `^[a-zA-Z][a-zA-Z0-9_-]{0,63}$`
   * and must not collide with `shell`, `memory_search`, `memory_get`, or any
   * `mcp_*` prefix (reserved for the SDK's built-in tools).
   */
  name: string;
  /** Description surfaced to the LLM. Required — drives tool-selection accuracy. */
  description: string;
  /** JSON Schema (Draft-7 subset) describing the `input` argument. Must be `type: "object"`. */
  inputSchema: Record<string, unknown>;
  /**
   * Local handler invoked when the model emits `tool_use` for this tool.
   * Returns a string OR structured content blocks (SE7 — text + image, e.g. a
   * screenshot) that become the `tool_result.content` surfaced back to the
   * model. Throws → SDK converts to `tool_result` with `isError: true` and the
   * error `message` as content; throw a `ToolError` to carry a clean message or
   * multimodal error content. #65 — an optional 2nd `ToolContext` argument
   * carries the run's `AbortSignal`; single-argument handlers are unaffected. M7
   * — the same `ctx` also carries an optional user `context` (provided once via
   * `SendOptions.context`), so shared config like a `projectRoot` is read by
   * every tool instead of baked into each factory. SE12 — `ctx.messages` is a
   * read-only, text-only projection of the current turn's transcript (see
   * {@link ToolContextMessage}); `defineSubAgent`'s `messageFilter` consumes it.
   * #119 — `ctx.threadId` is the run's session identity (the key passed to
   * `Agent.getOrCreate(sessionId, …)`, or the agent's own id), so a stateful tool
   * shared across sessions can scope its state per session instead of leaking it.
   */
  handler: (
    input: Record<string, unknown>,
    ctx?: {
      signal?: AbortSignal;
      context?: unknown;
      messages?: readonly ToolContextMessage[];
      threadId?: string;
    },
  ) =>
    | string
    | import("./content-blocks.js").ToolResultContentBlock[]
    | Promise<string | import("./content-blocks.js").ToolResultContentBlock[]>;
}

/**
 * How the permission engine treats the UNMATCHED verdict.
 *
 * - `default` — ask.
 * - `plan` — read-only.
 * - `acceptEdits` — auto-approve the unmatched verdict, but still honour an explicit `ask` rule.
 * - `bypass` (alias `bypassPermissions`, the Anthropic-exact name) — everything allowed EXCEPT an
 *   explicit `deny`. Never asks.
 *
 * G7 / DIP — defined in this type leaf rather than in `permission-engine.ts`, which is a RUNTIME
 * module. `types/agent.ts`, `types/run.ts` and `types/plugin.ts` all need the union, and each one
 * used to reach into the engine for it: three of the nine violations the `types-dont-import-runtime`
 * rule reported the moment it was able to see type-only edges at all. The engine re-exports it, so
 * `import type { PermissionMode } from "@theokit/sdk"` is unchanged.
 *
 * @public
 */
export type PermissionMode = "default" | "plan" | "acceptEdits" | "bypass" | "bypassPermissions";
