/**
 * Owner: `src/` (13 of 65 importers). Derived from the import graph, not
 * declared — `tests/lint/types-name-their-owner.test.ts` re-derives it.
 *
 */
import type { BudgetTracker } from "./budget-tracker.js";
import type { ContextSettings } from "./context.js";
import type { HookApprovalGate } from "./hooks.js";
import type { McpServerConfig } from "./mcp.js";
import type { MemoryProvider } from "./memory-provider.js";
import type { PluginsSettings, ProviderRoutingSettings } from "./providers.js";
import type { SendOptions } from "./run.js";

// T4.1 / D438 — primitives now live in `./agent-prims.ts` (leaf file) so
// `./run.ts` and `./messages.ts` can reach them without cycling through
// `./agent.ts`. Re-exported here for back-compat with consumers that import
// `ModelSelection` / `ModelParameterValue` / `CustomTool` from `@theokit/sdk`.
export type {
  CustomTool,
  ModelParameterValue,
  ModelSelection,
  ToolContextMessage,
} from "./agent-prims.js";

import type { CustomTool, ModelSelection, PermissionMode } from "./agent-prims.js";
// Code `Plugin` objects (the array form of `AgentOptions.plugins`) are the
// public discriminated union. SE45/SE46 — sourced from the sibling `./plugin.ts`
// contract module so no `types/*.ts` file reaches into `internal/`.
import type { Plugin } from "./plugin.js";
// SE46 — the SDKAgent surface cluster lives in ./sdk-agent.ts (extracted from this
// god-file to break the memory-provider madge cycle). agent.ts imports the ones it
// uses internally, and re-exports the whole cluster so every existing importer of
// these types from ./agent.js keeps resolving (public API byte-stable).
import type {
  InvalidateCacheOptions,
  PersonalityPreset,
  SDKAgent,
  SystemPromptSkillRef,
} from "./sdk-agent.js";

export type {
  AgentOperation,
  SDKAgentPlugins,
  SDKAgentSkillDetail,
  SDKAgentSkills,
  SDKArtifact,
  SDKPluginMetadata,
} from "./sdk-agent.js";
export type { InvalidateCacheOptions, PersonalityPreset, SDKAgent, SystemPromptSkillRef };

/**
 * Which on-disk settings layers a local agent loads.
 *
 * @public
 */
export type SettingSource = "project" | "user" | "team" | "mdm" | "plugins" | "all";

/**
 * A foreign configuration dialect this SDK can read.
 *
 * A DIFFERENT axis from {@link SettingSource}, and collapsing the two would be wrong: that one is
 * about SCOPE (user vs project, and the trust posture behind it), this one about which product's
 * format a project wants imported. A project can legitimately want project scope with `.theokit/`
 * only — which is now the default.
 *
 * @public
 */
export type CompatSource = "claude-code" | "theokit" | CompatSourceAdapter;

/**
 * A surface a foreign configuration source may be admitted to.
 *
 * They are named separately because they carry very different risk. A skill is TEXT that enters the
 * system prompt; a subagent is a definition; a plugin is CODE LOADING; a hook is COMMAND EXECUTION.
 * Reusing the skills you already wrote for another product is a reasonable thing to want, and it is
 * not a reason to hand that product's directory the right to run commands.
 *
 * `context` is the foreign root's INSTRUCTIONS — `.claude/rules/*.md`. Same risk class as `skills`:
 * text a cloned repository wrote, entering the system prompt as if the consumer had written it. It
 * was missing until usetheokit/theokit-sdk#652, so the four surfaces above failed closed while this
 * one was admitted by a path that consulted no grant at all.
 *
 * @public
 */
export type CompatSurface = "context" | "hooks" | "plugins" | "skills" | "subagents";

/**
 * A foreign source admitted to named surfaces only.
 *
 * ```ts
 * local: { compatSources: [{ kind: "claude-code", import: ["skills", "subagents"] }] }
 * ```
 *
 * `import` is not optional in spirit even though it is in the type: an adapter that omits it
 * imports NOTHING. That is deliberate and it is the fail-closed rule this whole option exists to
 * serve — a typo in a surface name must narrow access, never widen it.
 *
 * The bare `"claude-code"` string keeps meaning every surface. It is what `5.0.0-next.1` published,
 * and silently narrowing it would turn a working opt-in into a no-op that says nothing — which is
 * the defect usetheokit/theokit-sdk#524 reports, one level up.
 *
 * @public
 */
export interface CompatSourceAdapter {
  /**
   * `"theokit"` names THIS package's own root (#631), in the same vocabulary a foreign dialect
   * uses. Until it was accepted here, `.theokit/` contributed every surface unconditionally while a
   * foreign one could declare which surfaces it wanted — an asymmetry with a measured cost: a
   * consumer keeping its own configuration in `.theokit/settings.json` had that file's `hooks` key
   * executed by this package, and `settingSources` gave it no way to decline, because it grants per
   * SOURCE and not per surface.
   *
   * Declaring nothing keeps today's behaviour exactly: the native root contributes everything.
   */
  readonly kind: "claude-code" | "theokit";
  readonly import?: readonly CompatSurface[];
}

