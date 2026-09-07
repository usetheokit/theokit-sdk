# Harness capability map

Every public symbol the TheoKit workspace publishes, and the exact specifier to import it from — every package, not only the one this file ships inside. **Generated from the built type declarations** by `tools/generate-capability-map.mjs` — do not edit by hand, and do not trust a copy of it that lives anywhere else.

A symbol listed under two specifiers is reachable from both, but that does NOT make the two interchangeable: a class emitted separately into a subpath entry is a distinct nominal type from the one in the root bundle, so passing one where the other is expected fails on a private field. When a symbol appears twice, import it and everything it is passed to from the SAME specifier.

1204 export(s) across 46 entry point(s).

## `@theokit/acp`

| Symbol | Kind | Summary |
|---|---|---|
| `AcpAgentInfo` | interface | Display info for the agent in an ACP host UI.  |
| `AcpCapabilities` | interface | Overrides for the capabilities advertised in the ACP `initialize` handshake.  |
| `AcpServerOptions` | interface | Options for {@link serveAcp } .  |
| `AgentFactory` | type | Builds the agent that will serve one ACP session.  |
| `AgentOrFactory` | type | What `serveAcp({ agent })` accepts.  |
| `InvalidAgentError` | class | Thrown when `serveAcp({ agent })` is neither a function nor an object with `agentId` + `send`. |
| `PermissionMode` | type | How tool calls are gated before they execute (D355).  |
| `PromptTooLargeError` | class | Raised when a prompt's accumulated size passes `maxPromptBytes` (D360).  |
| `serveAcp` | function | Serve `options.agent` to an ACP host over JSON-RPC on stdio, blocking until the input stream ends.  |

## `@theokit/cli`

| Symbol | Kind | Summary |
|---|---|---|
| `CLI_VERSION` | const | This package's semver, substituted at build time — what `theokit --version` prints.  |
| `DatasetEntry` | interface | One evaluation case: the prompt sent to the agent, and an optional expected value handed to every scorer untouched (no comparison is performed for you). |
| `EvalConfig` | interface | The DEFAULT export of `eval.config.{ts,mjs}`.  |
| `main` | function | Parse `argv` and run the matching subcommand, returning the process exit code instead of exiting.  |
| `Score` | interface | Outcome of a single scoring decision.  |
| `Scorer` | type | Grades one agent output.  |
| `SDK_VERSION` | const | The `@theokit/sdk` semver this CLI was BUILT against — a concrete version, never `workspace:*`.  |

## `@theokit/memory-honcho`

| Symbol | Kind | Summary |
|---|---|---|
| `HonchoAdapterOptions` | interface | Configuration accepted by the `honchoMemory(...)` factory. |
| `honchoMemory` | function | Wire Honcho as the agent's long-term memory.  |

## `@theokit/memory-mem0`

| Symbol | Kind | Summary |
|---|---|---|
| `Mem0AdapterOptions` | interface | Configuration accepted by the `mem0Memory(...)` factory. |
| `mem0Memory` | function | Wire Mem0 cloud as the agent's long-term memory.  |

## `@theokit/memory-supermemory`

| Symbol | Kind | Summary |
|---|---|---|
| `SupermemoryAdapterOptions` | interface | Configuration accepted by the `supermemoryMemory(...)` factory. |
| `supermemoryMemory` | function | Wire Supermemory as the agent's long-term memory.  |

## `@theokit/sdk`

