// Public API surface for @theokit/sdk.
//
// Single source of truth for the contract: the exported types below.
// Locked names: see CLAUDE.md.

// Agent façade
export { Agent, type AgentPromptResult } from "./agent.js";
// DX helpers — agent construction patterns (ADR D22-D26)
export { AgentBuilder } from "./agent-builder.js";
export { AgentFactory } from "./agent-factory.js";
// SE9 — integrated structured output on `agent.generate(input, { output })`.
export type { GenerateOptions, GenerateRunResult } from "./agent-generate.js";
export {
  type ApprovalDecision,
  type ApprovalInput,
  type ApprovalMode,
  type ApprovalOutcome,
  type ApprovalReason,
  decideApproval,
} from "./approval-policy.js";
export {
  type BlastRadiusDecision,
  type BlastRadiusInput,
  type BlastRadiusOutcome,
  type BlastRadiusReason,
  type DeclaredAction,
  evaluateBlastRadius,
} from "./blast-radius.js";
// Task observability registry (Adoption Roadmap gap #2; ADRs D361-D374)
// Token budget + cost tracker (Adoption Roadmap gap #1 post-Tasks; ADRs D375-D388)
export {
  Budget,
  chargeAndCheckThresholds,
  computeCost,
  getPricingEntry,
  inferApiMode,
  normalizeUsage,
  preflightCheck,
  UsageAccumulator,
} from "./budget.js";
// SE25 — deterministic in-tree guardrail processors (built on the SE24 seam).
export {
  estimateTokens,
  TokenLimiter,
  type TokenLimiterOptions,
  UnicodeNormalizer,
  type UnicodeNormalizerOptions,
} from "./built-in-processors.js";
// M22 — code-defined inline skills (`createSkill`) usable alongside filesystem skills.
export { type CreateSkillSpec, type InlineSkill, Skill } from "./create-skill.js";
export {
  type CredentialInput,
  type CredentialReport,
  describeCredential,
} from "./credential-presence.js";
// Semantic cache — EXTRACTED to `@theokit/sdk-cache` (SDK 2.0 split, Phase 3 / T3.1).
// Consumers: `import { Cache, CacheInvalidTtlError } from "@theokit/sdk-cache"`.
// Cron façade
export { Cron } from "./cron.js";
export { type DefineProviderOptions, Provider } from "./define-provider.js";
// SE23 — opt-in `skill_read` tool factory (model-facing lazy skill read).
export { SkillReadTool } from "./define-skill-read-tool.js";
export { type DefineToolSpec, Tool } from "./define-tool.js";
export {
  auditEnvReachability,
  type EnvOptOut,
  type EnvReachabilityAudit,
  type EnvReachabilityInput,
} from "./env-reachability.js";
// Errors (runtime classes)
export {
  AgentDisposedError,
  AgentRunError,
  type AgentRunErrorCode,
  AuthenticationError,
  BudgetExceededError,
  ConfigurationError,
  type ErrorCode,
  type ErrorMetadata,
  IntegrationNotConnectedError,
  InvalidTaskIdError,
  isTransientError,
  MemoryAdapterError,
  type MemoryAdapterErrorCode,
  NetworkError,
  RateLimitError,
  TaskNotFoundError,
  TheokitAgentError,
  UnknownAgentError,
  UnsupportedBudgetOperationError,
  UnsupportedRunOperationError,
  UnsupportedTaskOperationError,
} from "./errors.js";
// Infrastructure building blocks (moved from @theokit/theocode — SDK LEGO pieces)
export { EventBus } from "./event-bus.js";
// Structured output via synthetic forced tool (ADR D33). M21 — `structuringModel` on
// GenerateObjectOptions (two-model reason→structure flow).
export {
  GenerateObjectError,
  type GenerateObjectOptions,
  type GenerateObjectResult,
} from "./generate-object.js";
export { GOAL_CONTINUATION_MARKER, type GoalLoopAgent, runGoalLoop } from "./goal-loop.js";
// #57 — tool-result content guard options (SendOptions.toolResultGuard).
export type { ToolResultGuardOptions } from "./internal/agent-loop/tool-result-guard.js";
// BudgetTracker interface (SDK 2.0 Phase 2 / T2.1 foundation — ADR D1).
// Kernel-facing contract for budget/usage tracking. Default impl lives in
// internal/budget/ today; will move to @theokit/sdk-budget in Phase 2.
// Consumers can supply a custom impl via `Agent.create({ budgetTracker })`;
// the loop gates and tracks against it (internal/agent-loop/loop.ts:78, :110, :390).
export type {
  BudgetCheck,
  BudgetTotal,
  BudgetTracker,
  BudgetUsageEvent,
} from "./internal/budget/tracker/budget-tracker.js";
// Reference impl — pure counter, no USD pricing. Consumers can use as a
// fallback before @theokit/sdk-budget ships or as a worked example.
export {
  type CounterBudgetTrackerOptions,
  createCounterBudgetTracker,
} from "./internal/budget/tracker/budget-tracker-counter.js";
// theokit#147 — the diagnostics sink is PUBLIC, because a channel a consumer cannot install is not
// a channel. The original fix routed 92 internal sites through `diag()` and left the installer
// reachable only via `src/internal/diagnostics.js`, so the reported blocker ("a TUI host has no way
// to intercept these") survived a green suite. A host now writes:
//
//     import { setDiagnosticsSink } from "@theokit/sdk";
//     setDiagnosticsSink((message) => myStatusPanel.append(message));   // or `() => {}` for silence
export {
  type DiagnosticsSink,
  setDiagnosticsSink,
} from "./internal/diagnostics.js";
// SE2 — typed runtime event stream (opt-in via SendOptions.onRunEvent).
export { emitRunEvent } from "./internal/emit-run-event.js";
export { JudgeCredentialError } from "./internal/judge/judge-call.js";
// Handoffs — EXTRACTED to `@theokit/sdk-handoff` (SDK 2.0 split, Phase 4 / T4.1).
// Consumers: `import { Handoff, handoffTo, ... } from "@theokit/sdk-handoff"`.
// Transitional: `Agent.create({ handoffs: [...] })` still works while
// @theokit/sdk-handoff is installed (lazy-imported via optional peer model).
// The preferred 2.x pattern is `plugins: [Handoff.asPlugin({ targets: [...] })]`.
// Process-level keyed mutex (SDK 2.0 Phase 2 physical-survey unblock —
// ADR-008). Public utility consumed by extracted packages
// (@theokit/sdk-budget, @theokit/sdk-memory) to share the SAME mutex
// Map registry across package boundaries. Required for ledger.ts
// (sdk-budget) + dreaming/run.ts (sdk-memory) to coordinate writes
// without racing. Stability guarantee: signature stable until sdk-core
// v3.0.
export { withCwdMutex } from "./internal/persistence/cwd-mutex.js";
// Plugin & extension system (v1.8 — ADRs D97-D109)
// EC-Cache absorbed: PreUserSendContext + PostAssistantReplyContext + PreUserSendResult
// added to barrel so extracted packages (sdk-cache, sdk-handoff) can type their
// .asPlugin() factories without reaching into ./internal/plugins sub-path.
export {
  type HookName,
  // #335 — named here because the PUBLIC `Plugin` union references it in the
  // `createProvider` position. The DTS rollup emits an exported type's body but
  // treeshakes a non-exported type that body names, so leaving this out of the
  // barrel published a declaration referring to a type it never declared.
  type MemoryProviderFactory,
  Plugin,
  type PluginContext,
  type PluginHookDisposer,
  type PostAssistantReplyContext,
  type PostToolCallContext,
  type PreToolCallContext,
  type PreToolCallDecision,
  type PreUserSendContext,
  type PreUserSendResult,
  type SessionLifecycleContext,
  // M82 — the transform seam's context. Public because a hook author cannot honour a tool-scoped
  // policy without it, and typing the handler by hand is how the consumer ended up reinventing it.
  type ToolCallSummary,
  type ToolResultTransformContext,
  type TransformContext,
} from "./internal/plugins/types.js";
export type {
  ProviderProfile,
  ProviderTransform,
  ProviderTransformContext,
} from "./internal/providers/types.js";
/**
 * The OPERATOR tier (B-026/B-065).
 *
 * Crosses the barrel so a HOST can read the policy the runtime enforces rather than guessing at it —
 * showing which restrictions are in force, or refusing to start under one it cannot satisfy.
 *
 * It does NOT make this the only reader. `@theokit/agents` ships from a separate repository against a
 * PUBLISHED version of this package, so a symbol added here is not importable there until it is
 * released; it carries its own reader of the same file, and that file's docblock says why. One
 * FORMAT — Claude Code's path and key names — is the contract that must not drift. Two readers that
 * release independently is a consequence of the repository boundary, not a design.
 */