/**
 * A tool the SDK declares to the model on its own initiative — not one the consumer passed in
 * {@link AgentOptions.tools}, and not one an MCP server exposed.
 *
 * These three names are also the ones the SDK reserves: a custom tool may not claim them. Listing
 * one in {@link AgentOptions.withheldBuiltinTools} both stops it being declared and releases the
 * name, because nothing of the SDK's is occupying it any more.
 *
 * Named for usetheokit/theokit-sdk#381, which is the report that the catalog had no opt-out.
 *
 * @public
 */
export type BuiltinToolName = "shell" | "memory_search" | "memory_get";

/**
 * Local agent configuration.
 *
 * TWO THINGS A LOCAL AGENT DOES BY DEFAULT, both reported as surprises (#338):
 *
 * 1. **A `shell` tool is always registered**, including when you pass `tools: []`. Every local
 *    agent can therefore read any file reachable from {@link LocalOptions.cwd}. One report describes
 *    an evaluation invalidated this way: the working directory held the benchmark's answer key, and
 *    two transcripts show the model citing it. Deny it explicitly if that matters —
 *    `{ tool: "shell", action: "deny" }` on a {@link PermissionEngine} rule is terminal under every
 *    permission mode, including `bypass`. A deny rule still leaves the tool in the advertised
 *    catalog, so the model may attempt it and be refused; to keep it out of the catalog entirely,
 *    pass `withheldBuiltinTools: ["shell"]` on {@link AgentOptions} (usetheokit/theokit-sdk#381).
 *
 * 2. **Finished runs write a transcript to disk**, at `.theokit/memory/sessions/<runId>.md` under
 *    the workspace `cwd`, with the full prompt and reply. This happens with no `memory` config and
 *    with `settingSources: []` — it is what `memory_search({ corpus: "sessions" })` reads. Opt out
 *    with `memory: { enabled: false }`, which suppresses the write entirely
 *    (usetheokit/theokit-sdk#382). Leaving `memory`
 *    unset still writes, so if the workspace is a git repository, add `.theokit/` to `.gitignore`:
 *    one report describes a transcript reaching a public repo before it was noticed.
 *
 * @public
 */
export interface LocalOptions {
  /**
   * Workspace root(s). Also the reach of the always-present `shell` tool — see the note on
   * {@link LocalOptions}, and the transcript written under `.theokit/memory/sessions/` here.
   */
  cwd?: string | string[];
  settingSources?: SettingSource[];
  /**
   * Foreign configuration dialects to import. Default: none — `.theokit/` only.
   *
   * `.claude/` used to be read unconditionally across hooks, plugins, skills and subagents, so a
   * repository that merely had Claude Code set up had its hooks executed, its skills folded into
   * the system prompt and its subagents registered, having configured nothing for this SDK
   * (usetheokit/theokit-sdk#524). One consequence was every turn being denied, because those hook
   * commands are written against a runtime that defines `$CLAUDE_PROJECT_DIR` and this one did not
   * (#522).
   *
   * A trust gate answers "do I trust the code in this directory?". That is a different question
   * from "do I want another product's configuration imported into this one?", and they come apart
   * in the ordinary case: a repository you trust completely is exactly where `.claude/` is
   * populated — for a different tool, by a different contract, often by a teammate who never heard
   * of this SDK.
   *
   * Listing a dialect is all-or-nothing for that dialect, and restores exactly the previous
   * behaviour. On a name collision `.theokit/` wins: the native definition is the one the project
   * wrote for this runtime.
   */
  compatSources?: CompatSource[];
  /**
   * #631 — the consumer's chance to refuse a hook command before this package spawns it.
   *
   * Absent means run, which is what every consumer gets today. It is consulted at the single point
   * a hook is executed, for every root — including a foreign dialect's, which is the case
   * {@link CompatSourceAdapter} cannot reach: a consumer that wants `.claude/`'s skills, agents and
   * rules cannot decline only its hooks, because `settingSources` grants per source.
   *
   * A refused hook resolves as if it were not configured. It does NOT deny the operation the hook
   * attached to — the consumer asked for the command not to run, not for the work to stop.
   */
  hooks?: HookApprovalGate;
  sandboxOptions?: { enabled: boolean };
  /**
   * Directory for the native Claude-shaped session transcript
   * (`<sessionDir>/projects/<encoded-cwd>/<agentId>.jsonl`). Default `~/.theokit`.
   * Set to `~/.claude` to write sessions the Claude Code CLI can `--continue`.
   *
   * **This is not the working directory** — that is {@link LocalOptions.cwd},
   * four lines above. Only transcripts are written here.
   *
   * Introduced in #301 as the unambiguous name for what `baseDir` always meant.
   */
  sessionDir?: string;

  /**
   * @deprecated Renamed to {@link LocalOptions.sessionDir} (#301). Still honoured,
   * and `sessionDir` wins when both are set.
   *
   * "Base directory" reads as the directory the agent works in, sitting in an
   * interface whose `cwd` is the one that actually means that. Setting it to
   * `"./"` — which is what the name invites — runs without error and writes
   * `./projects/<encoded-cwd>/<agentId>.jsonl` into the caller's repository root.
   * Nothing warns, because nothing is wrong from the code's point of view.
   */
  baseDir?: string;
  /**
   * SE41 — inject an external {@link import("./session-store.js").SessionStore}
   * (Postgres / Redis / KV / durable object) as the PRIMARY session store and
   * resume source. Omit for the default FS transcript store (`baseDir` above) —
   * byte-identical to SE40. Use this for serverless (ephemeral FS) or multi-host /
   * multi-pod deployments where a resumed agent must read its history from a shared
   * store instead of local disk. The records stay the native Claude-shaped shape,
   * so `--continue` interop is preserved (a store may also mirror to `~/.claude`).
   */
  sessionStore?: import("./session-store.js").SessionStore;
}