| Symbol | Kind | Summary |
|---|---|---|
| `ActiveMemoryPassArgs` | interface | Arguments for `MemoryProvider.runActivePass(...)`. |
| `ActiveMemoryPassResult` | interface | Result of `MemoryProvider.runActivePass(...)` — what the kernel injects into the LLM call. |
| `Agent` | class | Static façade for creating and managing Theo agents. |
| `AgentBuilder` | class | Fluent builder for {@link AgentOptions } .  |
| `AgentConversationTurn` | interface | Agent turn: user message + assistant/tool/thinking steps. |
| `AgentDefinition` | interface | Subagent definition.  |
| `AgentDescription` | interface | theokit#123 — the read-only introspection of a registered agent, returned by `Agent.describe()`.  |
| `AgentDisposedError` | class | T1.6 — Thrown when a consumer calls `agent.send()` or any method on an agent that has already been `dispose()`d.  |
| `AgentFactory` | class | Handle returned by {@link createAgentFactory } .  |
| `AgentMemory` | interface | Direct memory API exposed on `SDKAgent.memory`.  |
| `AgentOperation` | type | An operation a consumer may ask an {@link SDKAgent } about via `supports()`.  |
| `AgentOperationOptions` | interface | Options for archive/unarchive/delete. |
| `AgentOptions` | interface | Top-level options accepted by `Agent.create()`.  |
| `AgentPromptResult` | type | Result of a one-shot {@link Agent.prompt } call. |
| `AgentRegistryOptions` | interface | Knobs for {@link LiveAgentRegistry.configure } .  |
| `AgentRunError` | class | Thrown by `Agent.prompt` (and helpers that go through `run.wait()`) when the option `{ throwOnError: true }` is set and the run terminates with `status: 'error'`.  |
| `AgentRunErrorCode` | type | Back-compat alias of {@link KnownAgentRunErrorCode } .  |
| `agentStep` | function | Build an `AgentStep`.  |
| `AgentSubagentDescription` | interface | theokit#123 — one subagent of a registered agent (what theokit-studio calls a workflow).  |
| `AgentToolDescription` | interface | theokit#123 — one tool of a registered agent, as a reflection surface sees it.  |
| `applyMode` | function | SE1 — apply a {@link PermissionMode } to a rule-engine verdict.  |
| `applySecurityFloor` | function | Resolve a security-relevant setting so that a lower-trust layer can only tighten it.  |
| `ApprovalDecision` | interface | The answer, the rule that produced it, and the tool it was about. |
| `ApprovalInput` | interface | One tool call to decide on, plus the operator's configuration.  |
| `ApprovalMode` | type | What the operator chose for everything not decided per tool. |
| `ApprovalOutcome` | type | The three answers a policy can give: proceed, put the call in front of a human, or stop it.  |
| `ApprovalReason` | type | Which rule produced the outcome.  |
| `AssistantMessage` | interface | Plain assistant message in a conversation history. |
| `auditEnvReachability` | function | Answer both halves of the reachability question in one call.  |
| `AuthenticationError` | class | Invalid API key, not logged in, insufficient permissions. |
| `BatchItem` | interface | Single prompt in a batch.  |
| `BatchOptions` | interface | Options accepted by `Agent.batch`.  |
| `BatchProgress` | interface | Live progress snapshot delivered to `onProgress`. |
| `BatchResult` | type | Per-prompt outcome.  |
| `BlastRadiusDecision` | interface | The outcome, the rule that produced it, and the scope it was decided about.  |
| `BlastRadiusInput` | interface | The action to decide on, plus what the operator granted.  |
| `BlastRadiusOutcome` | type | What the policy decided.  |
| `BlastRadiusReason` | type | Why the decision came out that way.  |
| `Budget` | class | `Budget` — token cost enforcement primitive (Adoption Roadmap #1 post-Tasks, ADRs D375-D388).  |
| `BudgetCheck` | interface | Decision the tracker returns on each iteration / pre-flight check. |
| `BudgetExceededError` | class | Thrown by `Budget` enforcement (ADR D386) when a `mode: "block"` budget would be exceeded by the upcoming LLM call.  |
| `BudgetExceedEvent` | interface | Exceed event emitted at 100% across all modes. |
| `BudgetHandle` | interface | Returned by `Budget.create` and `Budget.get` — read-only view. |
| `BudgetLimit` | interface | A single limit; stacked in an array (D384, ANY exceeded blocks). |
| `BudgetMode` | type | Enforcement mode (D383).  |
| `BudgetOptions` | interface | Options for `Budget.create`. |
| `BudgetScope` | type | Accounting scope for a budget.  |
| `BudgetSnapshot` | interface | Per-window snapshot returned by `Budget.snapshot()`. |
| `BudgetThresholdEvent` | interface | Threshold event emitted at 80% and 95% in `warn` and `block` modes. |
| `BudgetTotal` | interface | Aggregate snapshot of usage so far. |
| `BudgetTracker` | interface | The kernel-facing contract.  |
| `BudgetUsageEvent` | interface | Single usage event recorded during one LLM call. |
| `BudgetWindow` | type | Time window for a budget limit (D382 — UTC calendar-aligned).  |
| `BuiltinToolName` | type | A tool the SDK declares to the model on its own initiative — not one the consumer passed in {@link AgentOptions.tools } , and not one an MCP server exposed.  |
| `chargeAndCheckThresholds` | function | Charge the budget + dispatch threshold/exceed callbacks (EC-8 isolated).  |
| `CloudEnv` | interface | Cloud execution environment. |
| `CloudOptions` | interface | Cloud agent configuration. |
| `CloudRepo` | interface | Repo to clone into a cloud agent's VM. |
| `CompatSource` | type | A foreign configuration dialect this SDK can read.  |
| `CompatSourceAdapter` | interface | A foreign source admitted to named surfaces only.  |
| `CompatSurface` | type | A surface a foreign configuration source may be admitted to.  |
| `CompletionCheck` | interface | SE34 — the per-send completion criterion (see {@link SendOptions.completionCheck } ). |
| `CompletionCheckResult` | interface | SE34 — the resolved per-send completion verdict (see {@link RunResult.completionCheck } ). |
| `computeCost` | function | Returns CostBreakdown with `status="estimated"`, `"unknown"`, or `"included"`.  |
| `ConfigurationError` | class | Invalid model, bad request parameters, malformed options. |
| `ContextBudget` | interface | Token budget used by the context manager for a single agent. |
| `ContextManagerKind` | type | Owner: `src/` (1 of 2 importers).  |
| `ContextSettings` | interface | Context configuration accepted by `Agent.create()` via {@link AgentOptions.context } . |
| `ContextSnapshot` | interface | Result of `agent.context.snapshot()`.  |
| `ContextSource` | interface | A single context source resolved by the context manager. |
| `ContextSourceStatus` | type | Inclusion state of a single context source in a {@link ContextSnapshot } . |
| `ConversationStep` | type | A single step inside an agent turn, discriminated by `type`: an assistant message, a tool call, the tool result that pairs with it, or a thinking block.  |
| `ConversationTurn` | type | Structured per-turn view of a run. |
| `CostBreakdown` | interface | Cost breakdown attached to `RunResult.cost`.  |
| `CostSource` | type | Source of the cost figure for caller-side audit. |
| `CostStatus` | type | Cost confidence level (D377).  |
| `CounterBudgetTrackerOptions` | interface | Options for `createCounterBudgetTracker`. |
| `createCounterBudgetTracker` | function | Build a fresh tracker.  |
| `CreateSkillSpec` | interface | Spec accepted by {@link createSkill } . |
| `CredentialInput` | interface | One provider's credential lookup, as the product resolved it.  |
| `CredentialReport` | interface | A presence-only view of one credential, safe to print, log, or attach to a support bundle.  |
| `Cron` | class | Static façade for scheduling Theo agent runs on a cron expression. |
| `CronCreateOptions` | interface | Options for `Cron.create()`.  |
| `CronGetOptions` | interface | Options for `Cron.get()`. |
| `CronJob` | interface | Persistent cron-scheduled invocation of the Theo agent or a workflow.  |
| `CronJobStatus` | type | Lifecycle state reported by `Cron.list()` / `Cron.get()`. |
| `CronListOptions` | type | Options for `Cron.list()`. |
| `CronOperationOptions` | interface | Options for `Cron.delete()` / `Cron.enable()` / `Cron.disable()`. |
| `CronRunOptions` | interface | Options for `Cron.run()` — manually trigger a job off-schedule. |
| `CronRuntime` | type | Runtime hosting a cron job.  |
| `CronSchedulerStatus` | interface | Snapshot of the local scheduler returned by `Cron.status()`. |
| `CronStartOptions` | interface | Options for `Cron.start()` — activates the in-process scheduler for local jobs. |
| `CustomTool` | interface | Local function tool declared per-agent via {@link AgentOptions.tools } .  |
| `decideApproval` | function | Decide one tool call against the operator's lists and mode.  |
| `DeclaredAction` | interface | What an action reaches, and whether it can be taken back. |
| `DeclaredLayer` | interface | One named layer in a precedence chain.  |
| `DeepPartial` | type | Recursive partial — `T` where every nested field becomes optional. |
| `DefineProviderOptions` | interface | Options for {@link defineProvider } . |
| `DefineToolSpec` | interface | Spec accepted by {@link Tool.create } .  |
| `describeAction` | function | Read back the action a tool declared, if any.  |
| `describeCredential` | function | Turn a resolved credential into something you can show a user.  |
| `DiagnosticsSink` | type | Receives each diagnostic message already formatted, with the trailing `\n`. |
| `DoomLoopThresholds` | interface | Doom-loop guard thresholds (see {@link SendOptions.doomLoop } ).  |
| `DreamingSweepOptions` | interface | Inputs for {@link Memory.runDreamingSweep } .  |
| `DreamingSweepResult` | interface | What one dreaming sweep did.  |
| `EffectiveToolCatalog` | interface | The result of {@link effectiveToolNames } . |
| `effectiveToolNames` | function | The tool names an agent created with `options` will offer the model, as far as the options can say.  |
| `emitRunEvent` | function | SE2 — emit a {@link RunEvent } to an optional sink, swallowing any sink error so observability can never break the run (fail-safe, mirrors the EventBus EC-2 contract).  |
| `EnvOptOut` | interface | A key deliberately left off the environment, with the reason and what would reverse it. |
| `EnvReachabilityAudit` | interface | The two failures, reported separately because they have opposite fixes.  |
| `EnvReachabilityInput` | interface | The three lists the audit compares: every key the product declares, the subset an environment variable can set, and the documented exemptions.  |
| `ErrorCode` | type | Finite, machine-readable error codes for provider-originated errors (ADR D66).  |
| `ErrorMetadata` | interface | Structured context for errors that originated from a provider HTTP call (ADR D65).  |
| `estimateTokens` | function | Tokenizer-free token estimate via the conventional ~4-chars-per-token heuristic: `ceil(text.length / CHARS_PER_TOKEN)`.  |
| `evaluateBlastRadius` | function | Decide one declared action against the scopes the operator granted.  |
| `EventBus` | class | A typed publish/subscribe bus, parameterised by a map of event name to payload type.  |
| `EvictReason` | type | Live-agent cache for production deploys (Production-Readiness #2, ADRs D307-D310).  |
| `extractRawId` | function | Extract the raw provider id from a `MemoryId`, enforcing that the prefix matches `expectedAdapterId`.  |
| `fn` | function | Build a `FnStep`.  |
| `foldLayers` | function | Combine `entries` into one record.  |
| `GenerateObjectError` | class | Typed error thrown by {@link Agent.generateObject } when the model refuses to call the synthetic `output` tool or when retries are exhausted. |
| `GenerateObjectOptions` | interface | Options accepted by {@link Agent.generateObject } .  |
| `GenerateObjectResult` | interface | Successful return from {@link Agent.generateObject } . |
| `GenerateOptions` | interface | SE9 — options for the integrated structured-output method `agent.generate`: the {@link SendOptions } that drive the tool loop (phase 1) plus the required `output` Zod schema and structuring knobs (... |
| `GenerateRunResult` | interface | SE9 — result of `agent.generate`: the validated typed object plus the underlying tool-loop {@link RunResult } (status / usage / model) and the raw pre-parse input. |
| `GetAgentOptions` | interface | Options for `Agent.get()`.  |
| `getPricingEntry` | function | Returns the pricing entry for a given `{provider, model}` route.  |
| `GetRunOptions` | type | Options for `Agent.getRun()`.  |
| `GOAL_CONTINUATION_MARKER` | const | The goal-loop's continuation marker — in a LEAF module, on purpose.  |
| `GoalEvent` | type | Single event emitted while iterating a goal-driven loop — the public event type of {@link SDKAgent.runUntil } (ADRs D115-D117).  |
| `GoalLoopAgent` | interface | The minimal surface the goal loop drives — anything that can send a prompt and wait for it. |
| `GoalOptions` | interface | Per-call configuration for `Agent.runUntil`. |
| `GoalResult` | interface | Return value of the `runUntil` async generator.  |
| `guardSessionDestruction` | function | Throw unless `sessionId` is safe to destroy. |
| `HookName` | type | The fixed set of points a `"general"` plugin may attach to through `PluginContext.on`.  |
| `ImageBlock` | interface | SE7 — a base64-encoded image block a tool can hand back as (part of) its result or its `ToolError`.  |
| `inferApiMode` | function | Guess which usage shape a provider reports, from its name alone.  |
| `InlineSkill` | interface | A code-defined skill (from {@link createSkill } ) — a {@link Skill } plus its inline body. |
| `InputProcessorContext` | interface | Context passed to {@link Processor.processInput } . |
| `IntegrationNotConnectedError` | class | Thrown when creating a cloud agent for a repo whose SCM provider is not connected.  |
| `InteractionUpdate` | type | Lowest-level raw update from a run.  |
| `InvalidateCacheOptions` | interface | Options for {@link SDKAgent.invalidateCache } . |
| `InvalidTaskIdError` | class | Thrown when a user-supplied task ID violates the grammar `^[a-z0-9][a-z0-9_-]*$` (D368) OR starts with a reserved adapter prefix (`wf-` / `b-` / `cron-`, EC-5). |
| `isTransientError` | function | Is this error transient (worth retrying)?  |
| `isValidTaskId` | function | Validates a task ID against the public grammar + reserved prefixes.  |
| `JobQueue` | class | An in-process queue of background jobs with status tracking, cancellation, and an optional concurrency bound.  |
| `JobQueueOptions` | interface | #58 — construction options. |
| `JudgeCredentialError` | class | M80 — the judge's credential or model does not work: 401/404.  |
| `JudgeResult` | interface | M80 — the result of a judge call, now public.  |
| `KeepReason` | type | Why an artifact survived. |
| `KeptArtifact` | interface | An artifact that survived, carrying the reason it did.  |
| `LayerOrderError` | class | Raised when a declared layer chain is not strictly ascending. |
| `LayerValues` | interface | A declared layer together with the values it supplies.  |
| `ListAgentsOptions` | type | Options for `Agent.list()`.  |
| `ListResult` | interface | Paginated list shape. |
| `ListRunsOptions` | interface | Options for `Agent.listRuns()`.  |
| `LiveAgentRegistry` | class | An LRU-plus-idle cache of live `SDKAgent` instances, reached through `Agent.registry`.  |
| `LiveSessionError` | class | Raised by `guardSessionDestruction` instead of letting a session be destroyed.  |
| `LiveSessionReason` | type | Why the destruction was refused. |
| `loadProjectEnv` | function | Read the project's `.env` into `env`, then restore every {@link SOVEREIGN_ENV_KEYS } entry to the value it had BEFORE the load — including restoring it to absent.  |
| `LocalOptions` | interface | Local agent configuration.  |
| `McpAuthConfig` | interface | OAuth-style auth bundle for HTTP/SSE MCP servers. |
| `McpHttpServerConfig` | type | HTTP or SSE MCP server. |
| `McpOAuthConfig` | interface | OAuth 2.1 PKCE flow descriptor.  |
| `McpServerConfig` | type | Union of MCP server configs. |
| `McpStdioServerConfig` | type | MCP server configuration accepted by `Agent.create()` and `agent.send()`. |
| `Memory` | const | Memory operations that run OUTSIDE an agent turn.  |
| `MemoryAdapter` | interface | Portable third-party memory adapter contract.  |
| `MemoryAdapterCapabilities` | interface | Statically declared adapter feature flags.  |
| `MemoryAdapterError` | class | Error raised by `@theokit-memory-*` adapters.  |
| `MemoryAdapterErrorCode` | type | Finite error codes specific to memory adapter operations (ADR D141). |
| `MemoryContext` | interface | Portable identity context.  |
| `MemoryFact` | interface | A single memory fact returned by `recall` or `get`. |
| `MemoryId` | type | Branded provider memory ID.  |
| `MemoryProvider` | interface | The kernel-facing contract.  |
| `MemoryProviderAgentRef` | interface | The agent identity a `MemoryProvider` is given — the whole of it.  |
| `MemoryProviderFactory` | type | Memory provider factory shape (ADR D141).  |
| `MemoryProviderHandle` | interface | Opaque handle returned by `init()`.  |
| `MemoryProviderInitOptions` | interface | Options for `MemoryProvider.init(...)`. |
| `MemoryRevision` | interface | Versioned snapshot of a memory's history.  |
| `MemorySettings` | interface | Memory configuration accepted by `Agent.create()` via {@link AgentOptions.memory } .  |
| `MemoryToolSchema` | interface | OpenAI-format function-calling schema exposed to the LLM. |
| `MemoryTurnMessage` | interface | One assistant-turn message in the canonical `{role, content}` shape an adapter may receive instead of a flat string when writing a turn. |
| `MessageOrigin` | type | SE3 — provenance of the turn that produced a run: WHO triggered it.  |
| `MigrateOptions` | interface | Options for {@link migrateSqliteToLance } . |
| `MigrateResult` | interface | Outcome of {@link migrateSqliteToLance } . |
| `migrateSqliteToLance` | function | Migrate the Memory index from SQLite to LanceDB.  |
| `mkMemoryId` | function | Construct a branded `MemoryId` for an adapter.  |
| `ModelListItem` | interface | Single model entry in the catalog. |
| `ModelParameterDefinition` | interface | Per-model parameter definition discovered from `Theokit.models.list()`. |
| `ModelParameterValue` | interface | One slot in a {@link ModelSelection.params } array. |
| `ModelSelection` | interface | Identifies a model plus optional per-model parameters (e.g.  |
| `ModelVariant` | interface | Preset variant for a model — pre-filled parameter combinations. |
| `NetworkError` | class | Service unavailable, timeout, transport-level failure. |
| `NoopMemoryProvider` | class | SE36 — `NoopMemoryProvider.create` replaces `createNoopMemoryProvider` (ADR 0015). |
| `NormalizedJsonSchema` | type | The internal JSON-Schema shape the synthetic `output` tool consumes. |
| `normalizeSchema` | function | Normalize any supported schema to the internal JSON Schema.  |
| `normalizeUsage` | function | Convert a provider's raw `usage` object into the SDK's canonical `TokenUsage`.  |
| `OTelSpan` | interface | The subset of the OpenTelemetry `Span` API this SDK calls.  |
| `OutputProcessorContext` | interface | Context passed to {@link Processor.processOutput } . |
| `PartialToolCallUpdate` | interface | Tool call arguments streaming in incrementally. |
| `PermissionAction` | type | `PermissionEngine` — first-match permission rules for tool invocations.  |
| `PermissionEngine` | class | Ordered first-match permission rules for tool invocations — the policy object you hand to `PermissionPlugin.create()` to have it enforced.  |
| `PermissionEngineOptions` | interface | Options for {@link PermissionEngine } . |
| `PermissionGate` | type | SE1 — the enriched `canUseTool` gate (the Anthropic-parity shape).  |
| `PermissionGateContext` | interface | SE1 — context passed to the {@link PermissionGate } .  |
| `PermissionGateDecision` | type | SE1 — the resolution of an `"ask"` verdict by the host gate.  |
| `PermissionMode` | type | How the permission engine treats the UNMATCHED verdict.  |
| `PermissionPlugin` | class | SE36 — `PermissionPlugin.create` replaces `createPermissionPlugin` (ADR 0015). |
| `PermissionPluginOptions` | interface | Options for {@link createPermissionPlugin } . |
| `PermissionRule` | interface | One entry in a {@link PermissionEngine } 's ordered rule list.  |
| `PersonalityPreset` | interface | Resolved personality preset surfaced via {@link SDKAgent.usePersonality } (Hermes #26, ADRs D160-D169).  |
| `planReaping` | function | Sort artifacts into keep, reap, and undetermined — and delete nothing.  |
| `Plugin` | type | SE36 — `Plugin.create` replaces `definePlugin` (ADR 0015).  |
| `PluginContext` | interface | The registration surface passed to a `"general"` plugin's `register(ctx)`, and the plugin's only route into the agent.  |
| `PluginHookDisposer` | type | Detaches a hook handler attached with {@link PluginContext.on } .  |
| `PluginsSettings` | interface | Plugins configuration accepted by `Agent.create()` via {@link AgentOptions.plugins } . |
| `PostAssistantReplyContext` | interface | Context passed to `post_assistant_reply` hook handlers (ADR D145).  |
| `PostToolCallContext` | interface | #65 — context for the `post_tool_call` hook (fired after a tool runs). |
| `preflightCheck` | function | Throws BudgetExceededError if `mode === "block"` and any limit would be exceeded.  |
| `PreToolCallContext` | interface | What a `pre_tool_call` handler is given: the tool about to run, the arguments the model produced for it, and the identity of the run asking.  |
| `PreToolCallDecision` | interface | The veto a `pre_tool_call` handler returns to stop a tool call.  |
| `PreUserSendContext` | interface | Context passed to `pre_user_send` hook handlers (ADR D145). |
| `PreUserSendResult` | interface | Optional result returned by `pre_user_send` handlers.  |
| `Processor` | interface | A guardrail processor.  |
| `ProcessorControls` | interface | Controls available to a processor while it runs: `abort()` stops the run with a tripwire; `warn()` reports a non-blocking violation and continues. |
| `ProcessorTripwire` | interface | The tripwire detail attached to {@link RunResult.tripwire } when a processor aborts, and carried by the `tripwire` run-event. |
| `ProcessorViolation` | interface | A policy violation surfaced to a processor's {@link Processor.onViolation } callback — on `abort()` (blocking) AND on `warn()` (non-blocking). |
| `Provider` | class | SE36 — uniform namespace API.  |
| `ProviderCapability` | type | Owner: `src/` (4 of 9 importers).  |
| `ProviderProfile` | interface | A data-only declaration of an LLM provider: its name, HTTP dialect, auth style, base URL and fallback models.  |
| `ProviderRoute` | interface | A single user-declared routing rule.  |
| `ProviderRoutingSettings` | interface | Provider routing configuration accepted by `Agent.create()` via {@link AgentOptions.providers } . |
| `ProviderTransform` | interface | M41 — the one OPTIONAL behavior seam on a provider profile.  |
| `ProviderTransformContext` | interface | M41 (agent-builder provider framework) — the context a provider's `transform` receives per request.  |
| `RateLimitError` | class | Too many requests or usage limits exceeded. |
| `readSessionMessages` | function | Read the messages a session already contains, for a surface that needs to re-render it.  |
| `ReadSessionMessagesOptions` | interface | Which session to read, in the terms a host already has. |
| `ReapableArtifact` | interface | One artifact the caller is considering deleting, described well enough to decide about.  |
| `ReapPlan` | interface | The decision, as three disjoint buckets whose union is exactly the input.  |
| `ReapPlanInput` | interface | Everything `planReaping` needs: the candidates, the policy, and the current time.  |
| `RecordSessionSummaryArgs` | interface | Arguments for `MemoryProvider.recordSessionSummary(...)` (SDK 2.0 Phase 1 physical Stage 3 prep — iter 27).  |
| `recordWiring` | function | Record what a build actually wired, per capability.  |
| `ResolvedProviderRoute` | interface | Resolved routing decision returned by `agent.providers.routes()`.  |
| `resolveTrustPosture` | function | Decide what a project directory is allowed to switch on.  |
| `RetentionPolicy` | interface | How long artifacts are kept and how many always survive.  |
| `RetentionPolicyError` | class | Raised when a retention policy cannot be honoured as written. |
| `Run` | interface | Handle to a single prompt submission, returned by `agent.send()` before the model has answered.  |
| `RunCompactBoundaryEvent` | interface | The conversation crossed a compaction boundary (history was summarized). |
| `RunCompletionCheckEvent` | interface | SE34 — the per-send completion check (`isTaskComplete`) produced a verdict.  |
| `RunErrorDetail` | interface | Structured error attached to a {@link RunResult } when the underlying run transitioned to `"error"` status.  |
| `RunEvent` | type | Owner: `internal/agent-loop/` (3 of 11 importers).  |
| `RunEventSink` | type | Receives every {@link RunEvent } a run emits, in emission order.  |
| `RunGitInfo` | interface | Git metadata attached to cloud runs. |
| `runGoalLoop` | function | Run the goal-driven loop (`send → judge → continuation`) over ANY `send → wait` surface.  |
| `RunMemoryDegradedEvent` | interface | A memory stage failed and the run continued without it.  |
| `RunOperation` | type | Operations that may or may not be supported on a given {@link Run } , or on its parent agent.  |
| `RunPermissionDeniedEvent` | interface | A tool call was DENIED before dispatch — by the permission gate/plugin (SE1), an operator file-hook `preToolUse`, or the fork tool-whitelist.  |
| `RunRateLimitEvent` | interface | The provider returned a rate-limit (HTTP 429); the loop will back off + retry. |
| `RunResult` | interface | Terminal result of a {@link Run } . |
| `RunStatus` | type | Lifecycle status of a {@link Run } . |
| `RunTaskCompletedEvent` | interface | A background task/subagent finished. |
| `RunTaskStartedEvent` | interface | A background task/subagent started. |
| `RunTaskUpdatedEvent` | interface | A background task/subagent changed state. |
| `RunTimelineEvent` | type | theokit#140 - one element of {@link Run.events } : either a structural SDK message or a live delta.  |
| `RunToCompletionOptions` | interface | Options for {@link SDKAgent.runToCompletion } (M1 Phase 3 — continuation driver). |
| `RunToCompletionResult` | interface | Result of {@link SDKAgent.runToCompletion } . |
| `RunToolProgressEvent` | interface | A tool call is being dispatched (before its result). |
| `RunTripwireEvent` | interface | SE24 — a guardrail processor called `abort()`; the run stops with a tripwire.  |
| `RunUntilIterator` | type | Return type of {@link import ("../internal/local-agent/local-agent.js").LocalAgent.runUntil } .  |
| `scopedConversationId` | function | M3 #62 — build a scope-namespaced conversation id (`"<scope>__<id>"`). |
| `SDKAgent` | interface | Handle returned by `Agent.create()` and `Agent.resume()`. |
| `SDKAgentInfo` | type | Metadata returned by `Agent.list()` and `Agent.get()`. |
| `SDKAgentPlugins` | interface | Public plugin listing handle exposed as `agent.plugins`.  |
| `SDKAgentSkillDetail` | interface | A skill resolved WITH its body, returned by {@link SDKAgentSkills.get } .  |
| `SDKAgentSkills` | interface | The skill handle exposed as `agent.skills`, present only when project-scoped skills are enabled (`settingSources: ["project"]`) or `skills.enabled` is set.  |
| `SDKArtifact` | interface | Artifact produced inside an agent's workspace.  |
| `SDKAssistantMessage` | interface | Model text output for this run. |
| `SDKContextManager` | interface | Public context manager handle exposed as `agent.context`. |
| `SDKImage` | type | Either a remote URL or inline base64 payload. |
| `SDKImageDimension` | interface | Dimensions of an inline image attachment. |
| `SDKMessage` | type | Discriminated union of all stream events.  |
| `SDKModel` | type | Alias of {@link ModelListItem } , used where a model comes back from the Theokit platform rather than from a catalog listing.  |
| `SDKObjectDelta` | interface | Partial object emitted during `Agent.streamObject<T>` streaming (ADR D45).  |
| `SDKPluginMetadata` | interface | Public plugin metadata returned by `agent.plugins.list()`.  |
| `SDKProvider` | interface | Provider catalog entry returned by `Theokit.providers.list()`. |
| `SDKProvidersManager` | interface | Public providers manager handle exposed as `agent.providers`. |
| `SDKRepository` | interface | GitHub repository connected to the team.  |
| `SDKRequestMessage` | interface | Awaiting user input or approval. |
| `SDKStatusMessage` | interface | Cloud run lifecycle transitions. |
| `SDKSystemMessage` | interface | Init metadata.  |
| `SDKTaskMessage` | interface | Task-level milestones and summaries. |
| `SDKThinkingMessage` | interface | Reasoning content. |
| `SDKToolUseMessage` | interface | Tool invocation lifecycle event.  |
| `SDKUser` | interface | Owner: `internal/catalog/` (2 of 3 importers).  |
| `SDKUserMessage` | interface | Structured form of `agent.send()`'s message argument.  |
| `SDKUserMessageEvent` | interface | Echo of the user prompt for this run. |
| `Security` | class | Public security namespace (T2.1, ADR D68).  |
| `SecurityFloorInput` | interface | The vocabulary, the layer names, and the values to resolve.  |
| `SendOptions` | interface | Per-send overrides and callbacks.  |
| `SessionLifecycleContext` | interface | #65 — context for the `on_session_start` / `on_session_end` hooks. |
| `SessionMessage` | interface | One turn of a session.  |
| `SessionMessagePart` | type | One structured element of a {@link SessionMessage } .  |
| `SessionRecord` | interface | One transcript record — a single line of the session JSONL file, and the unit the pluggable `SessionStore` seam reads and writes.  |
| `SessionScope` | type | M3 #62 — session state scope. |
| `sessionScopePrefix` | function | M3 #62 — the id prefix (`"<scope>__"`) used to match a scope's conversations. |
| `SessionStore` | interface | The pluggable session-store seam.  |
| `setDiagnosticsSink` | function | Installs (or removes, by passing `undefined`) the diagnostics destination.  |
| `SettingSource` | type | Which on-disk settings layers a local agent loads. |
| `ShareGptMessage` | interface | One ShareGPT message in a conversation.  |
| `ShareGptTrajectory` | interface | One full ShareGPT-format trajectory — a single conversation plus metadata.  |
| `ShellCommand` | interface | Shell command executed during a run. |
| `ShellConversationTurn` | interface | Shell turn: a command and its output. |
| `ShellOutput` | interface | Output of a shell command. |
| `ShellOutputDeltaUpdate` | interface | Incremental output from a shell command running inside a run.  |
| `Skill` | class | SE36 — `Skill.create` replaces `createSkill` (ADR 0015). |
| `SkillReadTool` | class | SE36 — `SkillReadTool.create` replaces `defineSkillReadTool` (ADR 0015). |
| `SkillsResolver` | type | SE22 — a resolver that produces {@link SkillsSettings } per run from runtime context (e.g.  |
| `SkillsResolverContext` | interface | SE22 — context passed to a {@link SkillsResolver } .  |
| `SkillsSettings` | interface | Skills configuration accepted by `Agent.create()` via {@link AgentOptions.skills } .  |
| `SOVEREIGN_ENV_KEYS` | const | Variables a project-scoped source may never set.  |
| `SovereignEnvKey` | type | The union of {@link SOVEREIGN_ENV_KEYS } entries — the variables a project-scoped `.env` may never set.  |
| `Squad` | class | A sequential agent team produced by {@link createSquad } .  |
| `SquadOptions` | interface | Options for {@link createSquad } . |
| `SquadRun` | interface | Result of a {@link Squad.run } .  |
| `StepCompletedUpdate` | interface | Conversation step completed. |
| `StepStartedUpdate` | interface | Conversation step started. |
| `StreamObjectError` | class | Error thrown by {@link Agent.streamObject } when the model refuses to call the synthetic `output` tool or when all retries fail to produce a schema-valid object.  |
| `StreamObjectEvent` | type | Event emitted by {@link Agent.streamObject } .  |
| `StreamObjectOptions` | interface | Options accepted by {@link Agent.streamObject } .  |
| `StreamToCompletionResult` | type | Result of {@link SDKAgent.streamToCompletion } (V3-4 — the STREAMING continuation driver).  |
| `SummaryCompletedUpdate` | interface | Closes the bracket opened by {@link SummaryStartedUpdate } .  |
| `SummaryStartedUpdate` | interface | Opens the bracket around a {@link SummaryUpdate } , for a UI that wants to show a pending state before the summary text exists.  |
| `SummaryUpdate` | interface | A conversation summary produced during a run, delivered through `SendOptions.onDelta`.  |
| `SystemPromptContext` | interface | Context passed to a {@link SystemPromptResolver } .  |
| `SystemPromptMemoryFact` | interface | Public view of a recalled memory fact exposed to the system-prompt resolver. |
| `SystemPromptResolver` | type | Resolver function that produces the system prompt dynamically.  |
| `SystemPromptSkillRef` | interface | Public skill metadata exposed to the system-prompt resolver.  |
| `Task` | class | Static facade over the process-wide task registry — the observability layer for asynchronous work.  |
| `TASK_RESERVED_PREFIXES` | const | Re-exported for adapter implementations + tests. |
| `TaskCancelResult` | interface | Result of `Task.cancel` (D365 — idempotent). |
| `TaskConfigureOptions` | interface | Registry-level configuration.  |
| `TaskEvent` | type | Discriminated union of task lifecycle events (D366). |
| `TaskFilter` | interface | Query filter for `Task.list`. |
| `TaskHandle` | interface | Public read-only view of a task entry in the registry. |
| `TaskKind` | type | Discriminator of the runtime that produced a task (D374). |
| `TaskNotFoundError` | class | Thrown when `Task.subscribe(id)` is called for a task that has been evicted, never submitted, or evicted after retention (D373). |
| `TaskState` | type | Closed enum of the 5 lifecycle states (D362).  |
| `TaskStoreOptions` | type | Options shape for `TaskStore` factory (D364). |
| `TaskSubmitOptions` | interface | Options for `Task.submit`. |
| `TaskWorkContext` | interface | `Task` — observable async work registry (Adoption Roadmap gap #2, ADRs D361-D374).  |
| `TaskWorkFn` | type | The unit of work handed to {@link Task.submit } .  |
| `TelemetryHandle` | interface | Telemetry handle returned by {@link createTelemetry } .  |
| `TelemetrySettings` | interface | Telemetry configuration for an agent.  |
| `TextBlock` | interface | Plain text content block emitted by the assistant or user, or returned by a tool. |
| `TextDeltaUpdate` | interface | Incremental text token from the assistant. |
| `Theokit` | class | Account-level and catalog reads.  |
| `TheokitAgentError` | class | Base class for all errors thrown by `@theokit/sdk`.  |
| `TheokitRequestOptions` | interface | Options shared by every `Theokit.*` request. |
| `ThinkingCompletedUpdate` | interface | Emitted when a reasoning block completes. |
| `ThinkingDeltaUpdate` | interface | Incremental reasoning token. |
| `ThinkingMessage` | interface | Reasoning step in a conversation history. |
| `TokenDeltaUpdate` | interface | Token count delta for usage tracking. |
| `TokenLimiter` | class | SE36 — `TokenLimiter.create` replaces `createTokenLimiter` (ADR 0015). |
| `TokenLimiterOptions` | interface | Options for {@link createTokenLimiter } . |
| `TokenUsage` | interface | Token usage observed during a Run.  |
| `Tool` | class | SE36 — the uniform `X.create()` namespace API.  |
| `ToolCall` | interface | Single tool call event.  |
| `ToolCallCompletedUpdate` | interface | Tool call completed. |
| `ToolCallStartedUpdate` | interface | Tool call started — args committed. |
| `ToolCallSummary` | interface | M82 — one tool call of the turn, as seen by `transform_tool_result`.  |
| `ToolContextMessage` | interface | SE12 — a read-only, text-only projection of one turn of the run's conversation, exposed to a tool handler via `ctx.messages`.  |
| `ToolError` | class | Thrown from a tool `handler` to surface a failure to the model.  |
| `ToolResult` | interface | Result of a tool invocation.  |
| `ToolResultContentBlock` | type | SE7 — structured content a tool result may carry: text and/or images.  |
| `ToolResultGuardOptions` | interface | Options for the tool-result guard (spotlighting + PII redaction on tool output).  |
| `ToolResultTransformContext` | interface | M82 — context for `transform_tool_result`, the only tool-stage hook whose return value the SDK actually applies (`#runTransform` folds it; `#runFireAndForget` discards `post_tool_call`'s).  |
| `ToolUseBlock` | interface | Tool invocation block emitted by the assistant. |
| `toShareGptTrajectory` | function | Convert a successful `BatchResult` to ShareGPT-format trajectory.  |
| `TransformContext` | interface | #65 — context for the `transform_tool_result` / `transform_llm_output` hooks. |
| `TrustLevel` | type | Whether a project directory may switch anything on.  |
| `TrustPosture` | interface | The decision: the level, where it came from, and one boolean per declared capability.  |
| `TrustPostureInput` | interface | What the decision is made from: the capability vocabulary, a way to read the operator's record, and an optional blanket override.  |
| `TrustSource` | type | Where the decision came from. |
| `TurnEndedUpdate` | interface | Turn ended with usage summary. |
| `UngatedCapabilityError` | class | Raised when a recorded capability has no entry in the gate. |
| `UnicodeNormalizer` | class | SE36 — `UnicodeNormalizer.create` replaces `createUnicodeNormalizer` (ADR 0015). |
| `UnicodeNormalizerOptions` | interface | Options for {@link createUnicodeNormalizer } . |
| `UnknownAgentError` | class | Catch-all for unclassified server or runtime errors. |
| `UnresolvedToolSource` | type | A tool source that is configured but cannot be enumerated without running the agent. |
| `UnsupportedBudgetOperationError` | class | Thrown when a budget operation is requested on a `CloudAgent` (D388).  |
| `UnsupportedRunOperationError` | class | Thrown when a {@link Run } or agent operation is not available on the current runtime.  |
| `UnsupportedTaskOperationError` | class | Thrown when `CloudAgent` is asked to wrap a task (D370).  |
| `UsageAccumulator` | class | Sums the per-step token counts of a multi-step run into one `TokenUsage`.  |
| `UserMessage` | interface | User-authored message in a conversation history. |
| `UserMessageAppendedUpdate` | interface | User message appended to the conversation. |
| `Verdict` | type | Owner: `internal/judge/` (3 of 8 importers).  |
| `verifyLayerOrdering` | function | Assert that each layer strictly outranks the one before it.  |
| `WiredEntity` | interface | What one capability asked for, and what it got. |
| `WiringRecordInput` | interface | The two halves of the observation: the gate that was applied, and what was handed to the builder.  |
| `withBlastRadius` | function | Declare what a tool reaches, for the approval layer rather than for the model.  |
| `WithBlastRadius` | type | A tool that may carry a blast-radius declaration under {@link DECLARED } .  |
| `withCwdMutex` | function | Run `fn` after every earlier `withCwdMutex` call for the same `key` has settled, and return what `fn` returns.  |
| `Workflow` | class | A committed, immutable workflow: a fixed list of steps you can `run`, `stream` or `resume`.  |

## `@theokit/sdk-budget`

| Symbol | Kind | Summary |
|---|---|---|
| `BUILTIN_PRICING` | const | The nine models this package prices out of the box, keyed by the exact `model` string a `BudgetUsageEvent` carries: four OpenAI, three Anthropic, two Google.  |
| `charge` | function | Append `amountUsd` to the spend ledger for the budget called `name`, timestamped now.  |
| `chargeAndCheckThresholds` | function | Record the ACTUAL cost of a completed call against a budget and fire its callbacks.  |
| `computeUsdCost` | function | Compute USD cost for a single token event.  |
| `createBudget` | function | Register a budget under `opts.name` and return its live handle.  |
| `createUsdBudgetTracker` | function | Build a `BudgetTracker` that caps an agent run on tokens, on USD, or on both.  |
| `defaultMode` | function | The mode a budget enforces, resolving the omitted case to `"warn"`.  |
| `deleteBudget` | function | Remove a budget from the registry.  |
| `formatCostUsd` | function | Render a USD cost for display.  |
| `FormatCostUsdOptions` | interface | Options for {@link formatCostUsd } . |
| `getBudget` | function | The live handle for a registered budget, or `undefined` when the name is unknown.  |
| `getBudgetOptionsRaw` | function | The stored {@link BudgetOptions } exactly as registered, or `undefined` when the name is unknown.  |
| `inferApiMode` | function | Which usage dialect a provider reports in, inferred from its name.  |
| `listBudgets` | function | Every budget registered in this process, in insertion order.  |
| `ModelPricing` | interface | The two rates needed to price one model, in USD per 1,000,000 tokens.  |
| `normalizeUsage` | function | Turn a provider's raw usage object into the SDK's canonical {@link TokenUsage } .  |
| `preflightCheck` | function | Refuse an upcoming call that would push a `"block"`-mode budget past one of its limits.  |
| `snapshotAll` | function | One row per budget PER WINDOW — a budget with three limits produces three rows, not one.  |
| `spentIn` | function | Total USD recorded for `name` inside `window`, summed at call time.  |
| `startOfDayUtc` | function | Midnight UTC of `now`'s day — the start of a `1d` budget window.  |
| `startOfWeekUtc` | function | Midnight UTC on the MONDAY of `now`'s week — the start of a `1w` budget window.  |
| `UsdBudgetTrackerOptions` | interface | Options for {@link createUsdBudgetTracker } .  |
| `windowStartMs` | function | Inclusive start timestamp (ms) of `window`, as `spentIn` uses it to decide which charges count.  |

## `@theokit/sdk-cache`

| Symbol | Kind | Summary |
|---|---|---|
| `Cache` | class | A semantic response cache: an exact-key lookup, then a vector-similarity lookup, over prompt/response pairs the caller has stored.  |
| `CacheEmbedderRuntime` | interface | Embedder runtime shape — minimal subset of `EmbeddingRuntime` (D11) the Cache actually uses.  |
| `CacheEntry` | interface | One cached prompt/response pair, as `Cache` stores it.  |
| `CacheInvalidTtlError` | class | A TTL value that could not be parsed, thrown at configuration time rather than on first use.  |
| `CachePersistenceOptions` | interface | Where cached entries live between process restarts.  |
| `CacheSemanticOptions` | interface | Configuration for `Cache.semantic(...)`.  |
| `CacheStats` | interface | Counters returned by `Cache.stats()`.  |
| `CacheTTLConfig` | interface | How long entries live, and which prompts never become entries at all. |
| `createLexicalEmbedder` | function | Build the built-in lexical embedder — a zero-dependency, zero-cost `CacheEmbedderRuntime`.  |

## `@theokit/sdk-handoff`

| Symbol | Kind | Summary |
|---|---|---|
| `AsPluginOptions` | interface | Options for {@link Handoff.asPlugin } . |
| `Handoff` | class | Peer-to-peer delegation: one agent hands the conversation to another and stops.  |
| `HandoffDescriptor` | type | What `Handoff.create` returns: a target plus its options plus the resolved tool name.  |
| `HandoffLoopError` | class | Thrown when a chain exceeds `maxHandoffDepth` (default 5).  |
| `HandoffNameCollisionError` | class | Thrown when two targets of the same parent resolve to the same `transfer_to_*` name — the model would have no way to pick between them.  |
| `HandoffOptions` | interface | Options accepted by `Handoff.create(target, opts?)`. |
| `HandoffPairLoopError` | class | Thrown when the same `sender -> receiver` pair fires twice inside one dispatch — the ping-pong guard, and the loop protection that actually fires in practice.  |
| `HandoffReceiverDisposedError` | class | Thrown when the target agent was disposed before the handoff reached it — detected at dispatch time, since nothing unregisters the tool when an agent is disposed.  |
| `HandoffSelfReferenceError` | class | Thrown when a target's `agentId` equals the parent's — self-handoff, which recurses forever.  |
| `handoffTo` | function | Hand `message` to `target` right now and return its reply text — no LLM routing, no tool call.  |
| `RECOMMENDED_HANDOFF_PROMPT_PREFIX` | const | Prose to prepend to a SENDING agent's `systemPrompt` so the model knows the `transfer_to_*` tools exist and what they mean.  |

## `@theokit/sdk-handoff/internal/tool-injector`

| Symbol | Kind | Summary |
|---|---|---|
| `buildHandoffTool` | function | Build a `CustomTool` for one handoff descriptor.  |
| `normalizeHandoffs` | function | Normalize each `handoffs[]` entry to a `HandoffDescriptor`.  |

## `@theokit/sdk-memory`

| Symbol | Kind | Summary |
|---|---|---|
| `ActiveMemoryCache` | class | A bounded, TTL-expiring cache of recall results, so two identical sends in quick succession run one search.  |
| `ActiveMemoryCacheOptions` | interface | TTL-bounded cache for `runActiveMemory` results.  |
| `ActiveMemoryOptions` | interface | Tuning for one recall attempt.  |
| `ActiveMemoryQueryMode` | type | How the recall query is built from the conversation.  |
| `ActiveMemoryResult` | interface | Result of one recall attempt.  |
| `ActiveMemoryStatus` | type | Outcome of one recall attempt.  |
| `ActiveMemoryTranscript` | interface | Optional on-disk persistence for Active Memory recall transcripts (ADR D6).  |
| `appendDiaryEntry` | function | Append one sweep's entry to `<memory root>/dream-diary.md`, creating the file with its header when this is the first sweep.  |
| `appendFact` | function | Record a fact, honouring the `enabled` gate on {@link MemoryConfig } : when memory is disabled the call resolves without touching disk.  |
| `appendFactToMarkdown` | function | Write a fact as its own memory file and point the `MEMORY.md` index at it.  |
| `asMemoryRoot` | function | Treat a directory as a memory root without resolving one.  |
| `assertValidBackend` | function | EC-1: runtime guard for `opts.backend`.  |
| `azureOpenAiMemoryEmbeddingProviderAdapter` | const | Azure OpenAI embeddings.  |
| `buildErrorMetadata` | function | Build an `ErrorMetadata` object with all optional fields included conditionally (no `undefined` keys in the output). |
| `CategorizedFact` | interface | A fact stored under a typed category.  |
| `CategorizedMemory` | interface | A typed, category-partitioned markdown memory store. |
| `chunkMarkdown` | function | Split markdown into the chunks that get embedded and searched.  |
| `ChunkMarkdownOptions` | interface | Split a markdown document into semantically meaningful chunks (ADR D1 of memory-system-peer-project-parity).  |
| `CircuitBreaker` | class | Stops calling a recall path that keeps timing out.  |
| `CircuitBreakerOptions` | interface | Consecutive-timeout circuit breaker for Active Memory recall.  |
| `claudeProjectMemoryDir` | function | Where the Claude Code CLI keeps THIS project's memories.  |
| `Cluster` | interface | A group of facts the REM phase judged related.  |
| `ClusterResult` | interface | What {@link remPhase } produced.  |
| `cohereMemoryEmbeddingProviderAdapter` | const | Cohere embeddings.  |
| `collectMarkdownFiles` | function | Every markdown file the memory corpus holds: the index, the per-memory files, `notes/`, `wiki/` and `sessions/`, each tagged with the bucket `memory_search`'s `corpus` filters on.  |
| `CreateAdapterOptions` | interface | Per-call overrides handed to {@link MemoryEmbeddingProviderAdapter.create } .  |
| `createCategorizedMemory` | function | Create a typed categorized memory store over the closed `categories` taxonomy.  |
| `CreateCategorizedMemoryOptions` | interface | Options for {@link createCategorizedMemory } . |
| `createInMemoryMarkdownProvider` | function | Build a fresh `MemoryProvider` whose facts live in-process.  |
| `createMemoryGetTool` | function | Build the `memory_get` tool, which reads an exact excerpt from a file under `<cwd>/.theokit/memory`.  |
| `createMemorySearchTool` | function | Build the `memory_search` tool over an index that is already open.  |
| `createOpenAiCompatibleRuntime` | function | Build an {@link EmbeddingRuntime } for a provider that speaks the OpenAI embedding wire — or, through `cfg.dialect`, one that deviates from it in a known way.  |
| `createVectorIndex` | function | Create the `embeddings` vec0 virtual table at the given vector width, if it does not exist already.  |
| `DedupResult` | interface | Dreaming/REM phase logic.  |
| `deepinfraMemoryEmbeddingProviderAdapter` | const | Open-weight embedding models (BGE, E5, GTE, MiniLM) hosted by DeepInfra.  |
| `deepPhase` | function | Deep phase — render consolidated markdown for the dreamed note. |
| `DEFAULT_AZURE_OPENAI_EMBEDDING_MODEL` | const | Azure OpenAI embedding adapter.  |
| `DEFAULT_COHERE_EMBEDDING_MODEL` | const | Cohere embedding adapter — `POST /v2/embed` at `https://api.cohere.com`.  |
| `DEFAULT_DEEPINFRA_EMBEDDING_MODEL` | const | DeepInfra embedding adapter — hosts open-source embedding models (BGE, E5, Jina, etc.) at pay-per-token.  |
| `DEFAULT_GEMINI_EMBEDDING_MODEL` | const | Google Gemini embedding adapter — the OpenAI-compatible surface at `https://generativelanguage.googleapis.com/v1/embeddings`.  |
| `DEFAULT_JINA_EMBEDDING_MODEL` | const | Jina AI embedding adapter — OpenAI-compatible at `https://api.jina.ai/v1/embeddings`.  |
| `DEFAULT_MEMORY_READ_LINES` | const | Bounded read with truncation info (ADR D5 — `memory_get` foundation).  |
| `DEFAULT_MISTRAL_EMBEDDING_MODEL` | const | Mistral embedding adapter — OpenAI-compatible REST surface (`POST /v1/embeddings` against `https://api.mistral.ai`).  |
| `DEFAULT_OLLAMA_EMBEDDING_MODEL` | const | Model used when the caller names none: `nomic-embed-text`, 768 dimensions, roughly 274MB to pull.  |
| `DEFAULT_OPENAI_EMBEDDING_MODEL` | const | OpenAI embedding adapter (ADR D3) — built on the shared OpenAI-compatible factory.  |
| `DEFAULT_OPENROUTER_EMBEDDING_MODEL` | const | OpenRouter embedding adapter — routes through OpenRouter's `POST /api/v1/embeddings` endpoint (OpenAI-compatible request/response shape).  |
| `DEFAULT_VOYAGE_EMBEDDING_MODEL` | const | Voyage AI embedding adapter — `POST /v1/embeddings` at `https://api.voyageai.com` with the OpenAI-compatible `{ model, input }` request shape.  |
| `defaultIndexPath` | function | `<index root>/.index/memory.sqlite`.  |
| `DiaryEntry` | interface | Dream-diary append (ADR D7).  |
| `diaryPath` | function | `<memory root>/dream-diary.md`.  |
| `DiscoveredFile` | interface | One markdown file the corpus walk found, with the source bucket the indexer tags it with.  |
| `discoverSessionFiles` | function | Every session summary under `<memory root>/sessions`, as `{ absolutePath, relPath }` records.  |
| `discoverWikiFiles` | function | Every wiki supplement under `<memory root>/wiki`, as `{ absolutePath, relPath }` records.  |
| `DreamingOptions` | interface | Dreaming sweep orchestrator (ADR D7 of memory-system-peer-project-parity).  |
| `DreamingResult` | interface | What one sweep did.  |
| `dropVectorIndex` | function | Drop the `embeddings` table, discarding every stored vector.  |
| `EmbedAllArgs` | interface | Inputs for {@link embedMissingChunks } : the open database and the embedding runtime to call. |
| `EmbeddingCache` | interface | The cache contract the shared runtime writes through.  |
| `EmbeddingDialect` | interface | theokit#159 — the three points where a provider may deviate from the OpenAI embedding wire.  |
| `EmbeddingIdentity` | interface | The three facts that decide whether the vectors already stored are still usable: who produced them, with which model, at which width.  |
| `EmbeddingRuntime` | interface | A live embedding provider, bound to one model.  |
| `EmbeddingRuntimeStats` | interface | Counters accumulated by a runtime since it was created.  |
| `embedMissingChunks` | function | Embed every chunk that doesn't yet have a vector. |
| `entryHash` | function | A stable hash of one entry's counts, so two sweeps that did the same work read as the same work.  |
| `geminiMemoryEmbeddingProviderAdapter` | const | Google Gemini embeddings through Google's OpenAI-compatible surface at `/v1beta/openai/embeddings`.  |
| `identityMatches` | function | Compare two embedding identities field by field.  |
| `indexBudgetWarning` | function | What to say about an index that the interop partner will truncate, or `undefined` when there is nothing true to say.  |
| `IndexManager` | class | The default memory index: SQLite for storage, FTS5 for text matching, and sqlite-vec for vectors when an embedding runtime is supplied.  |
| `IndexStatus` | interface | A snapshot of index health.  |
| `isLanceAvailable` | function | Test helper for {@link LanceIndex } : indicates whether the Lance module is loadable in the current environment.  |
| `isSqliteVecLoaded` | function | Check whether sqlite-vec is loaded by running a tiny version query. |
| `jinaMemoryEmbeddingProviderAdapter` | const | Jina AI embeddings, over the standard OpenAI wire.  |
| `LanceFactRecord` | interface | One row of the Lance `facts` table, as it is stored.  |
| `LanceIndex` | class | Lance-backed memory index.  |
| `LanceMemoryAdapter` | class | Presents a `LanceIndex` as a {@link MemoryIndex } , so a consumer written against the SQLite index runs unchanged on `backend: "lance"`.  |
| `LanceSearchHit` | interface | One Lance search result.  |
| `LanceSearchOptions` | interface | Filters for `LanceIndex.search`.  |
| `lanceStoragePath` | function | `<memory root>/lance`.  |
| `legacyMemoryJsonPath` | function | Resolve the legacy JSON memory path used pre-ADR-D8 (kept for migration helpers + tests).  |
| `lightPhase` | function | Light phase — drop facts whose embedding is too similar to one already kept. |
| `listNotes` | function | List the `.md` files directly under `notes/`.  |
| `loadSqliteVecExtension` | function | Load the `sqlite-vec` extension into an opened SQLite connection.  |
| `mapOpenAICompatibleError` | function | Turn a failed OpenAI-shaped HTTP response into the typed error the SDK throws.  |
| `MEMORY_EMBEDDING_ADAPTERS` | const | Memory embedding adapter catalog, indexed by provider id.  |
| `MEMORY_INDEX_MAX_BYTES` | const | The byte limit the Claude Code CLI applies when it loads a `MEMORY.md`, whichever it reaches first.  |
| `MEMORY_INDEX_MAX_LINES` | const | The line limit the Claude Code CLI applies when it loads a `MEMORY.md`.  |
| `MemoryBackend` | type | Vector backend selector.  |
| `MemoryChunk` | interface | A semantically meaningful slice of a markdown memory file, produced by `chunkMarkdown`.  |
| `MemoryConfig` | interface | Per-agent memory configuration.  |
| `MemoryDb` | interface | Thin wrapper around the SQLite driver.  |
| `MemoryEmbeddingProviderAdapter` | interface | Memory embedding provider adapter contract (ADR D3 of memory-system-peer-project-parity).  |
| `MemoryFact` | interface | One remembered statement.  |
| `MemoryFileEntry` | interface | Lightweight reference to a markdown file in the memory corpus.  |
| `MemoryGetToolOptions` | interface | Options for {@link createMemoryGetTool } .  |
| `MemoryIndex` | interface | The four operations both backends implement, and the type every consumer should hold.  |
| `memoryIndexRoot` | function | Where the search index belongs for this configuration (theokit-sdk#554).  |
| `MemoryLocationConfig` | type | Only `directory` is read; the full config is accepted so callers pass what they already hold. |
| `memoryMdPath` | function | Path to `MEMORY.md`, the index that points at the per-memory files — and, in stores written before #389, the flat `## Facts` list itself.  |
| `MemoryReadResult` | interface | Result of `reader.readFile`.  |
| `memoryReadRoots` | function | Every directory a read must cover, deduplicated and in precedence order.  |
| `MemoryRoot` | type | A directory that has been RESOLVED as a memory root, distinguished from a bare `cwd`.  |
| `MemorySearchHit` | interface | Memory index manager contract — leaf types shared by `index-manager.ts` (orchestrator), `index-manager-dispatch.ts` (backend dispatch), `lance-memory-adapter.ts` (Lance backend), and `memory-index.... |
| `MemorySearchToolOptions` | interface | Options for {@link createMemorySearchTool } . |
| `MemoryTool` | interface | A memory tool ready to hand to the agent loop: the JSON-serialisable description an LLM sees, plus the `execute` that runs it.  |
| `MemoryToolJson` | interface | Memory tools (`memory_search` + `memory_get`) — ADR D5 of memory-system-peer-project-parity.  |
| `META_KEY_DIMENSION` | const | `meta` table key holding the vector width the `embeddings` vec0 table was created with. |
| `META_KEY_MODEL` | const | `meta` table key holding the embedding model id the vectors were produced with. |
| `META_KEY_PROVIDER_ID` | const | `meta` table key holding the id of the embedding provider that produced the vectors currently on disk (for example `openai`, `ollama`). |
| `migrateLegacyJson` | function | Move facts from the pre-markdown JSON store into `MEMORY.md`, once.  |
| `MigrateOptions` | interface | Migrate Memory.index from SQLite to LanceDB (ADR D44).  |
| `MigrateResult` | interface | Outcome of {@link migrateSqliteToLance } .  |
| `migrateSqliteToLance` | function | Run the migration.  |
| `MigrationResult` | interface | Outcome of {@link migrateLegacyJson } .  |
| `mistralMemoryEmbeddingProviderAdapter` | const | Mistral embeddings, over the standard OpenAI wire.  |
| `NoteFile` | interface | One note discovered under `notes/`: its file name without the `.md` suffix, and its absolute path. |
| `notesDir` | function | Path to `<memory root>/notes`, where per-topic notes and the consolidated notes a dreaming sweep writes live.  |
| `ollamaMemoryEmbeddingProviderAdapter` | const | Embeddings from a local Ollama instance — the only adapter in the catalog with `transport: "local"`, and the one to choose when the corpus must not leave the machine or when there is no API key to ... |
| `OpenAiCompatibleConfig` | interface | What one provider adapter tells {@link createOpenAiCompatibleRuntime } about its wire: where to POST, which environment variables carry the key and the base URL, which model to use by default, and ... |
| `openAiMemoryEmbeddingProviderAdapter` | const | OpenAI embeddings — `text-embedding-3-small` (1536), `text-embedding-3-large` (3072) and `text-embedding-ada-002` (1536).  |
| `OpenDbOptions` | interface | Options for {@link openMemoryDb } . |
| `OpenIndexOptions` | interface | Options for `IndexManager.open`.  |
| `openLanceIndex` | function | Lance-path open.  |
| `OpenLanceOptions` | interface | Options for `LanceIndex.open`.  |
| `openMemoryDb` | function | Open (or create) the SQLite memory index at `filePath`, applying the pragmas and creating the schema before returning.  |
| `openRouterMemoryEmbeddingProviderAdapter` | const | Embeddings routed through OpenRouter, which lets one key reach several upstream providers.  |
| `packVector` | function | Pack a Float32Array into a Buffer suitable for sqlite-vec BLOB binding. |
| `parseRetryAfter` | function | Parse `retry-after` header in numeric-seconds form.  |
| `parseSearchOptions` | function | Common search-options parser used by both `IndexManager.search` and `LanceMemoryAdapter.search`.  |
| `persistActiveMemoryTranscript` | function | Write one active-memory recall transcript under `<memory root>/transcripts/active-memory`.  |
| `PRAGMA_STATEMENTS` | const | Non-WAL pragmas.  |
| `projectMemoryDir` | function | The project store: `<cwd>/.theokit/memory`.  |
| `readAllSqliteFacts` | function | Read all facts from the SQLite memory index.  |
| `readEmbeddingIdentity` | function | Read the embedding identity recorded in the `meta` table.  |
| `readFacts` | function | Every memory in the store, honouring the `enabled` gate on {@link MemoryConfig } : when memory is disabled the call resolves to `[]` without touching disk.  |
| `readFactsFromMarkdown` | function | Every memory in the store: the per-memory files, plus any legacy `## Facts` bullets still in `MEMORY.md`.  |
| `ReadFileOptions` | interface | Inputs for {@link readMemoryFileBounded } .  |
| `readMemoryFileBounded` | function | Read a bounded slice of a text file and report what was left behind.  |
| `redactSecrets` | function | Canonical credential-redaction primitive (ADR D68).  |
| `remPhase` | function | REM phase — single-link agglomerative clustering by cosine similarity. |
| `renderDiaryEntry` | function | One diary entry as the markdown that gets appended: a timestamp heading, the short entry hash, and the counts the sweep produced.  |
| `resetMigrationStateForTests` | function | Test-only — reset the in-process migration flag map. |
| `resolveMemoryRoot` | function | The memory root for this agent: `memory.directory` when set, the project store otherwise.  |
| `runActiveMemory` | function | Run one blocking recall before the system prompt is assembled, and report what happened.  |
| `RunActiveMemoryArgs` | interface | Everything {@link runActiveMemory } needs for one attempt.  |
| `runDreamingSweep` | function | Run one consolidation sweep over `MEMORY.md`: drop near-duplicate facts, cluster what is left, write a consolidated note under `notes/`, and append a diary entry.  |
| `SCHEMA_STATEMENTS` | const | SQLite schema for the memory index.  |
| `SearchOptions` | interface | Search tuning.  |
| `SessionFile` | interface | Session summary discovery (ADR D20).  |
| `sessionsDir` | function | `<memory root>/sessions`.  |
| `SessionSummaryInput` | interface | Per-run session summary writer (ADR D20).  |
| `sessionSummaryPath` | function | The file one run's summary occupies: `<memory root>/sessions/<safe-id>.md`.  |
| `SqliteFactRow` | interface | One row of the SQLite memory index, as the Lance migration reads it: the chunk plus the tenant columns the target table needs.  |
| `SyncResult` | interface | What one `sync()` did.  |
| `TenantContext` | interface | T4.9 — Tenant isolation context for cache key derivation.  |
| `truncateRaw` | function | Truncate raw response body to ~2KB and redact known credential patterns so it can ride inside `ErrorMetadata.raw` without ballooning logs OR leaking tokens.  |
| `upsertEmbedding` | function | Store the vector for one chunk, replacing any vector already held for it.  |
| `VALID_BACKENDS` | const | Valid backend identifiers — runtime guard against TS-narrowing escapes (EC-1). |
| `VectorHitRow` | interface | One row of a vec0 KNN result: the chunk id and its raw distance from the query vector.  |
| `vectorSearch` | function | Run a k-nearest-neighbour query against the `embeddings` table and return the matches ordered by ascending distance (closest first).  |
| `voyageMemoryEmbeddingProviderAdapter` | const | Voyage AI embeddings, over the standard OpenAI wire.  |
| `wikiDir` | function | `<memory root>/wiki`.  |
| `WikiFile` | interface | Wiki supplement discovery (ADR Phase 10 of memory-system-peer-project-parity).  |
| `writeEmbeddingIdentity` | function | Record the embedding identity in the `meta` table, upserting each of the three keys.  |
| `writeSessionSummary` | function | Write a session summary file.  |

## `@theokit/sdk-pty`

| Symbol | Kind | Summary |
|---|---|---|
| `clampYield` | function | Bound the yield window to [ {@link YIELD_MIN_MS } , {@link YIELD_MAX_MS } ]. |
| `MaxSessionsError` | class | M77 — the {@link PtyInteractiveBackendOptions.maxSessions } ceiling was reached.  |
| `PtyInteractiveBackend` | class | `InteractiveBackend` backed by a real pty, for programs that only behave correctly on a terminal.  |
| `PtyInteractiveBackendOptions` | interface | Constructor options for {@link PtyInteractiveBackend } .  |
| `YIELD_MAX_MS` | const | Ceiling for `StartInteractiveOptions.yieldMs`, clamped down.  |
| `YIELD_MIN_MS` | const | Floor for `StartInteractiveOptions.yieldMs` — how long a call waits for the process to produce output before returning what it has.  |

## `@theokit/sdk-tools`

| Symbol | Kind | Summary |
|---|---|---|
| `buildEnvContext` | function | Render a portable `<env>` orientation block.  |
| `buildRepoMap` | function | Render a char-bounded, depth-limited directory tree.  |
| `CatastrophicCommandError` | class | Thrown / reported when a command matches the catastrophic deny-list. |
| `catastrophicShellReason` | function | Return a human-readable reason when `command` is catastrophic/irreversible, or `null`.  |
| `commandDenialReason` | function | The first deny reason across `policies` (deny-wins), or `null` if every policy allows.  |
| `CommandPolicy` | type | A pure command-permission predicate: returns a non-empty deny reason, or `null` to allow.  |
| `ContextMatchError` | class | Thrown by {@link replaceUnique } when the replacement cannot be made safely.  |
| `ContextMatchReason` | type | Context-tolerant single-occurrence text matching (`seek_sequence` parity, ported from the AgentBuilder Codex clone, M10/M13).  |
| `createApplyPatchTool` | function | Build the `apply_patch` tool over Codex's V4A patch grammar — one call that adds, updates, deletes and moves several files at once.  |
| `CreateApplyPatchToolOptions` | interface | `apply_patch` — built-in tool for coding agents.  |
| `createBraveWebSearchAdapter` | function | Build a `WebSearchCallback` backed by the Brave Search API.  |
| `CreateBraveWebSearchAdapterOptions` | interface | Options for {@link createBraveWebSearchAdapter } .  |
| `createCurrentTimeTool` | function | Build the `current_time` tool, so the model reads a clock instead of stating a date from training data.  |
| `CreateCurrentTimeToolOptions` | interface | `current_time` — built-in tool for coding agents.  |
| `createEditFileTool` | function | Build the `edit_file` tool: replace one occurrence of `old_string` with `new_string` in place, after copying the previous content to `<path>.bak`.  |
| `CreateEditFileToolOptions` | interface | `edit_file` — built-in tool for coding agents.  |
| `createGenericHttpSearchAdapter` | function | Build a `WebSearchCallback` backed by a generic HTTP search endpoint.  |
| `CreateGenericHttpSearchAdapterOptions` | interface | Options for {@link createGenericHttpSearchAdapter } .  |
| `createGitDiffTool` | function | Build the `git_diff` tool: `git diff --no-color` over the working tree, or the staged changes when the model passes `cached`.  |
| `CreateGitDiffToolOptions` | interface | `git_diff` — built-in tool for coding agents.  |
| `createGitStatusTool` | function | Build the `git_status` tool.  |
| `CreateGitStatusToolOptions` | interface | `git_status` — built-in tool for coding agents.  |
| `createGlobTool` | function | Build the `glob_files` tool: find files by the shape of their name.  |
| `CreateGlobToolOptions` | interface | `glob_files` — built-in tool for coding agents.  |
| `createInteractiveShellTool` | function | Start an interactive session; returns a `session_id` to drive with `write_stdin`. |
| `CreateInteractiveShellToolOptions` | interface | `interactive_shell` + `write_stdin` — built-in tools for driving an interactive session (a REPL, `git rebase -i`, any command that PROMPTS for stdin).  |
| `createListDirTool` | function | Build the `list_dir` tool: the direct entries of one directory as `{ name, type }`.  |
| `CreateListDirToolOptions` | interface | `list_dir` — built-in tool for coding agents.  |
| `createPlanModeTool` | function | Build the `plan_mode` tool, which flips a flag and returns instruction text telling the model to outline before it edits.  |
| `createQuestionTool` | function | Build the `question` tool: the agent stops, asks the user something, and the turn waits for the answer.  |
| `createReadFileTool` | function | Build the `read_file` tool.  |
| `CreateReadFileToolOptions` | interface | `read_file` — built-in tool for coding agents.  |
| `createRunVitestTool` | function | Build the `run_vitest` tool: run the project's suite and return the counts rather than the log.  |
| `CreateRunVitestToolOptions` | interface | `run_vitest` — built-in tool for coding agents.  |
| `createSearchTextTool` | function | Build the `search_text` tool: scan file CONTENTS across the tree.  |
| `CreateSearchTextToolOptions` | interface | `search_text` — built-in tool for coding agents.  |
| `createSessionArtifactStore` | function | Create a generic artifact store rooted at `dir`.  |
| `createShellTool` | function | Build the `shell_exec` tool: run a command through `/bin/sh -c` with `projectRoot` as the working directory.  |
| `CreateShellToolOptions` | interface | `shell_exec` — built-in tool for coding agents.  |
| `createTodolistTool` | function | Build the `todolist` tool: an in-memory checklist the agent keeps across the turns of one session.  |
| `createUpdatePlanTool` | function | `update_plan` — built-in tool for coding agents.  |
| `createViewImageTool` | function | Read an image from the project so the model can look at it. |
| `CreateViewImageToolOptions` | interface | Options for {@link createViewImageTool } .  |
| `createWebFetchTool` | function | Build the `web_fetch` tool: retrieve one URL over HTTP or HTTPS and hand the model the body as text.  |
| `CreateWebFetchToolOptions` | interface | `web_fetch` — built-in tool for coding agents.  |
| `createWebSearchTool` | function | Build the `web_search` tool over a caller-supplied provider.  |
| `CreateWebSearchToolOptions` | interface | Options for {@link createWebSearchTool } .  |
| `createWriteFileTool` | function | Build the `write_file` tool.  |
| `CreateWriteFileToolOptions` | interface | Options for {@link createWriteFileTool } .  |
| `createWriteStdinTool` | function | Write to a live interactive session's stdin and read the output it produces. |
| `DEFAULT_MAX_IMAGE_BYTES` | const | Default ceiling: 5 MB on disk.  |
| `DEFAULT_TOOL_GUIDANCE` | const | Curated hints for the common cross-tool error codes.  |
| `denyCatastrophicCommands` | function | A policy that denies catastrophic commands by composing the M3-2 guardrail. |
| `EnvContextOptions` | interface | Options for {@link buildEnvContext } .  |
| `formatCode` | function | Wrap code in a fenced code block with language tag. |
| `formatDiff` | function | Format a unified diff with +/- prefixes preserved. |
| `formatError` | function | Format an error message as a markdown block. |
| `formatFileList` | function | Format a list of file paths as a bulleted markdown list. |
| `injectGuidance` | function | Pure: parse a tool handler's JSON output and ADD a `guidance` hint when the result is an `{ ok: false, error }` object whose code has a hint and that does not already carry guidance.  |
| `isBlockedIp` | function | True if `ip` is a blocked address (private/loopback/link-local/CGNAT/metadata/ reserved).  |
| `isCommandAllowed` | function | `true` when no policy denies `command` (an empty policy array allows everything). |
| `PlanModeTool` | interface | The `plan_mode` tool object returned by the no-argument {@link createPlanModeTool } .  |
| `PlanModeToolOptions` | interface | Options for the persistence-enabled {@link createPlanModeTool } overload. |
| `PlanModeToolWithStore` | interface | Plan-mode tool with opt-in artifact persistence (M4-4).  |
| `PlanNode` | interface | A flat plan-render node — the stable shape a UI/plan layer consumes.  |
| `QuestionTool` | interface | M76 — aligned with the SDK's `CustomTool`.  |
| `QuestionToolOptions` | interface | `question` — interactive tool that asks the user a question and waits for a response.  |
| `ReadTracker` | class | `ReadTracker` — SE32 read-before-write safety.  |
| `ReasoningTools` | class | Reasoning scratchpad tools.  |
| `RedirectBlockedError` | class | Thrown when a request is refused by the REDIRECT policy (the `maxRedirects` hop limit was exceeded) — a distinct event from {@link SsrfBlockedError } (a blocked host).  |
| `renderToolList` | function | Render the agent's actual `CustomTool[]` — single source of truth, so an overridden/added/removed tool is reflected automatically.  |
| `replaceUnique` | function | Return `content` with the single occurrence of `find` replaced by `replace`, using the two-stage context-tolerant matcher.  |
| `RepoMapOptions` | interface | Repo-map / env-context builders for orienting an LLM coding agent (M3-3).  |
| `resolveAndScreen` | function | Resolve `host` to ALL its addresses and screen each.  |
| `ResolveAndScreenOptions` | interface | Options for {@link resolveAndScreen } . |
| `screenedFetch` | function | Fetch `url` with SSRF screening: screens the host (unless `allowPrivateHosts`), sets `redirect:"manual"`, and re-screens every redirect hop (rejecting a hop to a blocked host or a non-http(s) targe... |
| `ScreenedFetchOptions` | interface | Options for {@link screenedFetch } . |
| `SessionArtifactStore` | interface | A generic, id-keyed, atomic artifact store.  |
| `SessionArtifactStoreOptions` | interface | Options for {@link createSessionArtifactStore } . |
| `SsrfBlockedError` | class | Thrown when a host/redirect resolves to a blocked (private/reserved) address. |
| `TodoItem` | interface | `todolist` — in-session task tracking for multi-step work.  |
| `todoItemsToPlanNodes` | function | Convert structured todo items (from a `todolist` tool result's `items`, M4-5) into versioned `PlanNode`s for rendering.  |
| `TodolistTool` | interface | The `todolist` tool object.  |
| `ToolGuidanceMap` | type | Maps a tool error code to a short, LLM-actionable self-correction hint. |
| `truncateOutput` | function | Bound a block of tool output to `maxBytes`, spilling the full text to a file when it does not fit.  |
| `TruncationMode` | type | How the middle is dropped when output exceeds the budget. |
| `TruncationOptions` | interface | Options for {@link truncateOutput } .  |
| `TruncationResult` | interface | What {@link truncateOutput } returns.  |
| `VitestSummary` | interface | The fields lifted from vitest's JSON report.  |
| `WebSearchCallback` | type | The search provider {@link createWebSearchTool } calls.  |
| `WebSearchResult` | interface | `web_search` — built-in tool for coding agents.  |
| `withDefaultGuidance` | function | `withToolResultGuidance` pre-bound to {@link DEFAULT_TOOL_GUIDANCE } . |
| `withDescription` | function | Return a new `CustomTool` with `description` replaced.  |
| `withName` | function | Return a new `CustomTool` exposed under a different `name`, sharing the SAME `inputSchema` + `handler` (alias parity).  |
| `withShellExitGuidance` | function | Wrap `shell_exec` so a SOFT failure — `{ ok: true, exit_code != 0 }` (the TOOL ran, the COMMAND failed) — gains a `guidance` hint.  |
| `withToolResultGuidance` | function | Wrap a `CustomTool` so its failed results gain a `guidance` hint from `guidance`.  |

## `@theokit/sdk/a2a`

| Symbol | Kind | Summary |
|---|---|---|
| `A2AMessage` | interface | One message as a handler receives it.  |
| `A2APeerNotRegisteredError` | class | Thrown by {@link MessageBus.send } and {@link MessageBus.request } when `to` has no registered handler.  |
| `A2ARequestTimeoutError` | class | A peer did not answer a {@link MessageBus.request } within its timeout.  |
| `AgentMailbox` | class | One agent's endpoint on a {@link MessageBus } : registers `agentId` on construction and forwards inbound messages to the handler installed by `onMessage`.  |
| `DelegationCompleteContext` | interface | Context passed to {@link SubAgentSpec.onDelegationComplete } after the child settles. |
| `DelegationCompleteDecision` | interface | Decision returned from {@link SubAgentSpec.onDelegationComplete } . |
| `DelegationStartContext` | interface | Context passed to {@link SubAgentSpec.onDelegationStart } before the child runs. |
| `DelegationStartDecision` | type | Decision returned from {@link SubAgentSpec.onDelegationStart } .  |
| `MaxDelegationDepthError` | class | Raised by `SubAgent.create(spec, parentDepth)` when `parentDepth + 1` exceeds `spec.maxDelegationDepth` (default 3).  |
| `MessageBus` | class | In-process router that delivers A2A messages between agents keyed by string id.  |
| `MessageFilterArgs` | interface | Arguments passed to {@link SubAgentSpec.messageFilter } (SE12). |
| `MessageHandler` | type | What an agent does with an inbound {@link A2AMessage } .  |
| `RequestOptions` | interface | Per-call knobs for {@link MessageBus.request } / `AgentMailbox.request`. |
| `SubAgent` | class | SE36 — `SubAgent.create` replaces `defineSubAgent` (ADR 0015). |
| `SubAgentSpec` | interface | The declaration of a delegating child agent, handed to `SubAgent.create(spec)`.  |
| `ToolContextMessage` | interface | SE12 — a read-only, text-only projection of one turn of the run's conversation, exposed to a tool handler via `ctx.messages`.  |

## `@theokit/sdk/auth`

| Symbol | Kind | Summary |
|---|---|---|
| `assertSecureModes` | function | The 0700-dir / 0600-file mode gates (ported verbatim).  |
| `authFilePath` | function | The credential file path inside the (possibly overridden) store directory. |
| `CredentialError` | class | A credential problem the caller can act on.  |
| `credentialHome` | function | The store directory, honoring an optional `homeEnvVar` override. |
| `CredentialStoreConfig` | interface | Where the credential store lives — the three path segments, plus an optional environment override.  |
| `DeviceCodeGrant` | interface | The device authorization the user acts on.  |
| `DeviceDeps` | interface | Injected effects for the device flow — deterministic in tests, real in production. |
| `deviceLogin` | function | The full device login: request a code, hand the user the verification URL + user code via `onPrompt` (never printed here — the caller renders it, keeping this module output-free), then poll to comp... |
| `DeviceOAuthConfig` | interface | A device-grant config: the OAuth config plus the RFC 8628 device authorization endpoint. |
| `ensureFreshCredential` | function | Return a credential guaranteed fresh enough to use.  |
| `exchangeCode` | function | Exchange an authorization `code` (+ PKCE verifier) for the token pair. |
| `extractAccountId` | function | Best-effort account id from an id/access token's claims (OpenAI/ChatGPT shape). |
| `HttpDeps` | interface | Injected HTTP + clock effects — deterministic in tests, real in production. |
| `OAuthProviderConfig` | interface | A provider's OAuth endpoints + client identity.  |
| `OAuthTokens` | interface | The token triple persisted to the store's oauth variant. |
| `OpenAIDeviceConfig` | interface | The OpenAI two-step device config: usercode + poll endpoints return an authorization_code (not tokens). |
| `openaiDeviceLogin` | function | Step 2+3 (OpenAI) — poll for the authorization code (200 = ready; 403/404 = pending; else fail), then exchange it for tokens at the standard `/oauth/token` endpoint (reuses `exchangeCode`). |
| `parseJwtClaims` | function | Decode a JWT's claim set (no signature verification — used only to read a self-reported account id). |
| `persistOAuthTokens` | function | Persist a token triple to the store's oauth variant through the hardened 0600 writer. |
| `pollDeviceToken` | function | Step 2 — poll the token endpoint until the user approves (or the code expires).  |
| `providerFromApiKeyPrefix` | function | The provider whose key prefix matches, or `undefined` when none does.  |
| `readAuthFile` | function | Read the credential file.  |
| `readStoredOAuth` | function | Read the stored OAuth credential (with its refresh token), or `undefined` when the store is absent or holds an api credential.  |
| `refreshOAuthTokens` | function | Swap a refresh token for a fresh access (and possibly rotated refresh) token. |
| `requestDeviceCode` | function | Step 1 — request a device code.  |
| `requestOpenAIUsercode` | function | Step 1 (OpenAI) — request the user code. |
| `resolveCredential` | function | Resolve a fresh credential for `provider` from the store, or `undefined` if the store holds none for it.  |
| `ResolveCredentialOptions` | interface | Input to `resolveCredential`: which provider, which store, and what to inject.  |
| `ResolvedCredential` | interface | The flat bearer surface every consumer holds.  |
| `StoredApiCredential` | interface | The API-key variant of the credential file, as it sits on disk.  |
| `StoredCredential` | type | Whatever the credential file turned out to hold — the two variants are discriminated by `type`.  |
| `StoredOAuthCredential` | interface | The OAuth variant of the credential file, as it sits on disk.  |
| `writeCredential` | function | Persist a credential atomically at mode `0600`.  |

## `@theokit/sdk/client`

| Symbol | Kind | Summary |
|---|---|---|
| `ClientOptions` | interface | Client SDK types (T20.2, ADR D454). |
| `SendResponse` | interface | Body of `POST <basePath>/send` as {@link TheoKitClient.send } resolves it.  |
| `StreamEvent` | interface | One decoded SSE frame from {@link TheoKitClient.stream } : the JSON body of a `data:` line, with `type` promoted and every other key left open.  |
| `TheoKitClient` | class | Browser-safe client for the legacy agent HTTP contract: `POST <basePath>/send` and `GET <basePath>/stream`.  |

## `@theokit/sdk/compaction`

| Symbol | Kind | Summary |
|---|---|---|
| `ABSOLUTE_CONTEXT_WINDOW_CAP` | const | Absolute cap on a declared context window, applied when no catalog entry exists to compare against.  |
| `buildCheckpoint` | function | Build a checkpoint marker turn (a `system` turn whose content starts with `marker`, default {@link CHECKPOINT_MARKER } ).  |
| `CHARS_PER_TOKEN` | const | Characters per token in the tokenizer-free estimate below.  |
| `CHECKPOINT_MARKER` | const | Sentinel prefix marking a conversation checkpoint turn.  |
| `compactTranscript` | function | Compact a transcript.  |
| `CompactTranscriptOptions` | interface | Options for {@link compactTranscript } . |
| `CompressibleMessage` | interface | Minimal message shape for compaction/compression input.  |
| `CONTEXT_WINDOW_FLOOR` | const | M77 — the floor used ONLY when neither the catalog nor the caller knows the window.  |
| `CONTEXT_WINDOW_MARGIN` | const | M77 — default safety margin on the context window.  |
| `ContextWindowMarginError` | class | M77 — the margin is outside `(0, 1]`.  |
| `ContextWindowSource` | type | Where the effective window came from — carried into the M77 structured event. |
| `EffectiveContextWindow` | interface | Result of {@link resolveEffectiveContextWindow } . |
| `EffectiveContextWindowInput` | interface | Input to {@link resolveEffectiveContextWindow } . |
| `estimateTokens` | function | Tokenizer-free token estimate via the conventional ~4-chars-per-token heuristic: `ceil(text.length / CHARS_PER_TOKEN)`.  |
| `FilterCheckpointOptions` | interface | Options for {@link filterFromLatestCheckpoint } . |
| `filterFromLatestCheckpoint` | function | Return the turns relative to the most recent checkpoint marker (all turns if none).  |
| `isContextOverflowError` | function | True iff `err` is a {@link TheokitAgentError } (or subclass) reporting a context-window-exceeded condition (the typed `context_too_long` code).  |
| `resolveEffectiveContextWindow` | function | Resolve the window to budget against — the fail-SAFE replacement for reading the catalog directly.  |
| `shouldCompact` | function | Decide BEFORE sending whether to compact: `true` when the `estimated` token count leaves less than `buffer` headroom in the `contextWindow` (`estimated >= contextWindow - buffer`).  |
| `ShouldCompactInput` | interface | Input to {@link shouldCompact } : an estimate, the model's window, and reserved headroom. |
| `SUMMARY_TEMPLATE` | const | The 7-section summary template handed to the `summarize` callback (theocode parity shape).  |

## `@theokit/sdk/concurrency`

| Symbol | Kind | Summary |
|---|---|---|
| `AsyncSemaphore` | interface | Async-aware counting semaphore (ADR D135).  |
| `mapWithConcurrency` | function | Map `fn` over `items` with bounded concurrency, preserving order. |
| `Semaphore` | class | SE36 — `Semaphore.create` replaces `createSemaphore` (ADR 0015). |

## `@theokit/sdk/context`

| Symbol | Kind | Summary |
|---|---|---|
| `DEFAULT_DISCOVERY_SPECS` | const | The context files theokit looks for out of the box, in the order they are concatenated.  |
| `DiscoveryParser` | type | Parser to apply once file is read. |
| `DiscoveryRunnerOptions` | interface | Input to the context-discovery run: where to walk, how much of each file to keep, and which trust boundary an `@import` may not cross.  |
| `DiscoveryScope` | type | Single filename ("AGENTS.md") or relative glob (".cursor/rules/*.mdc"). |
| `DiscoverySpec` | interface | One kind of context file the runner knows how to find and read.  |
| `parseRules` | function | Split a `.theokit/rules/*.md` document into its frontmatter and its body.  |
| `resolveContextImports` | function | Expand `@path` import directives in `content`, confined to `options.projectRoot`.  |
| `ResolveContextImportsOptions` | interface | Options for {@link resolveContextImports } .  |
| `runDiscovery` | function | Find, read and parse every context file the specs describe, and return them ready for the aggregator.  |
| `shouldActivateRule` | function | Decide whether a parsed rule applies to this turn, given the files in scope.  |

## `@theokit/sdk/cron`

| Symbol | Kind | Summary |
|---|---|---|
| `Cron` | class | Static façade for scheduling Theo agent runs on a cron expression. |

## `@theokit/sdk/errors`

| Symbol | Kind | Summary |
|---|---|---|
| `AgentDisposedError` | class | T1.6 — Thrown when a consumer calls `agent.send()` or any method on an agent that has already been `dispose()`d.  |
| `AgentRunError` | class | Thrown by `Agent.prompt` (and helpers that go through `run.wait()`) when the option `{ throwOnError: true }` is set and the run terminates with `status: 'error'`.  |
| `AgentRunErrorCode` | type | Back-compat alias of {@link KnownAgentRunErrorCode } .  |
| `AuthenticationError` | class | Invalid API key, not logged in, insufficient permissions. |
| `BudgetExceededError` | class | Thrown by `Budget` enforcement (ADR D386) when a `mode: "block"` budget would be exceeded by the upcoming LLM call.  |
| `coerceToKnownAgentRunErrorCode` | function | T1.1 boundary helper — coerce an arbitrary string (typically arriving from a downstream `RunErrorDetail.code` or a deserialized cloud response) into a `KnownAgentRunErrorCode`.  |
| `ConfigurationError` | class | Invalid model, bad request parameters, malformed options. |
| `CredentialPoolExhaustedError` | class | Thrown when every credential in a per-provider pool is in cooldown and no healthy key is available (ADR D133).  |
| `ErrorCode` | type | Finite, machine-readable error codes for provider-originated errors (ADR D66).  |
| `ErrorMetadata` | interface | Structured context for errors that originated from a provider HTTP call (ADR D65).  |
| `IntegrationNotConnectedError` | class | Thrown when creating a cloud agent for a repo whose SCM provider is not connected.  |
| `InvalidTaskIdError` | class | Thrown when a user-supplied task ID violates the grammar `^[a-z0-9][a-z0-9_-]*$` (D368) OR starts with a reserved adapter prefix (`wf-` / `b-` / `cron-`, EC-5). |
| `isTransientError` | function | Is this error transient (worth retrying)?  |
| `KnownAgentRunErrorCode` | type | T1.1 — closed literal union for `AgentRunError.code`.  |
| `MemoryAdapterError` | class | Error raised by `@theokit-memory-*` adapters.  |
| `MemoryAdapterErrorCode` | type | Finite error codes specific to memory adapter operations (ADR D141). |
| `NetworkError` | class | Service unavailable, timeout, transport-level failure. |
| `RateLimitError` | class | Too many requests or usage limits exceeded. |
| `StructuredOutputError` | class | The failure contract shared by `generateObject` and `streamObject`.  |
| `StructuredOutputErrorCode` | type | Why a structured-output call failed.  |
| `TaskNotFoundError` | class | Thrown when `Task.subscribe(id)` is called for a task that has been evicted, never submitted, or evicted after retention (D373). |
| `TheokitAgentError` | class | Base class for all errors thrown by `@theokit/sdk`.  |
| `UnknownAgentError` | class | Catch-all for unclassified server or runtime errors. |
| `UnsupportedBudgetOperationError` | class | Thrown when a budget operation is requested on a `CloudAgent` (D388).  |
| `UnsupportedRunOperationError` | class | Thrown when a {@link Run } or agent operation is not available on the current runtime.  |
| `UnsupportedTaskOperationError` | class | Thrown when `CloudAgent` is asked to wrap a task (D370).  |

## `@theokit/sdk/eval`

| Symbol | Kind | Summary |
|---|---|---|
| `assertEval` | function | Assert a run meets every set threshold.  |
| `captureArtifact` | function | Capture the working-tree diff of `repoDir` and check it reverse-applies.  |
| `Dataset` | type | `Dataset` is either an array OR a factory returning a (sync or async) iterable (D210).  |
| `DatasetEntry` | interface | A single dataset row — input prompt + optional reference + free-form metadata. |
| `Eval` | class | One eval definition — a dataset, at least one scorer, and the agent under test.  |
| `EvalAgentOptions` | type | Inferred `Agent.create` options shape — avoid cycling through `AgentOptions` directly. |
| `EvalAggregate` | interface | Aggregate stats — the production-decision dashboard data (D211). |
| `EvalAlreadyRunningError` | class | D213 — single-flight guard for `Eval.run`.  |
| `EvalHooks` | interface | Lifecycle hooks.  |
| `EvalOptions` | interface | Public options for `Eval.create`. |
| `EvalPersistOptions` | interface | Crash-durable persistence for `eval.run(...)` (M6-1).  |
| `EvalRowResult` | interface | Per-row outcome. |
| `EvalRun` | interface | Final run result — plain serializable JSON (D209). |
| `EvalRunOptions` | interface | Per-call options for `eval.run(...)`. |
| `EvalThresholdError` | class | Thrown by {@link assertEval } when a run misses one or more thresholds. |
| `EvalThresholdFailure` | interface | One unmet threshold, surfaced on `EvalThresholdError.failures`. |
| `EvalThresholds` | interface | Threshold contract for `assertEval(run, thresholds)` (SE41) — the CI gate.  |
| `JsonlParseError` | class | Raised when a JSONL line is not valid JSON or is not a JSON object.  |
| `loadJsonl` | function | Parse a JSONL file into rows.  |
| `NamedScorer` | interface | A named scorer — produced by every `Scorers.*` factory. |
| `PerScorerStats` | interface | Per-scorer breakdown computed across all rows. |
| `Score` | interface | Outcome of a single scoring decision.  |
| `Scorer` | type | Scorer signature (D207).  |
| `Scorers` | const | The built-in scorer factories for {@link Eval } .  |
| `VerifyGateOptions` | interface | Options for `Scorers.verifyGate` (M6-2) — grade a patch by running the project's tests in a provisioned repo and reading the exit code. |

## `@theokit/sdk/filesystem`

| Symbol | Kind | Summary |
|---|---|---|
| `FileNotFoundError` | class | A read/stat targeted a path that does not exist. |
| `FileStat` | interface | Structured file metadata.  |
| `FilesystemBackend` | class | Pluggable filesystem backend.  |
| `FilesystemConfig` | interface | Construction options shared by every {@link FilesystemBackend } .  |
| `FilesystemError` | class | A filesystem I/O operation failed for a reason other than not-found / read-only / stale / security (e.g.  |
| `FilesystemProvider` | type | A backend OR a per-request resolver of one.  |
| `FilesystemReadOnlyError` | class | A write was attempted on a read-only backend. |
| `FilesystemSecurityError` | class | A path escaped the backend's `basePath` (traversal or symlink). |
| `LocalFilesystem` | class | {@link FilesystemBackend } over the real filesystem (`node:fs/promises`), with every path resolved inside `basePath` and escapes rejected.  |
| `resolveFilesystem` | function | Resolve a {@link FilesystemProvider } to a concrete backend for `ctx`. |
| `StaleFileError` | class | SE32 — a write's `expectedMtime` did not match the file's current mtime: the file changed since it was last read, so the write would silently clobber. |
| `WriteFileOptions` | interface | Options a write may carry.  |

## `@theokit/sdk/interactive`

| Symbol | Kind | Summary |
|---|---|---|
| `InteractiveBackend` | class | Pluggable interactive-session backend.  |
| `InteractiveProvider` | type | A backend OR a per-request resolver of one — mirrors {@link FilesystemProvider } .  |
| `InteractiveUnavailableError` | class | Thrown when the interactive path is requested but no backend can provide it (no provider injected, or a local backend whose native module / spawn failed).  |
| `NoSuchSessionError` | class | Thrown (typed) when a write/kill targets an unknown or already-exited session, so callers branch on the type instead of string-matching a message.  |
| `resolveInteractive` | function | Resolve an {@link InteractiveProvider } to a concrete backend for `ctx`. |
| `StartInteractiveOptions` | interface | Bounds a start call.  |
| `StartInteractiveResult` | interface | Result of starting a session: its id + whatever the program printed on startup. |
| `WriteStdinOptions` | interface | Bounds a write call. |
| `WriteStdinResult` | interface | Result of writing to a session: the output produced during the yield window + liveness. |

## `@theokit/sdk/internal/memory-adapters`

| Symbol | Kind | Summary |
|---|---|---|
| `createOpenAiCompatibleRuntime` | function | Build an {@link EmbeddingRuntime } for a provider that speaks the OpenAI embedding wire — or, through `cfg.dialect`, one that deviates from it in a known way.  |
| `EmbeddingDialect` | interface | theokit#159 — the three points where a provider may deviate from the OpenAI embedding wire.  |
| `globalEmbeddingCache` | const | T4.4 — Process-wide singleton embedding cache (DR4 finding #4).  |
| `LruEmbeddingCache` | class | Bounded in-memory LRU cache for embeddings, keyed by `sha256(text)` (or any stable key the caller chooses).  |
| `OpenAiCompatibleConfig` | interface | What one provider adapter tells {@link createOpenAiCompatibleRuntime } about its wire: where to POST, which environment variables carry the key and the base URL, which model to use by default, and ... |

## `@theokit/sdk/internal/memory-store`

| Symbol | Kind | Summary |
|---|---|---|
| `ActiveMemoryTranscript` | interface | Optional on-disk persistence for Active Memory recall transcripts (ADR D6).  |
| `appendDiaryEntry` | function | Append one sweep's entry to `<memory root>/dream-diary.md`, creating the file with its header when this is the first sweep.  |
| `appendFact` | function | Record a fact, honouring the `enabled` gate on {@link MemoryConfig } : when memory is disabled the call resolves without touching disk.  |
| `appendFactToMarkdown` | function | Write a fact as its own memory file and point the `MEMORY.md` index at it.  |
| `asMemoryRoot` | function | Treat a directory as a memory root without resolving one.  |
| `claudeProjectMemoryDir` | function | Where the Claude Code CLI keeps THIS project's memories.  |
| `collectMarkdownFiles` | function | Every markdown file the memory corpus holds: the index, the per-memory files, `notes/`, `wiki/` and `sessions/`, each tagged with the bucket `memory_search`'s `corpus` filters on.  |
| `defaultIndexPath` | function | `<index root>/.index/memory.sqlite`.  |
| `DiaryEntry` | interface | Dream-diary append (ADR D7).  |
| `diaryPath` | function | `<memory root>/dream-diary.md`.  |
| `DiscoveredFile` | interface | One markdown file the corpus walk found, with the source bucket the indexer tags it with.  |
| `discoverSessionFiles` | function | Every session summary under `<memory root>/sessions`, as `{ absolutePath, relPath }` records.  |
| `discoverWikiFiles` | function | Every wiki supplement under `<memory root>/wiki`, as `{ absolutePath, relPath }` records.  |
| `entryHash` | function | A stable hash of one entry's counts, so two sweeps that did the same work read as the same work.  |
| `indexBudgetWarning` | function | What to say about an index that the interop partner will truncate, or `undefined` when there is nothing true to say.  |
| `lanceStoragePath` | function | `<memory root>/lance`.  |
| `MEMORY_INDEX_MAX_BYTES` | const | The byte limit the Claude Code CLI applies when it loads a `MEMORY.md`, whichever it reaches first.  |
| `MEMORY_INDEX_MAX_LINES` | const | The line limit the Claude Code CLI applies when it loads a `MEMORY.md`.  |
| `memoryIndexRoot` | function | Where the search index belongs for this configuration (theokit-sdk#554).  |
| `MemoryLocationConfig` | type | Only `directory` is read; the full config is accepted so callers pass what they already hold. |
| `memoryMdPath` | function | Path to `MEMORY.md`, the index that points at the per-memory files — and, in stores written before #389, the flat `## Facts` list itself.  |
| `memoryReadRoots` | function | Every directory a read must cover, deduplicated and in precedence order.  |
| `MemoryRoot` | type | A directory that has been RESOLVED as a memory root, distinguished from a bare `cwd`.  |
| `notesDir` | function | Path to `<memory root>/notes`, where per-topic notes and the consolidated notes a dreaming sweep writes live.  |
| `persistActiveMemoryTranscript` | function | Write one active-memory recall transcript under `<memory root>/transcripts/active-memory`.  |
| `projectMemoryDir` | function | The project store: `<cwd>/.theokit/memory`.  |
| `readAllSqliteFacts` | function | Read all facts from the SQLite memory index.  |
| `readFacts` | function | Every memory in the store, honouring the `enabled` gate on {@link MemoryConfig } : when memory is disabled the call resolves to `[]` without touching disk.  |
| `readFactsFromMarkdown` | function | Every memory in the store: the per-memory files, plus any legacy `## Facts` bullets still in `MEMORY.md`.  |
| `renderDiaryEntry` | function | One diary entry as the markdown that gets appended: a timestamp heading, the short entry hash, and the counts the sweep produced.  |
| `resolveMemoryRoot` | function | The memory root for this agent: `memory.directory` when set, the project store otherwise.  |
| `SessionFile` | interface | Session summary discovery (ADR D20).  |
| `sessionsDir` | function | `<memory root>/sessions`.  |
| `SessionSummaryInput` | interface | Per-run session summary writer (ADR D20).  |
| `sessionSummaryPath` | function | The file one run's summary occupies: `<memory root>/sessions/<safe-id>.md`.  |
| `SqliteFactRow` | interface | One row of the SQLite memory index, as the Lance migration reads it: the chunk plus the tenant columns the target table needs.  |
| `wikiDir` | function | `<memory root>/wiki`.  |
| `WikiFile` | interface | Wiki supplement discovery (ADR Phase 10 of memory-system-peer-project-parity).  |
| `writeSessionSummary` | function | Write a session summary file.  |

## `@theokit/sdk/internal/persistence`

| Symbol | Kind | Summary |
|---|---|---|
| `appendJsonl` | function | Append one record as a whole `\n`-terminated JSON line.  |
| `applyWalWithFallback` | function | Apply WAL mode with DELETE fallback.  |
| `atomicWriteJson` | function | Typed JSON atomic write helper.  |
| `AtomicWriteJsonOptions` | interface | Options for `atomicWriteJson`. |
| `atomicWriteText` | function | Atomic text write.  |
| `casUpdate` | function | Run an UPDATE and report whether it changed exactly the number of rows you expected — the optimistic-concurrency equivalent of taking a lock.  |
| `containsCjk` | function | Report whether `text` holds at least one Chinese, Japanese or Korean character.  |
| `createExclusive` | function | Create `path` holding `data`, but only if it does not exist yet.  |
| `CreateExclusiveOptions` | interface | O_EXCL exclusive file creation (ADR D82).  |
| `displayTheokitHome` | function | The same path `getTheokitHome(cwd)` returns, shortened for display: the home directory prefix collapses to `~`, so `/home/ada/.theokit` prints as `~/.theokit`.  |
| `FileLockOptions` | interface | Retry and staleness tuning for `withFileLock`.  |
| `getProfilesRoot` | function | The directory holding every profile: always `~/.theokit/profiles`, from `os.homedir()`.  |
| `getTheokitHome` | function | Resolve the directory cwd-anchored SDK state lives in.  |
| `isCorruptionError` | function | True when an open error indicates an unreadable / corrupt database file. |
| `JsonlParseError` | class | Raised when a JSONL line is not valid JSON or is not a JSON object.  |
| `loadJsonl` | function | Parse a JSONL file into rows.  |
| `migrateSchema` | function | Bring a SQLite database's `user_version` up to `currentVersion` by running the steps that sit between the two.  |
| `MigrateSchemaOptions` | interface | Arguments to `migrateSchema`.  |
| `MigrateSchemaResult` | interface | What `migrateSchema` did.  |
| `Migration` | interface | One forward migration step.  |
| `openSqliteResilient` | function | Open a SQLite file with WAL (+ DELETE fallback) and corruption recovery. |
| `OpenSqliteResilientOptions` | interface | Input to {@link openSqliteResilient } .  |
| `PersistenceSchema` | const | `persistence?` opt-in JSON disk backend with `dir` required when chosen.  |
| `readJsonlIds` | function | Read the set of keys from an existing JSONL file for which `keyFn(parsed)` returns a non-empty string.  |
| `readVersionedJson` | function | Read a versioned JSON file, migrating or falling back rather than failing.  |
| `ReadVersionedJsonOptions` | interface | Arguments to `readVersionedJson`.  |
| `replaceFileAtomic` | function | Atomic file replacement: write content to a per-call unique tmp path, fsync, then rename over the target.  |
| `ResilientSqliteDb` | interface | Minimal SQLite handle surface every driver (`better-sqlite3`) exposes. |
| `sanitizeFts5Query` | function | Six-step FTS5 query sanitizer.  |
| `SqliteLike` | interface | The three `better-sqlite3` methods this module actually uses, declared structurally so nothing here imports the driver.  |
| `VersionedJsonFile` | interface | The on-disk envelope: the payload under `data`, its schema version alongside it.  |
| `VersionedJsonMigrate` | type | Upgrade callback for `readVersionedJson`, invoked only when the stored version is BELOW the current one.  |
| `WalApplyResult` | interface | What journal mode a connection ended up in after `applyWalWithFallback`.  |
| `withCwdMutex` | function | Run `fn` after every earlier `withCwdMutex` call for the same `key` has settled, and return what `fn` returns.  |
| `withFileLock` | function | Run `fn` while holding an OS-level cross-process lock on `path`.  |
| `writeVersionedJson` | function | Write `data` wrapped in the version envelope, replacing the file atomically.  |

## `@theokit/sdk/internal/security`

| Symbol | Kind | Summary |
|---|---|---|
| `addPattern` | function | Register an extra pattern for `redactSecrets` to mask, on top of the built-in vendor set.  |
| `assertNoSymlinkEscape` | function | Assert that `path` — including every directory component in the chain — stays under `base` after symlink resolution.  |
| `ForbiddenPathError` | class | Thrown when an agent tool is asked to read or write a sensitive path that the blocklist forbids (`.env`, `.git/`, `node_modules/`, `.theo/`, lock files).  |
| `isForbiddenPath` | function | Decide whether a project-relative path points to a known-sensitive file that a coding agent must not read or write.  |
| `maskToken` | function | Mask one string, keeping enough of it to be recognizable in a log.  |
| `PathTraversalError` | class | Thrown when a path operation would escape its allowed base directory.  |
| `redactSecrets` | function | Redact known credential patterns from `text`.  |
| `safePathJoin` | function | Join `base` with `...parts` and ensure the resolved absolute path stays under `base`.  |
| `sanitizeIdentifier` | function | Validate that `input` is a safe path component (skill name, agent ID, namespace, etc.) and return its lowercase form.  |
| `validateArtifactPath` | function | T1.4 — validate a relative artifact path string BEFORE it is used to look up a fixture or to fetch from PaaS.  |

## `@theokit/sdk/mcp-auth`

| Symbol | Kind | Summary |
|---|---|---|
| `getTokens` | function | Retrieve tokens for `serverName`.  |
| `lockedRefresh` | function | Serialize concurrent refresh attempts per server (EC-9).  |
| `OAuthTokens` | interface | The OAuth tokens held for one MCP server.  |
| `refreshAccessToken` | function | Refresh an access token using `refresh_token`.  |
| `runPkceFlow` | function | Run the full PKCE flow.  |
| `setTokens` | function | Persist tokens for `serverName`.  |

## `@theokit/sdk/messages`

| Symbol | Kind | Summary |
|---|---|---|
| `assistantText` | function | Concatenate the text of an assistant message's `TextBlock`s.  |
| `costAmountUsd` | function | Read the cost amount from a `CostBreakdown`, preserving the honesty contract (repo ADR `D377-cost-status-closed-enum.md`): `amountUsd` is `number \| undefined` where `undefined` means "cost unknown"... |
| `extractToolUses` | function | Extract the `ToolUseBlock`s from an assistant message's content.  |

## `@theokit/sdk/models`

| Symbol | Kind | Summary |
|---|---|---|
| `CatalogModel` | type | One model entry as it is stored in the vendored catalog and as models.dev publishes it.  |
| `CatalogModelCost` | type | Per-token pricing for one model, in USD per 1M tokens (models.dev's unit — not per token, and not per 1K).  |
| `getModelInfo` | function | The enriched per-model view (public via `@theokit/sdk/models`): index lookup by (possibly prefixed) id. |
| `humanizeModelName` | function | Turn a model id into a best-effort human label: strip the routing/vendor prefix to the core model segment, split on `-`/`_`/`.`/whitespace, title-case each token (known acronyms upper-cased), and a... |
| `Modality` | type | One input or output medium a model accepts or produces.  |
| `ModelCapabilities` | interface | Per-model capability shape.  |
| `ModelOption` | interface | A UI-friendly model option — the shape a `<select>`/dropdown consumes.  |
| `ParsedModelId` | interface | Model identifier parsing (T1.2 follow-up, ADR D182 zero-config UX).  |
| `parseModelId` | function | Split a model string into `{ provider, name }` at the FIRST `/`.  |
| `refreshModelCatalog` | function | Explicitly refresh the model catalog from models.dev (the ONLY network trigger in the subsystem).  |
| `RefreshModelCatalogOptions` | interface | Arguments to `refreshModelCatalog`, the SDK's only network trigger for model metadata.  |
| `RefreshModelCatalogResult` | interface | What `refreshModelCatalog` did.  |
| `resolveModelCapabilities` | function | Resolve per-model capability flags (vision/structured-output/tool-use/cache + `maxContextTokens`/`maxOutputTokens`) for a model id.  |
| `toModelOption` | function | Build a {@link ModelOption } (`{ value, label, provider }`) for a model id — a dropdown-ready entry composing {@link humanizeModelName } + `parseModelId`.  |

## `@theokit/sdk/path-safety`

| Symbol | Kind | Summary |
|---|---|---|
| `assertNoSymlinkEscape` | function | Assert that `path` — including every directory component in the chain — stays under `base` after symlink resolution.  |
| `ForbiddenPathError` | class | Thrown when an agent tool is asked to read or write a sensitive path that the blocklist forbids (`.env`, `.git/`, `node_modules/`, `.theo/`, lock files).  |
| `isForbiddenPath` | function | Decide whether a project-relative path points to a known-sensitive file that a coding agent must not read or write.  |
| `PathTraversalError` | class | Thrown when a path operation would escape its allowed base directory.  |
| `safeFilenameForId` | function | Convert ANY opaque id (agent id, run id, conversation id, namespace, email, arbitrary string) into a deterministic, filesystem-safe filename component.  |
| `safePathJoin` | function | Join `base` with `...parts` and ensure the resolved absolute path stays under `base`.  |
| `sanitizeIdentifier` | function | Validate that `input` is a safe path component (skill name, agent ID, namespace, etc.) and return its lowercase form.  |

## `@theokit/sdk/persistence`

| Symbol | Kind | Summary |
|---|---|---|
| `acquireSessionWriter` | function | Take the exclusive writer lease for `sessionPath`, or reject with {@link SessionBusyError } .  |
| `appendJsonl` | function | Append one record as a whole `\n`-terminated JSON line.  |
| `applyWalWithFallback` | function | Apply WAL mode with DELETE fallback.  |
| `atomicWriteJson` | function | Typed JSON atomic write helper.  |
| `AtomicWriteJsonOptions` | interface | Options for `atomicWriteJson`. |
| `atomicWriteTempTarget` | function | U-9 — the file a leftover temp was replacing, or `undefined` if this is not one of ours.  |
| `atomicWriteText` | function | Atomic text write.  |
| `classifySessionArtifact` | function | U-1 — what is this entry, if it is one of ours?  |
| `encodeProjectDir` | function | Claude Code path convention: cwd with every non-alphanumeric replaced by `-`. |
| `FileLockOptions` | interface | Retry and staleness tuning for `withFileLock`.  |
| `forkTranscript` | function | Copy `src` into `dst`, keeping the first `beforeRecordIndex` records.  |
| `ForkTranscriptOptions` | interface | Options for {@link forkTranscript } . |
| `isCorruptionError` | function | True when an open error indicates an unreadable / corrupt database file. |
| `JsonlParseError` | class | Raised when a JSONL line is not valid JSON or is not a JSON object.  |
| `legacyTranscriptPath` | function | The path this session used BEFORE #400 made transcript filenames UUIDs.  |
| `listSessions` | function | Every session transcript under `<baseDir>/projects/<encoded-cwd>/`, with the id read from inside each file.  |
| `ListSessionsOptions` | interface | Options for {@link listSessions } . |
| `LiveSessionError` | class | M81 — the target is a protected session (live pointer / most-recent transcript / active entry).  |
| `LiveTranscriptError` | class | M81 — the target is a protected session (live pointer / most-recent transcript / active entry).  |
| `loadJsonl` | function | Parse a JSONL file into rows.  |
| `openSqliteResilient` | function | Open a SQLite file with WAL (+ DELETE fallback) and corruption recovery. |
| `OpenSqliteResilientOptions` | interface | Input to {@link openSqliteResilient } .  |
| `PersistenceSchema` | const | `persistence?` opt-in JSON disk backend with `dir` required when chosen.  |
| `readJsonlIds` | function | Read the set of keys from an existing JSONL file for which `keyFn(parsed)` returns a non-empty string.  |
| `readJsonlTail` | function | Read the LAST records of a JSONL file without loading the whole thing.  |
| `ReadJsonlTailOptions` | interface | Options for {@link readJsonlTail } . |
| `replaceFileAtomic` | function | Atomic file replacement: write content to a per-call unique tmp path, fsync, then rename over the target.  |
| `ResilientSqliteDb` | interface | Minimal SQLite handle surface every driver (`better-sqlite3`) exposes. |
| `sanitizeFts5Query` | function | Six-step FTS5 query sanitizer.  |
| `SessionArtifact` | type | The kinds of file this SDK leaves in a project's transcript directory.  |
| `SessionBusyError` | class | M81 — another process already holds the writer lease for this session.  |
| `sessionHasWriter` | function | Does the session have a writer **right now**?  |
| `SessionIdSource` | type | How the `id` on a {@link SessionListing } was obtained. |
| `SessionListing` | interface | One session found on disk. |
| `sessionUuidFor` | function | The transcript filename for an agent id — always a UUID.  |
| `SessionWriterLease` | interface | A held writer lease.  |
| `TranscriptBlock` | type | A content block inside {@link TranscriptMessage } . |
| `TranscriptMessage` | interface | The message body of a {@link SessionRecord } .  |
| `transcriptPath` | function | The `.jsonl` path for a session: `<baseDir>/projects/<encoded-cwd>/<session-uuid>.jsonl`. |
| `transcriptRoot` | function | Root of the transcript state.  |
| `WalApplyResult` | interface | What journal mode a connection ended up in after `applyWalWithFallback`.  |
| `withCwdMutex` | function | Run `fn` after every earlier `withCwdMutex` call for the same `key` has settled, and return what `fn` returns.  |
| `withFileLock` | function | Run `fn` while holding an OS-level cross-process lock on `path`.  |

## `@theokit/sdk/project`

| Symbol | Kind | Summary |
|---|---|---|
| `ProjectInstructionFile` | interface | One discovered project-instruction file. |
| `ProjectInstructions` | interface | Result of {@link readProjectInstructions } . |
| `ProjectInstructionScope` | type | How discovered instruction files are reduced to a single `content` string. |
| `readProjectInstructions` | function | Read hierarchical project instructions by walking up from `cwd`.  |
| `ReadProjectInstructionsOptions` | interface | Options for {@link readProjectInstructions } . |
| `writeProjectInstructions` | function | Write project instructions to `<cwd>/<filename>` atomically (temp + fsync + rename, via the shipped `replaceFileAtomic`).  |
| `WriteProjectInstructionsOptions` | interface | Options for {@link writeProjectInstructions } . |

## `@theokit/sdk/providers`

| Symbol | Kind | Summary |
|---|---|---|
| `getProviderProfile` | function | One provider by name or alias (`lm-studio` resolves to `lmstudio`), or `undefined` when nothing has registered it. |
| `listProviders` | function | Every registered provider — builtins, the JSON catalog, and anything a plugin registered. |

## `@theokit/sdk/retry`

| Symbol | Kind | Summary |
|---|---|---|
| `Retry` | class | SE36 — replaces `withRetry` (ADR 0015 / ADR-P2).  |
| `RetryOptions` | interface | Options for {@link withRetry } .  |

## `@theokit/sdk/sandbox`

| Symbol | Kind | Summary |
|---|---|---|
| `allowlistedEnv` | function | Build the environment a confined command runs with after `--clearenv`: `PATH`, `HOME`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TERM`, `USER`, `TMPDIR` and `SHELL`, copied from `source` (default `process.env... |
| `buildBwrapArgv` | function | Pure argv builder.  |
| `buildSeccompFilter` | function | Build the cBPF seccomp program as a `Buffer` (each `sock_filter` = 8 bytes).  |
| `BwrapArgvOptions` | interface | Everything {@link buildBwrapArgv } needs besides the {@link SandboxMode } .  |
| `BwrapDetection` | type | Result of {@link detectBwrap } / {@link detectBwrapMemoized } , discriminated on `ok`: `{ ok: true, bin }` carries the absolute path of the validated `bwrap`, `{ ok: false, reason }` a human-readab... |
| `BwrapProbes` | interface | Injectable probes — each mirrors one Codex availability check. |
| `createSandboxBackend` | function | Honest factory: bwrap available + mode wants confinement → `LinuxSandbox` (kernel enforcement, running the VALIDATED absolute bin); `danger-full-access` → plain `LocalSandbox` silently (explicit op... |
| `CreateSandboxBackendOptions` | interface | Options for `createSandboxBackend`, which probes for bubblewrap and returns a {@link LinuxSandbox } when confinement is genuinely available or a `LocalSandbox` when it is not — warning once when th... |
| `detectBwrap` | function | Honest detection — fail-closed on every probe; NEVER throws (callers WARN + fall back). |
| `detectBwrapMemoized` | function | `detectBwrap` with memoization — what production should call.  |
| `ExecuteResult` | interface | What a {@link SandboxBackend } returns for one command.  |
| `interactiveWrapCommand` | function | The composition the interactive path needs — the counterpart of `createSandboxBackend`.  |
| `InteractiveWrapOptions` | interface | Options for `interactiveWrapCommand`, the PTY counterpart of `createSandboxBackend`.  |
| `LinuxSandbox` | class | Kernel-confined backend for Linux hosts: a `LocalSandbox` whose commands are rewritten as `bwrap <policy flags> -- /bin/sh -c '<command>'` before they are spawned.  |
| `LocalSandbox` | class | Runs a command with `/bin/sh -c` on the host.  |
| `provisionRepo` | function | Clone `repoUrl` into `<sandbox workdir>/<instanceId>` and check out `ref`.  |
| `ProvisionRepoOptions` | interface | Options for {@link provisionRepo } . |
| `realProbeCount` | function | How many real probes ran.  |
| `realProbes` | const | Real probes used in production. |
| `RepoProvisionError` | class | Raised when cloning or checking out a repo fails.  |
| `resetBwrapMemo` | function | Clears the `detectBwrapMemoized` memo.  |
| `resetInteractiveWarnLatch` | function | Reset for tests — the latch is module state and tests need isolation.  |
| `resetSandboxWarnLatch` | function | Test seam: reset the WARN-once latch.  |
| `resolveSandbox` | function | Resolve a {@link SandboxProvider } to a concrete backend for `ctx`. |
| `resolveSandboxPosture` | function | MEDIUM-2: compute the posture so a surface (TUI footer) can show enforcement DURABLY instead of a one-shot warn.  |
| `restrictedSeccompPath` | function | M57 — exported so the interactive PTY backend reuses the SAME memoized x64-gated seccomp program. |
| `SandboxBackend` | class | The execution capability handed to an agent tool, and the extension point for new environments.  |
| `SandboxConfig` | interface | Construction-time settings shared by every {@link SandboxBackend } .  |
| `SandboxMode` | type | Codex's three canonical modes.  |
| `SandboxNotAvailableError` | class | A backend cannot be used at all: its runtime is missing or unusable.  |
| `SandboxPosture` | interface | Durable sandbox posture for the UI — the honest answer to "am I kernel-enforced right now?". |
| `SandboxProvider` | type | A backend OR a per-request resolver of one — mirrors `FilesystemProvider` / `InteractiveProvider`.  |
| `SandboxSecurityError` | class | A backend refused a command on policy grounds — the environment works, and it said no.  |
| `SeccompOptions` | interface | Input to {@link buildSeccompFilter } — the one axis the generated cBPF program varies on.  |
| `seccompPathForArch` | function | M63 — the restricted-network seccomp program is DETERMINISTIC, so write it ONCE per process and reuse the path across every LinuxSandbox (no per-instance temp accumulation).  |
| `wrapCommandForSandbox` | function | M57 — the single source of truth for the sandbox command wrap.  |
| `writableRootsFor` | function | U-6 — the roots a mode may write to, answerable WITHOUT spawning anything.  |

## `@theokit/sdk/sanitize`

| Symbol | Kind | Summary |
|---|---|---|
| `SanitizeOptions` | interface | Options for {@link sanitizeToolInput } .  |
| `SanitizeResult` | interface | Result of {@link sanitizeToolInput } .  |
| `sanitizeToolInput` | function | Sanitize the raw arguments a model emitted for a tool call — trim (default), optionally coerce string values toward their expected type, optionally repair malformed JSON.  |

## `@theokit/sdk/server/auth`

| Symbol | Kind | Summary |
|---|---|---|
| `Auth` | class | SE36 — `Auth.create` replaces `defineAuth` (ADR 0015). |
| `AuthCallbackError` | class | Thrown during OAuth callback handling for state mismatches, expired transactions, missing query params, or provider 4xx/5xx errors.  |
| `AuthCancelledError` | class | Per v1.1 EC-1 MUST FIX — typed subclass of AuthCallbackError for the specific case where user declined consent at provider screen.  |
| `AuthConfigError` | class | Thrown at `defineAuth()` time when configuration is invalid (e.g., duplicate provider name, invalid email shape per EC-V1-12). |
| `AuthOrchestrator` | interface | Returned by `defineAuth<TSession>(opts)` — 5-method orchestrator surface.  |
| `AuthProvider` | interface | Provider contract — each |
| `AuthProviderNotFoundError` | class | Thrown at `startSignIn(providerName, ...)` or `finishSignIn(providerName, ...)` when the named provider is not registered in `providers[]`. |
| `AuthResult` | interface | Per ADR D9 — provider profile types are provider-specific (not unified).  |
| `AuthSecretTooShortError` | class | T5.1 — Typed error thrown when an OAuth tx-cookie secret has < 32 bytes of entropy.  |
| `DefineAuthOptions` | interface | `defineAuth(opts)` configuration shape — Path C (Hybrid).  |
| `OAuthTransaction` | interface | Per ADR D5 — OAuth transaction state stored in encrypted HttpOnly cookie (cookie-state pattern).  |
| `SessionManager` | interface | SessionManager contract (matches theokit/packages/theo/src/server/auth/session.ts:49).  |
| `validateReturnTo` | function | Clamp a caller-supplied `returnTo` to a same-origin destination, falling back to `'/'` for anything else.  |

## `@theokit/sdk/server/errors-envelope`

| Symbol | Kind | Summary |
|---|---|---|
| `fromEnvelope` | function | Hydrate an envelope back into the SDK class hierarchy.  |
| `MemoryAdapterError` | class | Error raised by `@theokit-memory-*` adapters.  |
| `TheokitErrorCode` | type | Canonical envelope code union for cross-layer SDK boundary.  |
| `TheokitErrorEnvelope` | interface | Envelope shape — structurally identical to theokit/server `TheoErrorEnvelope`. |
| `toEnvelope` | function | Translate any SDK error (or arbitrary thrown value) into the canonical envelope shape at the wire boundary.  |

## `@theokit/sdk/skills`

| Symbol | Kind | Summary |
|---|---|---|
| `buildSkillsBlock` | function | Render the `<skills>` system-prompt block from a skill list.  |
| `discoverSkills` | function | Discover `SKILL.md` skills under an arbitrary directory.  |
| `DiscoverSkillsOptions` | interface | Options for {@link discoverSkills } . |
| `InvalidSkillInfo` | interface | Information passed to `onInvalidSkill` when a `SKILL.md` is present but its frontmatter is malformed (missing required field or invalid YAML). |
| `loadSkillInstructions` | function | Read the BODY of a discovered skill — everything after its frontmatter.  |
| `Skill` | interface | A discovered skill's metadata.  |

## `@theokit/sdk/subagents`

| Symbol | Kind | Summary |
|---|---|---|
| `subagentToolWhitelist` | function | Resolve a sub-agent's tool whitelist from its {@link AgentDefinition.tools } (M4-6).  |
| `withSubagentToolScope` | function | Run `fn` under the sub-agent's tool whitelist (M4-6).  |

## `@theokit/sdk/subagents-loader`

| Symbol | Kind | Summary |
|---|---|---|
| `AgentDefinition` | interface | Subagent definition.  |
| `CompatSourceDeclaration` | type | A declared foreign source: a bare kind, or a kind with the surfaces it may be read for. |
| `discoverSubagents` | function | Discover the subagents defined under `<cwd>/.theokit/agents/*.md`.  |
| `DiscoverSubagentsOptions` | interface | Options for {@link discoverSubagents } / {@link loadSubagentDefinition } . |
| `loadSubagentDefinition` | function | Load ONE subagent definition by name, or `undefined` when it is not defined on disk.  |
| `SubagentSource` | type | Where subagent definitions may be read from.  |

## `@theokit/sdk/subscription`

| Symbol | Kind | Summary |
|---|---|---|
| `DefineSubscriptionOptions` | interface | Options accepted by {@link defineSubscription } . |
| `isTrackedEnvelope` | function | Type guard for {@link TrackedEnvelope } . |
| `subscribe` | function | Subscribe to a typed subscription.  |
| `SubscribeOptions` | interface | Options accepted by `Theokit.subscribe(name, input, opts?)`. |
| `Subscription` | class | SE36 — `Subscription.create` replaces `defineSubscription` (ADR 0015). |
| `SubscriptionCtx` | interface | Context passed to a subscription `handler` on each invocation. |
| `SubscriptionDescriptor` | interface | Descriptor returned by {@link Subscription.create } .  |
| `SubscriptionDisconnectError` | class | Thrown when a subscription transport disconnects unexpectedly AND the client did not opt out of reconnect. |
| `SubscriptionError` | class | Base error for the subscription subsystem.  |
| `SubscriptionInputError` | class | Thrown when subscription input fails Zod schema validation. |
| `SubscriptionTransport` | type | Transport selection for subscriptions.  |
| `tracked` | function | Mint a tracked envelope.  |
| `TrackedEnvelope` | type | Tracked envelope: `[id, payload]` tuple yielded by subscription handlers to advertise the resume token associated with the payload.  |

## `@theokit/sdk/task-store`

| Symbol | Kind | Summary |
|---|---|---|
| `getTaskStoreFor` | function | Factory used by `TaskRegistry.configure` (D364). |
| `InMemoryTaskStore` | class | Default `TaskStore` — a plain `Map` living in the current process.  |
| `JsonFileTaskStore` | class | Opt-in `TaskStore` that keeps one JSON file per task under `dir`, so another process can read the registry off disk.  |
| `TaskStore` | interface | Storage interface used by `TaskRegistry`. |

## `@theokit/sdk/workflow`

| Symbol | Kind | Summary |
|---|---|---|
| `__resetSnapshotStoresForTests` | function | Test seam — clear in-memory store between tests. |
| `agentStep` | function | Build an `AgentStep`.  |
| `AgentStep` | interface | An agent.send-driven step. |
| `BranchStep` | interface | First-match-wins predicates + optional fallback. |
| `cloneWorkflow` | function | SE30 — clone a committed workflow under a new id/name.  |
| `DowhileStep` | interface | Loop a step until condFn returns false. |
| `fn` | function | Build a `FnStep`.  |
| `FnStep` | interface | A pure function step. |
| `ForeachStep` | interface | Map a step over an upstream array output. |
| `ParallelStep` | interface | N concurrent branches, each its own mini-step-list. |
| `RetryPolicy` | interface | D237 — retry policy applied per fn/agent step. |
| `SleepStep` | interface | Pause for a fixed duration. |
| `Step` | type | Any node of a committed workflow, discriminated by `kind`.  |
| `StepContext` | interface | D247 — context handed to every step.fn. |
| `StepResult` | interface | The outcome of one step, appended to `WorkflowRun.stepResults` in execution order.  |
| `SuspendStep` | interface | Standalone explicit suspend point. |
| `Workflow` | class | A committed, immutable workflow: a fixed list of steps you can `run`, `stream` or `resume`.  |
| `WorkflowAlreadyRunningError` | class | Thrown out of `Workflow.run()` — one of the few workflow failures that rejects instead of arriving as `run.status === "failed"` — when the committed workflow already has a run in flight under the s... |
| `workflowAsTool` | function | SE19 — expose a {@link Workflow } as an agent {@link CustomTool } , completing the "X as tools" trio (tools; agents-as-tools via `defineSubAgent`; workflows-as-tools).  |
| `WorkflowAsToolSpec` | interface | Spec for {@link workflowAsTool } .  |
| `WorkflowBuilder` | class | Fluent step accumulator returned by {@link Workflow.create } .  |
| `WorkflowCompensateNotImplementedError` | class | D238 — saga engine not yet implemented. |
| `WorkflowDescription` | interface | theokit#161 — the read-only shape of a committed workflow.  |
| `WorkflowDuplicateStepIdError` | class | Thrown by `.commit()` when one step id appears twice anywhere in the workflow — including inside a parallel branch, a branch predicate, the fallback, and the inner step of a `foreach` or `dowhile`.  |
| `WorkflowEvent` | type | SE28 — a step-level workflow event emitted by `Workflow.stream()` as top-level steps run.  |
| `WorkflowInputError` | class | SE27 — the whole-workflow `inputSchema` rejected `run(input)` (before step 1).  |
| `WorkflowMaxIterationsExceededError` | class | Raised when a `dowhile` step's condition kept returning true past `maxIterations` (default 100).  |
| `WorkflowNestedError` | class | SE30 — a nested workflow (via `workflowStep`) did not `complete`.  |
| `WorkflowNotSerializableError` | class | EC-4 absorbed — JSON.stringify failed on snapshot payload. |
| `WorkflowOptions` | interface | Configuration for `Workflow.create()`, validated by Zod before the builder is handed back: a `name` outside 1..128 characters, or `persistence.backend: "json"` without a `dir`, throws there rather ... |
| `WorkflowOutputError` | class | SE27 — the whole-workflow `outputSchema` rejected the final output (on `completed`).  |
| `WorkflowParallelError` | class | Aggregate failure from parallel branches.  |
| `WorkflowPersistenceOptions` | interface | Where suspend snapshots are kept.  |
| `WorkflowResumeOptions` | interface | Arguments for `Workflow.resume()`.  |
| `WorkflowResumeStepNotFoundError` | class | EC-8 absorbed — `currentStepId` from snapshot not found in resumed workflow. |
| `WorkflowRun` | interface | The terminal record of one run — what `Workflow.run()` resolves to, what `Workflow.resume()` returns, and what the `result` promise of `Workflow.stream()` settles with.  |
| `WorkflowRunOptions` | interface | Per-run options for `Workflow.run()` and `Workflow.stream()`.  |
| `WorkflowSnapshot` | interface | The persisted state of a suspended run: written when a step calls `StepContext.suspend()`, read back by `Workflow.resume()`.  |
| `WorkflowSnapshotNotFoundError` | class | Thrown by `Workflow.resume()` when no snapshot exists for the given run id.  |
| `WorkflowStateError` | class | SE29 — `WorkflowOptions.stateSchema` rejected an `initialState` or a `setState(next)` call.  |
| `workflowStep` | function | SE30 — use a committed {@link Workflow } as a step inside another workflow.  |
| `WorkflowStepDescription` | interface | theokit#161 — one step of a workflow, as a reflection surface sees it.  |
| `WorkflowStream` | type | SE28 — the async iterator returned by `Workflow.stream()`.  |
| `WorkflowToolError` | class | Raised by a {@link workflowAsTool } tool when the wrapped workflow run does not reach `status: "completed"` (a step failed, the run was cancelled/suspended).  |