export {
  type ManagedSettings,
  managedSettingsPathFor,
  readManagedSettings,
} from "./internal/runtime/compat/managed-settings.js";
// M42 — auth subsystem (credential store + OAuth engine) is exposed at the dedicated `@theokit/sdk/auth`
// sub-entry (DTS built via tsc), NOT on this barrel: rollup-plugin-dts cannot bundle those modules into the
// main `.d.ts` (same isolation the SDK uses for messages / subscription / sanitize). See `src/auth/index.ts`.
// MemoryProvider port (SDK 2.0 Phase 1 / T1.1 foundation — Hexagonal
// Architecture). Kernel-facing contract for the memory subsystem.
// Default no-op impl ships with sdk; rich impl will ship in
// @theokit/sdk-memory. Consumers opt-in via Agent.create({ memoryProvider });
// the loop drives its full lifecycle (internal/agent-loop/loop-context-init.ts:95,
// :129, :166 and loop.ts:176, :204). Mirrors BudgetTracker pattern.
export type {
  ActiveMemoryPassArgs,
  ActiveMemoryPassResult,
  MemoryProvider,
  MemoryProviderAgentRef,
  MemoryProviderHandle,
  MemoryProviderInitOptions,
  RecordSessionSummaryArgs,
} from "./internal/runtime/memory-glue/memory-provider.js";
// Reference impl — pure no-op, no recall, no tools. Consumers can use
// as fallback before @theokit/sdk-memory ships or as a worked example
// when authoring custom providers.
export { NoopMemoryProvider } from "./internal/runtime/memory-glue/memory-provider-noop.js";
// Live-agent registry (Production-Readiness #2; ADRs D307-D310) — type exports only,
// the runtime singleton is reached via `Agent.registry`.
export type {
  AgentRegistryOptions,
  EvictReason,
  LiveAgentRegistry,
} from "./internal/runtime/registry/live-agent-registry.js";
// #583 — the instrument for "what tools does this agent actually have", which nothing offered. Pure,
// synchronous and credential-free, so a test can assert a role is as narrow as it claims BEFORE the
// agent runs. See the module docblock for why it does not return a bare array.
export {
  type EffectiveToolCatalog,
  effectiveToolNames,
  type UnresolvedToolSource,
} from "./internal/runtime/validation/effective-tools.js";
// The bundled root `.d.ts` has always declared these two as VALUES, because the
// DTS rollup hoists them out of `types/task.ts` along with the task types. The
// runtime bundle emitted neither, so `import { isValidTaskId } from "@theokit/sdk"`
// typechecked and was `undefined` at the call site (#279). Exported here so the
// implementation keeps the promise the types were already making — validating a
// task id before submitting one is a reasonable thing for a consumer to want.
export { isValidTaskId, TASK_RESERVED_PREFIXES } from "./internal/task/task-id.js";
// Telemetry contract (#295). `internal/telemetry/` was not public, so
// @theokit/sdk-memory inlined structural mirrors of these two types with a note
// that they "MUST be replaced with the canonical imports" once sdk exposed them.
// The mirrors had already drifted: theirs narrowed `setAttributes` to reject
// `undefined` values the canonical type accepts, and declared `end()` without the
// `endTime` parameter. Two copies of a contract, diverging quietly — which is the
// whole reason a mirror is a stopgap and not a design.
//
// Types only: erased at build time, so the bundle is unchanged.
export type { OTelSpan, TelemetryHandle } from "./internal/telemetry/tracer.js";
export { JobQueue, type JobQueueOptions } from "./job-queue.js";
export {
  type DeclaredLayer,
  foldLayers,
  LayerOrderError,
  type LayerValues,
  verifyLayerOrdering,
} from "./layer-fold.js";
// Memory subsystem (public surfaces)
export {
  type DreamingSweepOptions,
  type DreamingSweepResult,
  Memory,
} from "./memory.js";
// Memory adapter helpers (ADR D141)
export { extractRawId, mkMemoryId } from "./memory-adapter-helpers.js";
// Migration helper (ADR D44) — re-exported for use by the bin CLI.
export {
  type MigrateOptions,
  type MigrateResult,
  migrateSqliteToLance,
} from "./migrate.js";
export {
  applyMode,
  type PermissionAction,
  PermissionEngine,
  type PermissionEngineOptions,
  type PermissionMode,
  type PermissionRule,
} from "./permission-engine.js";
/**
 * B-039 / B-040 — the two tiers no permission rule and no mode can reach.
 *
 * Exported because a caller that dispatches tools must be able to consult them: a floor nobody can
 * call is the opt-in guard these items exist to replace.
 */