/**
 * Repo to clone into a cloud agent's VM.
 *
 * @public
 */
export interface CloudRepo {
  url: string;
  startingRef?: string;
  prUrl?: string;
}

/**
 * Cloud execution environment.
 *
 * @public
 */
export interface CloudEnv {
  type: "cloud" | "pool" | "machine";
  name?: string;
}

/**
 * Cloud agent configuration.
 *
 * @public
 */
export interface CloudOptions {
  env?: CloudEnv;
  repos?: CloudRepo[];
  workOnCurrentBranch?: boolean;
  autoCreatePR?: boolean;
  skipReviewerRequest?: boolean;
  /**
   * Short-lived credentials scoped to the agent. Encrypted at rest, deleted
   * with the agent. Names must not start with `THEOKIT_`.
   */
  envVars?: Record<string, string>;
}

/**
 * Subagent definition. The parent agent spawns these via its Agent tool.
 *
 * @public
 */
export interface AgentDefinition {
  description: string;
  prompt: string;
  /**
   * Absolute path to the `.md` this subagent was read from, when it came from disk.
   *
   * ABSENT for a subagent declared in code through {@link AgentOptions.subagents} — "you passed
   * this one in" is a different fact from "read from disk", and one value for both would trade one
   * silence for another.
   *
   * It exists so a listing can answer which root a subagent came from, which
   * usetheokit/theokit-sdk#524 asks for by name: a consumer could not tell that an agent arrived
   * from `.claude/agents/` rather than its own directory, and silent inheritance is what made that
   * take a debugging session to notice. `HookCommand.sourcePath` and `Skill.source` already
   * answered it for the other two surfaces.
   */
  source?: string;
  model?: ModelSelection | "inherit";
  mcpServers?: Array<string | Record<string, McpServerConfig>>;
  /**
   * Tool whitelist (M4-6). When set, the sub-agent may ONLY call tools whose
   * canonical (post-repair, lowercase) name is in this list — any other tool
   * call is vetoed at dispatch via the same `withToolWhitelist` enforcement
   * forks use (NOT `PermissionEngine`). Absent/empty → unscoped (inherits the
   * parent's full toolset). Apply with `withSubagentToolScope`.
   */
  tools?: string[];
  /**
   * Per-subagent shell sandbox toggle. When `true`, the spawned child runs with
   * `local.sandboxOptions.enabled = true` (the SDK's boolean shell sandbox). Absent
   * ⇒ inherit the parent's sandbox posture. The SDK has no granular sandbox *mode*
   * (read-only / workspace-write / danger); a mode string in the disk frontmatter is
   * a typed load error, not a silent boolean coercion. Reasoning effort is NOT a
   * field here — it rides inside `model.params` (e.g. `[{ id: "thinking", value: "low" }]`).
   */
  sandbox?: boolean;
}

/**
 * Public view of a recalled memory fact exposed to the system-prompt resolver.
 *
 * @public
 */
export interface SystemPromptMemoryFact {
  text: string;
}

/**
 * Context passed to a {@link SystemPromptResolver}. Field order is a
 * compatibility contract: new fields are appended, never reordered.
 *
 * @public
 */
export interface SystemPromptContext {
  agentId: string;
  cwd: string | undefined;
  model: ModelSelection | undefined;
  skills: ReadonlyArray<SystemPromptSkillRef>;
  userMessage: string;
  /** Recalled durable facts when memory is enabled. Appended in v1.1. */
  memory: ReadonlyArray<SystemPromptMemoryFact>;
}

/**
 * Resolver function that produces the system prompt dynamically. Receives
 * the {@link SystemPromptContext} and returns a string (or a Promise of one).
 *
 * The SDK does NOT impose a timeout on the resolver — wrap your own
 * `Promise.race` if you call into slow resources. Errors propagate to the
 * caller of `agent.send()`.
 *
 * @public
 */
export type SystemPromptResolver = (ctx: SystemPromptContext) => string | Promise<string>;

/**
 * Skills configuration accepted by `Agent.create()` via
 * {@link AgentOptions.skills}.
 *
 * Skills are discovered from `.theokit/skills/<name>/SKILL.md` when
 * `local.settingSources` includes `"project"`.
 *
 * @public
 */
export interface SkillsSettings {
  /**
   * Names of skills the parent agent may invoke. When omitted, every
   * discovered skill is enabled.
   */
  enabled?: string[];
  /**
   * Whether the SDK auto-injects the loaded skill list (name + description) as a
   * `<skills>` block in the LLM system prompt. Default `true`.
   *
   * Set to `false` when supplying a custom `systemPrompt` resolver that formats
   * skills itself.
   */
  autoInject?: boolean;
  /**
   * M22 — discover skills from a CUSTOM directory (containing `<name>/SKILL.md`) instead of the
   * default `<cwd>/.theokit/skills`. Absent ⇒ the default root.
   */
  skillsDir?: string;
  /**
   * M22 — code-defined skills (from `createSkill`) merged with the discovered ones. An inline skill
   * overrides a discovered file skill of the same name.
   */
  inline?: import("../create-skill.js").InlineSkill[];
}

/**
 * SE22 — context passed to a {@link SkillsResolver}. Mirrors
 * {@link SystemPromptContext} MINUS `skills`: the resolver runs BEFORE skills
 * are assembled, so the resolved list does not exist yet.
 *
 * @public
 */
export interface SkillsResolverContext {
  agentId: string;
  /** Workspace cwd. `string | undefined` mirrors {@link SystemPromptContext}; a local agent always passes a concrete path. */
  cwd: string | undefined;
  model: ModelSelection | undefined;
  userMessage: string;
  /** Recalled durable facts when memory is enabled. */
  memory: ReadonlyArray<SystemPromptMemoryFact>;
}

/**
 * SE22 — a resolver that produces {@link SkillsSettings} per run from runtime
 * context (e.g. the user's role). Mirrors the {@link SystemPromptResolver}
 * pattern: evaluated per `send()` BEFORE skill assembly, so a cached
 * `getOrCreate` agent re-resolves on every run.
 *
 * The SDK imposes NO timeout — wrap your own `Promise.race` for slow sources. A
 * throwing resolver fails the run (no silent fallback — Rule 8). Cloud agents
 * reject a function resolver (it can't run on PaaS); resolve to a static
 * {@link SkillsSettings} object before `Agent.create()`.
 *
 * @public
 */
export type SkillsResolver = (
  ctx: SkillsResolverContext,
) => SkillsSettings | Promise<SkillsSettings>;

/**
 * Memory configuration accepted by `Agent.create()` via {@link AgentOptions.memory}.
 *
 * Persists durable facts under `.theokit/memory/<namespace>/<scope>-<userId>.json`.
 *
 * @public
 */
export interface MemorySettings {
  enabled: boolean;
  namespace?: string;
  userId?: string;
  scope?: "agent" | "user" | "team";
  storePath?: string;
  /**
   * Where this agent's memory lives. Default `<cwd>/.theokit/memory`.
   *
   * Must be an absolute path or start with `~/` — a relative value is refused rather than
   * resolved, because the two plausible bases put the store in two different places.
   *
   * Point it at `~/.claude/projects/<encoded-cwd>/memory` to WRITE where the Claude Code CLI
   * reads. That store is READ unconditionally either way, so setting this is only needed to
   * share the writes.
   */
  directory?: string;
  /**
   * Whether the SDK auto-injects recalled facts as a `<memory>` block in the
   * LLM system prompt. Default `true`.
   */
  autoInject?: boolean;
  /**
   * Index + tools configuration (memory-system-peer-project-parity).
   *
   * When `tools !== false`, the SDK registers `memory_search` and
   * `memory_get` with the LLM. Backed by SQLite + FTS5 (and sqlite-vec
   * when an embedding provider is configured).
   */
  index?: {
    /** Whether to register `memory_search` + `memory_get` tools. Default `true`. */
    tools?: boolean;
    /**
     * Vector index backend (ADR D43). Default `"sqlite-vec"`. Set to
     * `"lance"` to use `@lancedb/lancedb` (optional peer dep) for scale.
     */
    backend?: "sqlite-vec" | "lance";
    /** Embedding provider config. When omitted, the index runs in FTS-only mode. */
    embedding?: {
      provider: "openai" | "mistral" | "openrouter" | "voyage" | "deepinfra";
      model?: string;
    };
  };
  /**
   * Active Memory blocking recall (Phase 7). When `enabled: true`, runs
   * before each `send()` and prepends an `<active-memory>` block.
   */
  activeRecall?: {
    enabled?: boolean;
    queryMode?: "message" | "recent" | "full";
    timeoutMs?: number;
    maxSummaryChars?: number;
    persistTranscripts?: boolean;
  };
}

// T4.1 / D438 — `CustomTool` moved to `./agent-prims.ts` (leaf file) and
// re-exported at the top of this module. Inline `import("./agent.js")` self-
// references that previously triggered madge self-cycle #3 have been removed
// in this same slice.

/**
 * Telemetry configuration for an agent. When `enabled: true`, the SDK emits
 * OpenTelemetry spans for `agent.send`, `llm.call`, `tool.call`, and
 * `memory.search`. See ADR D34.
 *
 * Privacy: content (prompts, responses, tool args) is OMITTED by default —
 * only timing/counts/IDs are recorded. Opt in via `includeContent: true`
 * to add prompt/response/args events to the spans (consumer's
 * responsibility to sanitize PII).
 *
 * `@opentelemetry/api` is an OPTIONAL peer dependency — declared, so your package manager can
 * tell you the version range, and not installed for you. Without it, telemetry is a NO-OP even
 * when `enabled: true`: the tracer is loaded lazily inside a try/catch, so nothing throws and
 * nothing is recorded. A run that reports no spans with `enabled: true` is almost always this,
 * not a misconfigured collector.
 *
 * @public
 */
export interface TelemetrySettings {
  /** Master switch. Default `false`. */
  enabled: boolean;
  /** Whether to include prompts/responses/tool args as span events. Default `false`. */
  includeContent?: boolean;
  /** Exporter selection. Default `"console"`. Custom exporters are passed-through. */
  exporter?: "console" | "otlp" | unknown;
  /** Service name on emitted spans. Default `"theokit-sdk"`. */
  serviceName?: string;
  /**
   * Auto-detect and register OTel exporters for installed observability
   * libs (Langfuse, Sentry, PostHog) via `createRequire` feature-detect.
   * Default `true`. See ADR D42.
   */
  autoDetect?: boolean;
  /**
   * Per-adapter opt-out. Lowercase names: `"langfuse" | "sentry" | "posthog"`.
   * Default `[]`.
   */
  disable?: string[];
}