export {
  isInside,
  type PermissionFloorContext,
  permissionFloorReason,
} from "./permission-floors.js";
// M7-5: PermissionEngine -> plugin veto exemplar. SE1: mode layer + canUseTool gate.
export {
  type PermissionGate,
  type PermissionGateContext,
  type PermissionGateDecision,
  PermissionPlugin,
  type PermissionPluginOptions,
} from "./permission-plugin.js";
/**
 * B-058 — the permission rule LANGUAGE, so a policy is data an operator ships rather than a function
 * somebody compiled in.
 */
export {
  type PermissionRuleSet,
  parsePermissionRules,
} from "./permission-rules.js";
export {
  loadProjectEnv,
  SOVEREIGN_ENV_KEYS,
  type SovereignEnvKey,
} from "./project-env.js";
export {
  type KeepReason,
  type KeptArtifact,
  planReaping,
  type ReapableArtifact,
  type ReapPlan,
  type ReapPlanInput,
  type RetentionPolicy,
  RetentionPolicyError,
} from "./reap-plan.js";
// M23 — schema normalizer (Zod default; JSON Schema / ArkType / Valibot adapters).
export { type NormalizedJsonSchema, normalizeSchema } from "./schema-normalizer.js";
// Personality presets (Hermes #26, ADRs D160-D169)
// `PersonalityPreset` is declared in `types/agent.ts` and reaches consumers
// via the `types/*` star export below. The runtime registry class lives in
// `internal/` because it owns filesystem I/O — public access is via the
// `Agent.usePersonality(...)` method, not direct construction.
// Security namespace (secret redaction; ADR D68)
export { Security } from "./security.js";
export { applySecurityFloor, type SecurityFloorInput } from "./security-floor.js";
export {
  guardSessionDestruction,
  LiveSessionError,
  type LiveSessionReason,
} from "./session-guard.js";
// #546 — the history of a session the host is not holding an Agent for. `transcript()` serves a
// live agent; re-rendering a RESUMED session needs the messages before there is one to ask.
export { type ReadSessionMessagesOptions, readSessionMessages } from "./session-messages.js";
// M3 #62 — scoped session state helpers (app:/user:/temp:).
export { type SessionScope, scopedConversationId, sessionScopePrefix } from "./session-scope.js";
// Squad — sequential multi-agent team (composes Workflow+agentStep; cross-val Gap 1)
export { Squad, type SquadOptions, type SquadRun } from "./squad.js";
// Path safety primitives (ADRs D79-D85) live at `@theokit/sdk/path-safety`,
// not on the main barrel. That dedicated sub-export keeps the DTS bundle
// for `index.ts` decoupled from the `internal/runtime` graph (which has
// a known import cycle `types/agent.ts ↔ fork-agent.ts` that rollup-plugin-dts
// trips on whenever a path-guard symbol reaches into the main bundle).
// Streamed structured output (ADR D39)
export {
  type DeepPartial,
  StreamObjectError,
  type StreamObjectEvent,
  type StreamObjectOptions,
} from "./stream-object.js";
export { Task, type TaskConfigureOptions, type TaskWorkContext, type TaskWorkFn } from "./task.js";
// Subscription primitives (G8 — ADRs D422-D429) live at the dedicated
// `@theokit/sdk/subscription` sub-export to keep them off the main `index.ts`
// DTS bundle (same isolation pattern as `path-safety` per tsup.config.ts
// header comment — the agent.ts ↔ fork-agent.ts cycle trips rollup-plugin-dts
// whenever a sub-entry reaches into `internal/runtime`).
// Consumers: `import { Subscription, tracked, subscribe } from "@theokit/sdk/subscription"` (SE36 — Subscription.create).
// Theokit namespace
export { Theokit, type TheokitRequestOptions } from "./theokit.js";
export {
  describeAction,
  type WithBlastRadius,
  withBlastRadius,
} from "./tool-blast-radius.js";
// SE7 — ToolError (thrown from a tool handler; own module for the G8 LoC budget).
export { ToolError } from "./tool-error.js";
// Trajectory export (ADR D139) — opt-in ShareGPT converter
export { toShareGptTrajectory } from "./trajectory-helpers.js";
export {
  resolveTrustPosture,
  type TrustLevel,
  type TrustPosture,
  type TrustPostureInput,
  type TrustSource,
} from "./trust-posture.js";
// CustomTool type — explicit re-export so rollup-dts surfaces it in the
// bundled .d.ts (the `export type *` indirection through `./types/index.js`
// does not propagate to the rollup-dts output reliably). Needed by extracted
// packages that author custom tools (e.g., @theokit/sdk-tools).
// theokit#123 — the shape `Agent.describe()` returns, so a reflection endpoint can name it.
export type {
  AgentDescription,
  AgentOperation,
  AgentSubagentDescription,
  AgentToolDescription,
  CustomTool,
  SDKAgent,
} from "./types/agent.js";
// SE7 — structured/multimodal tool-result content blocks (explicit for rollup-dts).
export type { ImageBlock, ToolResultContentBlock } from "./types/content-blocks.js";
// M80 — `JudgeResult` and `Verdict` become public.
//
// They were `internal/`, so a consumer wanting to type the judge's return — to react to `blocked`
// without a magic string, say — had to redeclare the shape. It is the same duplication M78 closed
// for the error hierarchy: without the public surface, reimplementing is the only legal way out for
// anyone behind the layer boundary.
//
// `JudgeCredentialError` comes along because it is the error M80's fail-fast throws: whoever
// `catch`es in the goal loop needs to tell "the judge credential does not work" from any other
// failure.
export type { JudgeResult, Verdict } from "./types/goal-events.js";
// Type contract
export type * from "./types/index.js";
// SE24 — guardrail processor pipeline (inputProcessors / outputProcessors).
export type {
  InputProcessorContext,
  OutputProcessorContext,
  Processor,
  ProcessorControls,
  ProcessorTripwire,
  ProcessorViolation,
} from "./types/processors.js";
// SE3 — multi-agent provenance. Explicit re-export so rollup-dts surfaces it in
// the bundled .d.ts (the `export type *` star does not reliably propagate — same
// reason as `CustomTool` above).
// SE34 — per-send completion check (`isTaskComplete`) public types.
export type { CompletionCheck, CompletionCheckResult, MessageOrigin } from "./types/run.js";
export type {
  RunCompactBoundaryEvent,
  RunCompletionCheckEvent,
  RunEvent,
  RunEventSink,
  RunMemoryDegradedEvent,
  RunPermissionDeniedEvent,
  RunRateLimitEvent,
  RunTaskCompletedEvent,
  RunTaskStartedEvent,
  RunTaskUpdatedEvent,
  RunToolProgressEvent,
  RunTripwireEvent,
} from "./types/run-events.js";
// theokit#146 — the shape `Agent.transcript()` returns. A host rendering tool cards from a resumed
// session needs to name these types; without them the method's return would only be reachable
// through an inline `import(...)` in the emitted .d.ts.
export type { SessionMessage, SessionMessagePart } from "./types/session-message.js";
export {
  recordWiring,
  UngatedCapabilityError,
  type WiredEntity,
  type WiringRecordInput,
} from "./wiring-record.js";
/**
 * Workflow, exported from the ROOT and not only from `@theokit/sdk/workflow`.
 *
 * Both this entry and `@theokit/sdk/workflow` now resolve to ONE declaration, so the documented
 * combination typechecks:
 *
 *     import { Workflow } from "@theokit/sdk/workflow";
 *     import { Cron } from "@theokit/sdk";
 *     await Cron.create({ cron: "@hourly", workflow: pipeline });
 *
 * It did not until #361. The two entries were built by different DTS pipelines and each emitted its
 * own `declare class Workflow`; a class with a private field is compared nominally, so the call was
 * rejected with "types have separate declarations of a private property '_options'" and SE35's
 * workflow-per-fire target was unreachable from outside the package. Nothing in-tree crosses that
 * boundary — in-tree code imports from `src/` — which is why it survived to a release.
 * `quality:dts-identity` now fails the build on the shape.
 */
export { agentStep, fn, Workflow } from "./workflow.js";