/**
 * Top-level options accepted by `Agent.create()`.
 *
 * Pass either `local` or `cloud` to pick a runtime.
 *
 * @public
 */
export interface AgentOptions {
  /**
   * The model to run. SE8 — accepts a bare-string id shorthand
   * (`"openai/gpt-4o-mini"`, normalized to `{ id }`) OR a {@link ModelSelection}
   * object (use the object form to pass `params`).
   */
  model?: string | ModelSelection;
  /** Falls back to `THEOKIT_API_KEY`. */
  apiKey?: string;
  name?: string;
  /**
   * When `true`, `Agent.prompt` (and any helper that goes through `run.wait()`)
   * rejects with `AgentRunError` instead of resolving with `{ status: 'error' }`.
   * Cancelled runs (`status: 'cancelled'`) still resolve — cancel ≠ error.
   * If `result.error` is undefined despite `status: 'error'` (malformed RunResult),
   * the defensive guard resolves normally (no throw).
   *
   * Default `false` (backwards-compatible).
   *
   * @public
   */
  throwOnError?: boolean;
  /**
   * System prompt for the agent. Either a plain string or a resolver
   * function that receives the {@link SystemPromptContext} and returns the
   * prompt dynamically. Override per-call via {@link SendOptions.systemPrompt}.
   *
   * Subagents do NOT inherit this — they use {@link AgentDefinition.prompt}.
   */
  systemPrompt?: string | SystemPromptResolver;
  local?: LocalOptions;
  cloud?: CloudOptions;
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * M77 — how long an MCP client lives.
   *
   * `'run'` (DEFAULT, and the historical behaviour) spawns a client per `send` and drops it when the
   * run ends. `'session'` pools clients per `(agentId, server, config)` and keeps them across turns,
   * which keeps the MCP runtime alive across turns. Measured cost of the per-run path: 193 / 138 / 134 ms of spawn + handshake on
   * every turn.
   *
   * Opt-in rather than default because it changes the FAILURE model: a server that dies mid-session
   * becomes a reachable state. One-shot and cron runs gain nothing from pooling and would pay that
   * risk, so they keep `'run'` unless they ask otherwise.
   */
  mcpLifecycle?: "run" | "session";
  agents?: Record<string, AgentDefinition>;
  agentId?: string;
  /** Context manager configuration. See `agent.context`. */
  context?: ContextSettings;
  /** Provider routing configuration. See `agent.providers`. */
  providers?: ProviderRoutingSettings;
  /**
   * Plugins for this agent, in one of two forms:
   *
   * - **Named-enable settings** — `{ enabled: ["name", ...] }`. Selects which
   *   file-discovered plugin providers (under `.theokit/plugins/`) are active.
   *   Plugin sources must also be active via `local.settingSources`.
   * - **Code `Plugin` objects** — an array of `Plugin` instances, e.g.
   *   `plugins: [Handoff.asPlugin({ ... })]`. These are registered directly by
   *   the runtime (`extractCodePlugins`); no `settingSources` entry is needed.
   *
   * The two forms are mutually exclusive — pass one or the other.
   */
  plugins?: PluginsSettings | readonly Plugin[];
  /**
   * SE1 — the default permission mode for this agent's runs, threaded to a
   * registered `PermissionPlugin`'s pre-tool gate. A per-send
   * `SendOptions.permissionMode` overrides it. Absent ⇒ the plugin's own
   * construction-time mode applies. Local runtime.
   */
  permissionMode?: PermissionMode;
  /**
   * Skills configuration. Either a static {@link SkillsSettings} object or —
   * SE22 — a {@link SkillsResolver} evaluated per `send()` to pick skills from
   * runtime context (e.g. user role). A cached agent re-resolves each run. The
   * agent-scoped `agent.skills` handle reflects the STATIC/base config; the
   * resolver drives the per-send `<skills>` block.
   */
  skills?: SkillsSettings | SkillsResolver;
  /**
   * SE24 — guardrail processors. `inputProcessors` run in order before the LLM
   * (normalize / validate / block / rewrite the user message); `outputProcessors`
   * run on the model's final text before it reaches the caller (redact / block).
   * A processor that `abort()`s stops the run with a {@link RunResult.tripwire}
   * (+ a `tripwire` run-event). Empty/absent ⇒ unchanged behavior. See
   * {@link Processor}.
   */
  inputProcessors?: readonly import("./processors.js").Processor[];
  outputProcessors?: readonly import("./processors.js").Processor[];
  /** Memory configuration. Persists durable facts; auto-recalled on send. */
  memory?: MemorySettings;
  /**
   * Inline custom tools. Local runtime only — cloud agents reject any non-empty
   * `tools` array. Handlers are not persisted; pass them again on resume.
   * See {@link CustomTool}.
   */
  tools?: CustomTool[];
  /**
   * Builtin tools this agent must NOT declare to the model. Absent or empty ⇒ every builtin the
   * rest of the configuration would register is declared, exactly as before this option existed.
   *
   * WHY WITHHOLDING IS NOT THE SAME AS DENYING. A consumer that cannot allow `shell` — because it
   * reaches outside their own sandbox scope — can already refuse the call in a `pre_tool_call` hook
   * or with a {@link PermissionEngine} deny rule. That stops the execution and pays for the offer
   * twice over: the schema rides in EVERY request of EVERY round (measured at 267 characters for
   * `shell`, 1,462 for `memory_search` + `memory_get` together — usetheokit/theokit-sdk#381), and
   * the model can spend a whole round discovering a refusal it had no way to anticipate. Declaring
   * a tool that is guaranteed to be refused is the wrong shape; withholding removes it from the
   * catalog, so the model is never offered what it cannot have.
   *
   * WITHHOLDING RELEASES THE NAME. `withheldBuiltinTools: ["shell"]` lets {@link AgentOptions.tools}
   * declare a tool called `shell` without the `tool_reserved_name` error — the reservation exists to
   * stop a collision with the SDK's own tool, and there is no longer one to collide with. Every
   * builtin still declared stays reserved.
   *
   * This governs DECLARATION, not authorization. A withheld builtin is simply absent from the
   * catalog: a model that invents the name anyway gets `Unknown tool <name>` (exit 127) rather than
   * an execution, but nothing here evaluates a policy. Keep the deny rule if you need one that a
   * per-send `tools` override cannot reopen.
   *
   * @public
   */
  withheldBuiltinTools?: readonly BuiltinToolName[];
  /**
   * SE37 — opt-in reasoning. When `true`, the agent gets a chain-of-thought
   * preamble prepended to its system prompt AND the `think` reasoning tool
   * auto-attached, turning a non-reasoning model into a reason -> act ->
   * observe loop (same model; reuses the existing tool loop). Default `false` —
   * byte-identical behaviour when unset. Inert (with a one-time warn) when a
   * native reasoning model is configured (`model.params: [{ id: "thinking" }]`),
   * so native and prompt-based reasoning never stack. See `ReasoningTools` in `@theokit/sdk-tools`.
   */
  reasoning?: boolean;
  /**
   * Telemetry (OpenTelemetry) configuration. Default disabled. See
   * {@link TelemetrySettings} and ADR D34.
   */
  telemetry?: TelemetrySettings;
  /**
   * Arbitrary metadata bag for caller-supplied provenance. Currently used by
   * the fork primitive (ADR D114) to tag `metadata.forkOrigin` and
   * `metadata.parentAgentId` so memory writes downstream can be attributed.
   *
   * Not persisted to the agent registry — informational only at runtime.
   *
   * @public
   */
  metadata?: Record<string, unknown>;
  /**
   * Default `MemoryContext` for third-party memory adapter plugins
   * (ADR D141). When set, `pre_user_send` / `post_assistant_reply`
   * hooks receive this context unless the caller overrides it. The
   * `agent.memory` direct API also defaults to it.
   *
   * @public
   */
  memoryContext?: import("./memory-adapter.js").MemoryContext;
  /**
   * Maximum byte length of the `<memory-context>` block injected by
   * `pre_user_send` adapter hooks (EC-A). Larger recalls are sliced
   * with `…[truncated]`. Default 16_000 (~4k tokens). Set lower for
   * cheaper turns; higher for longer-context models.
   *
   * @public
   */
  maxRecallContextBytes?: number;
  /**
   * Declarative handoff destinations (Adoption Roadmap #4; ADRs D214-D229).
   * Each entry is either a raw `SDKAgent` (auto-wrapped with defaults) OR a
   * `HandoffDescriptor` from `Handoff.create(target, opts?)`.
   *
   * Runtime injects synthetic `transfer_to_<receiver.name>` tools per
   * destination (D214/D215). When the LLM invokes one, the receiver takes
   * over the next turn (peer-to-peer, D217).
   *
   * @public
   */
  // SDK 2.0 split (Phase 4): handoff-descriptor.ts moved to @theokit/sdk-handoff.
  // The handoffs field is TRANSITIONAL — preferred 2.x pattern is
  // `plugins: [Handoff.asPlugin({ targets: [...] })]` (see migration guide).
  // Type loosened to `unknown` here because the kernel must not import from
  // an extension; consumers using this option must have @theokit/sdk-handoff
  // installed (optional peer — see agent.ts maybeInjectHandoffTools).
  // EC-4 absorbed in plan v1.1 removes this field entirely in Phase 6 cohort.
  handoffs?: ReadonlyArray<SDKAgent | unknown>;
  /**
   * Maximum chain depth across handoffs per `agent.send()` call (D218).
   * Default 5. Exceeding throws `HandoffLoopError`. Set to 0 to disable
   * the handoff tools entirely (EC-8 / handoffs never fire).
   *
   * @public
   */
  maxHandoffDepth?: number;
  /**
   * Production-Readiness #6 — quota / abuse gates (ADRs D322-D323).
   *
   * `onBeforeCreate` fires BEFORE the agent is registered or persisted —
   * throw to block creation. `onBeforeSend` fires BEFORE each `agent.send`
   * (after `pre_user_send` adapter hooks, before any LLM call or storage
   * write) — throw to block the send.
   *
   * Unlike `onTool*` (observation), these hooks are BLOCKERS — errors
   * propagate as rejection on `Agent.create` / `agent.send`. Use them for
   * per-user conversation caps, per-conversation message caps, abuse
   * detection.
   *
   * @public
   */
  onBeforeCreate?: (event: { conversationId: string; userId?: string }) => Promise<void> | void;
  /**
   * Fires before each `agent.send`. `previousMessageCount` is the count of
   * messages already persisted BEFORE the current send adds the user
   * message. Throw to block.
   *
   * @public
   */
  onBeforeSend?: (event: {
    conversationId: string;
    previousMessageCount: number;
  }) => Promise<void> | void;
  /**
   * Production-Readiness #4 — tool lifecycle hooks (ADRs D315-D317).
   *
   * `onToolStart` fires BEFORE the handler runs. `onToolEnd` fires after a
   * successful handler return. `onToolError` fires when validation fails OR
   * the handler throws — `event.error` is always an `Error` instance.
   *
   * Hook errors are SWALLOWED with a stderr warn (do not abort the run).
   * The `callId` is unique per tool invocation and identical across the
   * start/end (or start/error) pair, so consumers can correlate.
   *
   * Use cases: cost tracking, audit logs, per-tool retry/alerting,
   * latency telemetry.
   *
   * @public
   */
  onToolStart?: (event: {
    toolName: string;
    args: unknown;
    conversationId: string;
    callId: string;
  }) => void | Promise<void>;
  /** Fires when a tool handler returns successfully. */
  onToolEnd?: (event: {
    toolName: string;
    args: unknown;
    result: unknown;
    conversationId: string;
    callId: string;
    durationMs: number;
  }) => void | Promise<void>;
  /**
   * Fires when a tool handler throws OR schema validation rejects the args.
   * `event.error` is always an `Error` instance (D315/EC-6 — validation
   * reasons are wrapped in `new Error(reason)`).
   *
   * `attempt` is always `1` in v1 (D317 — reserved for future retry policy).
   */
  onToolError?: (event: {
    toolName: string;
    args: unknown;
    error: Error;
    conversationId: string;
    callId: string;
    durationMs: number;
    attempt: number;
  }) => void | Promise<void>;
  /**
   * Pluggable budget/usage tracker (SDK 2.0 Phase 2 / T2.1 — ADR D1 interface
   * inversion). When provided, the agent loop calls `tracker.track(...)`
   * after each LLM completion and `tracker.check()` before each iteration.
   *
   * **Runtime enforcement is live.** Verified against the call graph on
   * 2026-09-01: `internal/agent-loop/loop.ts:78-81` reads the tracker and
   * gates the iteration through `evaluateBudgetGate`, `:110` calls
   * `nextIteration()`, and `:390`/`:397` call `track(...)` per completion;
   * the option reaches the loop from `AgentOptions` at
   * `internal/local-agent/real-local-run.ts:342`.
   *
   * This paragraph previously said the opposite — "wired to the type surface
   * only ... NOT runtime enforcement" — and it was wrong in the expensive stale-claim-ok: verbatim quote of the corrected text
   * direction: a consumer reading the published `.d.ts` was told the SDK would
   * not enforce their cost ceiling, so the rational response was to build a
   * second control outside it, or to stop trusting the option.
   *
   * Default impls available today via `@theokit/sdk`:
   *   - `createCounterBudgetTracker({ maxTokens, maxIterations })`
   *
   * Future: post-Phase-2, `@theokit/sdk-budget` ships a richer impl with
   * USD pricing.
   *
   * @public
   */
  budgetTracker?: BudgetTracker;

  /**
   * Pluggable memory subsystem (SDK 2.0 Phase 1 / T1.3 — Hexagonal
   * Architecture interface inversion). When provided, the agent loop
   * calls `provider.init(...)` once per agent, surfaces tools from
   * `provider.buildTools(...)` to the LLM, runs `provider.runActivePass(...)`
   * pre-LLM to inject recalled facts, and `provider.dispose(...)` on
   * Agent shutdown.
   *
   * **Runtime enforcement is live.** Verified against the call graph on
   * 2026-09-01: `internal/agent-loop/loop-context-init.ts:95` calls
   * `provider.init(...)`, `:129` surfaces `provider.buildTools(...)` to the
   * model, `:166` runs `provider.runActivePass(...)`, and
   * `internal/agent-loop/loop.ts:176`/`:204` call `sync` and `dispose`.
   *
   * This paragraph previously said the opposite — "wired to the type surface
   * only ... NOT runtime enforcement". A stale "not implemented yet" note on a stale-claim-ok: verbatim quote of the corrected text
   * `@public` symbol is worse than no note: it is believed, it survives the
   * work it describes, and nothing in this repo compares such a claim against
   * the call graph.
   *
   * Default impls available today via `@theokit/sdk`:
   *   - `createNoopMemoryProvider()` — degenerate fallback / worked example
   *
   * Future: post-Phase-1, `@theokit/sdk-memory` ships a rich impl with
   * LanceDB / embeddings / circuit breaker / active-memory cache.
   *
   * @public
   */
  memoryProvider?: MemoryProvider;
}

/**
 * Metadata returned by `Agent.list()` and `Agent.get()`.
 *
 * @public
 */
export type SDKAgentInfo = {
  agentId: string;
  name: string;
  summary: string;
  lastModified: number;
  status?: "running" | "finished" | "error";
  createdAt?: number;
  archived?: boolean;
} & (
  | { runtime?: undefined }
  | { runtime: "local"; cwd?: string }
  | {
      runtime: "cloud";
      env?: CloudEnv;
      repos?: string[];
    }
);

/**
 * theokit#123 — one tool of a registered agent, as a reflection surface sees it.
 *
 * A projection, not the `CustomTool` itself: the handler is an executable that cannot cross a
 * process boundary and has no meaning to a caller enumerating a registry.
 *
 * @public
 */
export interface AgentToolDescription {
  name: string;
  description: string;
  /** The JSON Schema sent to the model verbatim — the tool's callable signature. */
  inputSchema: Record<string, unknown>;
}

/**
 * theokit#123 — one subagent of a registered agent (what theokit-studio calls a workflow).
 *
 * `prompt` is deliberately absent. Enumeration asks what a subagent IS and what it may call; its
 * system prompt is instructions, not signature, and a reflection endpoint that serializes it
 * publishes the agent's behaviour to anyone who can reach the endpoint.
 *
 * @public
 */
export interface AgentSubagentDescription {
  /** The key under `AgentOptions.agents` — how the parent addresses it. */
  name: string;
  description: string;
  /** `"inherit"` (or absent) means it runs on the parent's model. */
  model?: ModelSelection | "inherit";
  /** Tool whitelist, when the subagent is scoped to a subset of the parent's tools. */
  tools?: string[];
}

/**
 * theokit#123 — the read-only introspection of a registered agent, returned by `Agent.describe()`.
 *
 * `Agent.list()` / `Agent.get()` enumerate agents and `agent.skills.list()` covers skills; this
 * fills the remaining gap, so a reflection endpoint can report the live registry instead of
 * degrading to empty lists.
 *
 * `tools` and `subagents` are always arrays — never `undefined` — so a caller can distinguish
 * "this agent has none" from "the SDK did not say".
 *
 * @public
 */
export interface AgentDescription {
  agentId: string;
  /** Inlined rather than imported from the registry contract: `types/` stays a leaf (theokit#146). */
  runtime: "local" | "cloud";
  model?: ModelSelection;
  /**
   * The agent's DECLARED tool catalog.
   *
   * Plugin-contributed tools and the internal `think` tool (added when `reasoning` is on) are
   * assembled per run and are not knowable from the registry, so they are absent here. Stated
   * rather than implied: a reflection endpoint should not present this as the complete runtime set.
   */
  tools: readonly AgentToolDescription[];
  /**
   * Every subagent the runtime would resolve — file-based roles from `.theokit/agents/*.md` merged
   * with the inline `agentOptions.agents`, the same set `loadSubagents` builds for a run.
   */
  subagents: readonly AgentSubagentDescription[];
}

/**
 * Options for `Agent.list()`.
 *
 * `limit`/`cursor` paginate (B-115): a `limit` bounds the page and, when more agents remain,
 * `ListResult.nextCursor` is set — pass it back as `cursor` for the next page. Omitting `limit`
 * returns every matching agent in one page, unpaginated, exactly as before (M107 declared imposing
 * pagination order unconditionally a breaking change to every caller's observed order; pagination
 * here is opt-in and only reorders the page it returns, never the unlimited default).
 *
 * @public
 */
export type ListAgentsOptions = {
  limit?: number;
  cursor?: string;
} & (
  | { runtime?: undefined }
  | { runtime: "local"; cwd?: string }
  | {
      runtime: "cloud";
      // B-115 — `prUrl` removed 2026-08-19. Filtering by a repo's PR URL would need the registry
      // to retain `prUrl` per repo across process restarts, which the on-disk schema
      // (`agent-registry-store.ts`) does not today — a persistence/migration change, not an
      // option-wiring fix. `prUrl` was accepted and silently ignored before this — removed rather
      // than left half-implemented (parsimony ladder rung 1). Re-add when the registry retains it.
      /**
       * Hide archived agents unless `true`. Default `false` (hidden) — B-115, this used to be
       * accepted and silently ignored; every archived agent was always included.
       */
      includeArchived?: boolean;
      apiKey?: string;
    }
);

/**
 * Options for `Agent.get()`.
 *
 * `cwd` (default `process.cwd()`) selects which workspace's on-disk registry to hydrate before the
 * lookup — same rule `Agent.list` uses (B-115; this used to be accepted and silently ignored).
 *
 * @public
 */
export interface GetAgentOptions {
  cwd?: string;
  apiKey?: string;
}

/**
 * Options for `Agent.listRuns()`.
 *
 * `cwd` (default `process.cwd()`) hydrates that workspace's registry before validating the agent
 * exists — same rule as `Agent.get` (B-115). `limit`/`cursor` paginate the SAME way as
 * `Agent.list` — see its doc — except no reordering is ever needed: a single agent's runs are
 * already returned in the stable order they were created.
 *
 * B-115 — `runtime` removed 2026-08-19. A single `agentId` already pins exactly one runtime;
 * filtering an already-single-agent's runs by runtime filtered nothing and was never checked.
 *
 * @public
 */
export interface ListRunsOptions {
  cwd?: string;
  apiKey?: string;
  limit?: number;
  cursor?: string;
}

/**
 * Options for `Agent.getRun()`. Cloud requires the parent `agentId`.
 *
 * @public
 */
export type GetRunOptions =
  | { runtime?: "local"; cwd?: string }
  | { runtime: "cloud"; agentId: string; apiKey?: string };

/**
 * Options for archive/unarchive/delete.
 *
 * @public
 */
export interface AgentOperationOptions {
  cwd?: string;
  apiKey?: string;
}

/**
 * Paginated list shape.
 *
 * @public
 */
export interface ListResult<T> {
  items: T[];
  nextCursor?: string;
}
