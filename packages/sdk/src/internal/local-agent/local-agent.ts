import {
  agentGenerate,
  type GenerateOptions,
  type GenerateRunResult,
} from "../../agent-generate.js";
import { ConfigurationError } from "../../errors.js";
import type {
  AgentDefinition,
  AgentOptions,
  ModelSelection,
  SDKAgent,
  SDKArtifact,
} from "../../types/agent.js";
import type { Run, SDKUserMessage, SendOptions } from "../../types/run.js";
import type { AgentOperation } from "../../types/sdk-agent.js";
import type { SessionStore } from "../../types/session-store.js";
import { generateLocalAgentId } from "../ids.js";
import { withCwdMutex } from "../persistence/cwd-mutex.js";
import { FsSessionStore } from "../persistence/fs-session-store.js";
import { resolveSessionDir } from "../persistence/session-dir.js";
import type { PersonalityRegistry } from "../personality/registry.js";
import { PersonalityStore } from "../personality/store.js";
import type { PersonalityPreset } from "../personality/types.js";
import { PluginManager } from "../plugins/manager.js";
import { extractCodePlugins } from "../plugins/plugin-guards.js";
import { resolveCompatSources } from "../runtime/compat/compat-config-file.js";
import { reportUndeclaredSources } from "../runtime/compat/foreign-config-sources.js";
import type { ProvidersManagerImpl } from "../runtime/config/providers-manager.js";
import type { FileContextManager } from "../runtime/context/context-manager.js";
import { HooksExecutor } from "../runtime/hooks/hooks-executor.js";
import { runPostRunLifecycle } from "../runtime/lifecycle/post-run-lifecycle.js";
import type { MemoryFact } from "../runtime/memory-glue/memory-store.js";
import { normalizeModel } from "../runtime/model-selection.js";
import type { PluginMetadata, PluginsManager } from "../runtime/plugin-loader/plugins-manager.js";
import { updateRegisteredAgent } from "../runtime/registry/agent-registry.js";
import type { SkillsHandle, SkillsManager } from "../runtime/skills/skills-manager.js";
import { loadSubagents } from "../runtime/skills/subagents-loader.js";
import {
  assembleSystemPromptForSend as assembleSystemPromptForSendHelper,
  buildSystemPromptContext as buildSystemPromptContextHelper,
  type LocalAssemblyInputs,
} from "../runtime/system-prompt/local-assembly.js";
import { SystemPromptPipeline } from "../runtime/system-prompt/pipeline.js";
import { resolveSystemPromptForSend } from "../runtime/system-prompt/system-prompt.js";
import { validateToolCatalog } from "../runtime/validation/validate-agent-options.js";
import { hydrateSession } from "../session/index.js";
import { SPAN_NAMES } from "../telemetry/span-names.js";
import { createTelemetry, type OTelSpan, type TelemetryHandle } from "../telemetry/tracer.js";
import { bootstrapSubmanagers, registerLocalAgent } from "./local-agent-bootstrap.js";
import { localAgentCapabilities } from "./local-agent-capabilities.js";
import { dispatchLocalRun } from "./local-agent-dispatch.js";
import { invalidateCacheImpl } from "./local-agent-invalidate.js";
import {
  acquireLeaseIfPossible,
  disposeLocalAgentSession,
  releaseLeaseIfPossible,
  reloadLocalAgent,
} from "./local-agent-lifecycle.js";
import { buildAgentMemory } from "./local-agent-memory-direct.js";
import { createLocalAgentMemoryProvider } from "./local-agent-memory-provider.js";
import {
  applyPersonalityOverlay,
  ensurePersonalityRegistryIfNeeded,
  localAgentUsePersonality,
  resolveActivePersonalityPreset,
} from "./local-agent-personality-extensions.js";
import {
  localAgentFork,
  localAgentRunToCompletion,
  localAgentRunUntil,
  localAgentStreamToCompletion,
} from "./local-agent-runtime-extensions.js";
import { type DispatchRunArgs, executeSendLocked } from "./local-agent-send.js";
import { registerRunAsTask } from "./local-agent-task-wrap.js";
import { reportUnknownLocalOptions } from "./local-option-keys.js";

/**
 * Local SDKAgent implementation. Owns the workspace cwd plus the file-based
 * loaders (context, hooks, MCP, subagents, plugins, skills). Routes runs
 * through the in-process fixture responder.
 *
 * @internal
 */
export class LocalAgent implements SDKAgent {
  /**
   * Operations this runtime does not perform. See {@link SDKAgent.supports} for why asking beats
   * catching: the members below are present on the type — `downloadArtifact` is REQUIRED — and
   * answering them by throwing is what leaves a caller unable to branch without a try/catch.
   *
   * Artifacts are a cloud concept: `downloadArtifact` rejects unconditionally here, and
   * `listArtifacts` returns `[]` for every state, so its empty array cannot be read as "this run
   * produced none".
   */
  supports(operation: AgentOperation): boolean {
    return localAgentCapabilities.supports(operation);
  }

  unsupportedReason(operation: AgentOperation): string | undefined {
    return localAgentCapabilities.unsupportedReason(operation);
  }
  readonly agentId: string;
  model: ModelSelection | undefined;
  context?: FileContextManager;
  providers?: ProvidersManagerImpl;
  skills?: SkillsHandle;
  plugins?: { list: () => Promise<PluginMetadata[]> };
  memory?: import("../../types/memory-adapter.js").AgentMemory;

  readonly options: AgentOptions;
  readonly workspaceCwd: string;
  /**
   * Directory for the native Claude-shaped session transcript. Default
   * `~/.theokit`; set `local.sessionDir: "~/.claude"` for Claude Code CLI interop.
   * (`local.baseDir` is the deprecated name for the same option — #301.)
   */
  private readonly transcriptBaseDir: string;
  /**
   * SE41 — the session record store. Defaults to the FS transcript store (byte-
   * identical to SE40); `local.sessionStore` injects an external store (Postgres /
   * Redis / KV) so resume works on serverless (ephemeral FS) and multi-host.
   */
  readonly sessionStore: SessionStore;
  /**
   * D319: lifecycle AbortController fired on `dispose()`. Composed with the
   * caller's `SendOptions.signal` via `anySignal` so the LLM `fetch()`
   * aborts on either signal (user cancel OR dispose).
   */
  readonly lifecycleAbortController = new AbortController();
  readonly settingSourcesIncludeProject: boolean;
  private readonly settingSourcesIncludePlugins: boolean;
  private resolvedSubagents: Record<string, AgentDefinition> = {};
  private disposed = false;
  private invalidationPending: { reason: string; at: number } | undefined;
  readonly skillsManager: SkillsManager | undefined;
  readonly pluginsManager: PluginsManager | undefined;
  private readonly hooksExecutor: HooksExecutor;
  private readonly systemPromptPipeline: SystemPromptPipeline = SystemPromptPipeline.default();
  /**
   * The agent's memory, behind the `MemoryProvider` port — the only memory path since the kernel
   * flip (2026-09-02). A consumer-supplied `options.memoryProvider` takes precedence; this is what
   * runs otherwise.
   *
   * It used to be built ALONGSIDE a `LocalAgentMemory` this class held directly, "so future iters
   * can flip", while `send()` used the direct one. The adapter constructs its own `LocalAgentMemory`
   * inside `init()`, so that arrangement kept two of them per agent and the second was never read.
   *
   * Accessible to tests via `_defaultMemoryProviderForLoop()` helper.
   * @internal
   */
  private readonly defaultMemoryProviderForLoop: ReturnType<typeof createLocalAgentMemoryProvider>;
  /** T4.1 — PluginManager for code plugins (kind: general/model-provider/memory). @internal */
  private readonly pluginManagerCode: PluginManager = new PluginManager();
  /** Personality presets — lazy-loaded on first `usePersonality` call (ADRs D160-D164). @internal */
  // Not private: `local-agent-personality-extensions.ts` reads both through
  // `LocalAgentPersonalityTarget`, the same way `local-agent-lifecycle.ts` reads `sessionStore` and
  // `lifecycleAbortController` above. A field a sibling module needs is part of this class's
  // implementation surface, and saying so beats handing it over as a closure.
  personalityRegistry: PersonalityRegistry | undefined;
  readonly personalityStore: PersonalityStore;
  /** T0.1 — telemetry handle shared with sendLocked + memory recall path. */
  private readonly _telemetry: TelemetryHandle;

  constructor(options: AgentOptions) {
    this.agentId = options.agentId ?? generateLocalAgentId();
    this._telemetry = createTelemetry(options.telemetry);
    this.model = normalizeModel(options.model);
    this.options = options;
    this.workspaceCwd = resolveCwd(options.local?.cwd);
    this.transcriptBaseDir = resolveSessionDir(options.local);
    // SE41 — external store if injected, else the FS default (byte-identical to SE40).
    this.sessionStore =
      options.local?.sessionStore ??
      new FsSessionStore({ baseDir: this.transcriptBaseDir, cwd: this.workspaceCwd });
    this.settingSourcesIncludeProject = includesSetting(options, "project");
    this.settingSourcesIncludePlugins = includesSetting(options, "plugins");

    const sub = bootstrapSubmanagers({
      options,
      workspaceCwd: this.workspaceCwd,
      settingSourcesIncludeProject: this.settingSourcesIncludeProject,
      settingSourcesIncludePlugins: this.settingSourcesIncludePlugins,
    });
    if (sub.context !== undefined) this.context = sub.context;
    if (sub.providers !== undefined) this.providers = sub.providers;
    this.skillsManager = sub.skillsManager;
    if (sub.skills !== undefined) this.skills = sub.skills;
    this.pluginsManager = sub.pluginsManager;
    if (sub.plugins !== undefined) this.plugins = sub.plugins;

    // #526 — an unrecognised key here used to be accepted in silence, so a typo and an SDK too old
    // to know the option produced the identical result: the default, and no complaint.
    reportUnknownLocalOptions(options.local as Record<string, unknown> | undefined);
    const compatSources = resolveCompatSources(options, this.workspaceCwd);
    // #524 — the flip is silent from inside the repository: the hook file is there, executable, and
    // not running. Reported here, once per workspace, on the interceptable channel.
    reportUndeclaredSources(this.workspaceCwd, compatSources);
    this.hooksExecutor = new HooksExecutor(this.workspaceCwd, compatSources, options.local?.hooks);
    this.defaultMemoryProviderForLoop = createLocalAgentMemoryProvider({
      agentOptions: options,
      workspaceCwd: this.workspaceCwd,
      agentId: this.agentId,
      ...(this._telemetry !== undefined ? { telemetry: this._telemetry } : {}),
    });
    this.personalityStore = new PersonalityStore(this.workspaceCwd);
    // ADR D141 / D142: `agent.memory.*` direct API over plugin-aggregated adapters.
    // Built unconditionally; `requireAdapters` throws ConfigurationError when called
    // without any registered memory plugin.
    this.memory = buildAgentMemory(
      this.pluginManagerCode,
      this.workspaceCwd,
      this.options.memoryContext,
    );

    registerLocalAgent({
      agentId: this.agentId,
      model: this.model,
      options,
      workspaceCwd: this.workspaceCwd,
    });
  }

  async initialize(): Promise<void> {
    await this.hooksExecutor.initialize(this.settingSourcesIncludeProject);
    if (this.context !== undefined) await this.context.initialize();
    if (this.skillsManager !== undefined) await this.skillsManager.initialize();
    if (this.pluginsManager !== undefined) await this.pluginsManager.initialize();
    // T4.1 (ADRs D97-D101 + EC-1): wire code plugins. extractCodePlugins
    // discriminates new Plugin[] from legacy `{ enabled }` metadata; the
    // latter returns empty so v1.2 callers continue to work.
    const codePlugins = extractCodePlugins(this.options.plugins);
    await this.pluginManagerCode.initialize(codePlugins);
    this.resolvedSubagents = await loadSubagents(
      this.workspaceCwd,
      this.settingSourcesIncludeProject,
      this.options.agents,
      resolveCompatSources(this.options, this.workspaceCwd),
    );
    // SE40 — hydrate persisted session history from the native transcript so a
    // resumed agent sees the conversation from the previous process.
    // M95 — the writer lease is taken at INIT, before any turn.
    //
    // Here, and not in `appendRecords`: the `SessionStore` contract makes an append rejection
    // best-effort (logged to stderr, not thrown), so acquiring there made the `SessionBusyError`
    // get swallowed and the user's turn vanish silently. At init the error reaches whoever can
    // decide — `exec` forks to a new id, which is what the error message prescribes.
    await acquireLeaseIfPossible(this.sessionStore, this.agentId);
    // Everything after the acquisition runs under `try`: an init failing AFTER taking the lease would leave
    // the lock held by this very process — alive, same host — and `reclaimable` would be `false` forever.
    // The session would stay locked for the process's lifetime, with no crash and no recovery: the
    // same class this milestone exists to remove, coming in through another door.
    //
    // Measured with an unreadable transcript (EACCES), which `readRecords` must throw on by contract.
    try {
      await hydrateSession(this.agentId, { store: this.sessionStore, cwd: this.workspaceCwd });
      // ADR D163 — hydrate previously-active personality slug (no-op if none).
      await this.personalityStore.hydrate(this.agentId);
    } catch (err) {
      // Releases THIS agent's lease, not all of the store's: an injected store may serve several
      // agents, and an init that fails for B must not free A's lease, which is still writing.
      await releaseLeaseIfPossible(this.sessionStore, this.agentId);
      throw err;
    }
  }

  /** T4.2 — expose PluginManager so agent-loop can fire pre_tool_call hooks. @internal */
  pluginManager(): PluginManager {
    return this.pluginManagerCode;
  }

  /** Expose the hooks executor so the agent loop can fire PreToolUse/etc. */
  hooks(): HooksExecutor {
    return this.hooksExecutor;
  }

  // SE9 — integrated structured output; delegates to the shared helper.
  generate<T extends import("zod").ZodType>(
    message: string | SDKUserMessage,
    options: GenerateOptions<T>,
  ): Promise<GenerateRunResult<import("zod").z.infer<T>>> {
    const { apiKey, local } = this.options;
    return agentGenerate(this, this.model, apiKey, local, message, options);
  }

  async send(message: string | SDKUserMessage, options: SendOptions = {}): Promise<Run> {
    // Per-call tools: run the same name/schema/dedupe checks as creation.
    // (Cloud agents reject per-call tools in CloudAgent.send.)
    if (options.tools !== undefined && options.tools.length > 0) {
      // usetheokit/theokit-sdk#381 — with the agent's withhold list, so a per-send tool may claim a
      // builtin name the agent withheld. Omitting it here would make the same catalog legal at
      // create-time and rejected at send-time.
      validateToolCatalog(options.tools, this.options.withheldBuiltinTools);
    }
    // T0.1: `agent.send` parent span spans the FULL lifecycle (mutex acquire +
    // dispatch + post-run). Child step spans (`agent.send.<step>`) land in T1.7.
    const sendSpan = this._telemetry.startSpan(SPAN_NAMES.AGENT_SEND, {
      agentId: this.agentId,
      ...(this.model?.id !== undefined ? { model: this.model.id } : {}),
    });
    // ADR D19 (EC-8): per-agent send mutex keyed by `agent-send:${agentId}`.
    // The lock spans the FULL run lifecycle — dispatch + run.wait() + post-run
    // assistant-turn append + session summary write + disk flush — so
    // concurrent sends to the SAME agentId cannot interleave user/assistant
    // records mid-turn AND `agent.dispose()` can never return before the
    // summary write finishes (ADR D20).
    return new Promise<Run>((resolve, reject) => {
      void withCwdMutex(`agent-send:${this.agentId}`, () =>
        this.runLockedSendCycle(message, options, sendSpan, resolve, reject),
      );
    });
  }

  /**
   * The context window declared on the model selection, in conditional-spread form.
   *
   * M94 — without this, `resolveEffectiveContextWindow`'s `override` had existed since M77 and no
   * production call site passed it: a 400k model with no catalog entry was budgeted against the
   * 128k floor. Its own method because the inline spread pushed `runLockedSendCycle` past the
   * project's cognitive-complexity ceiling.
   */
  #declaredWindow(): { contextWindow?: number } {
    const declared = this.model?.contextWindow;
    return declared !== undefined ? { contextWindow: declared } : {};
  }

  private async runLockedSendCycle(
    message: string | SDKUserMessage,
    options: SendOptions,
    sendSpan: OTelSpan,
    resolve: (run: Run) => void,
    reject: (err: unknown) => void,
  ): Promise<void> {
    const userText = typeof message === "string" ? message : message.text;
    let run: Run;
    try {
      run = await this.sendLocked(message, options);
    } catch (err) {
      sendSpan.recordException(err);
      sendSpan.setStatus({ code: 2, message: err instanceof Error ? err.message : String(err) });
      sendSpan.end();
      reject(err);
      return;
    }
    // T3.2: opt-in Task wrapping (ADRs D363/D374).
    if (options.task !== undefined) registerRunAsTask(run, this.agentId, options.task, userText);
    resolve(run);
    try {
      await runPostRunLifecycle({
        run,
        userText,
        agentId: this.agentId,
        workspaceCwd: this.workspaceCwd,
        sessionStore: this.sessionStore,
        model: this.model?.id ?? "unknown",
        ...this.#declaredWindow(),
        // M50 — the auto-compaction summarizer resolves credentials like the run itself.
        ...(this.options.apiKey !== undefined ? { apiKey: this.options.apiKey } : {}),
        ...(options.onRunEvent !== undefined ? { onRunEvent: options.onRunEvent } : {}),
        hooksExecutor: this.hooksExecutor,
        // usetheokit/theokit-sdk#382 — the transcript write reads this and nothing else.
        memory: this.options.memory,
        // A consumer-supplied provider wins; otherwise the auto-installed adapter over
        // `LocalAgentMemory`. Since the kernel flip there is no third case, so this is passed
        // unconditionally — the `!== undefined` spread that used to guard it could not be false,
        // and `recordSessionSummary` is now always reached through the port.
        memoryProvider: this.options.memoryProvider ?? this.defaultMemoryProviderForLoop,
      });
    } finally {
      sendSpan.end();
    }
  }

  private async sendLocked(message: string | SDKUserMessage, options: SendOptions): Promise<Run> {
    return executeSendLocked(
      {
        agentId: this.agentId,
        disposed: this.disposed,
        invalidationPending: this.invalidationPending,
        clearInvalidation: () => {
          this.invalidationPending = undefined;
        },
        reload: () => this.reload(),
        applyModelOverride: (m) => this.applyModelOverride(m),
        options: this.options,
        pluginManagerCode: this.pluginManagerCode,
        defaultMemoryProviderForLoop: this.defaultMemoryProviderForLoop,
        workspaceCwd: this.workspaceCwd,
        telemetry: this._telemetry,
        lifecycleAbortController: this.lifecycleAbortController,
        runPreHook: (ut) => this.runPreHook(ut),
        resolveSystemPromptForSend: (ut, o, mf) => this.resolveSystemPrompt(ut, o, mf),
        assembleSystemPromptForSend: (request) =>
          assembleSystemPromptForSendHelper({ ...request, inputs: this.assemblyInputs() }),
        dispatchRun: (args) => this.dispatchRun(args),
      },
      message,
      options,
    );
  }

  private assemblyInputs(): LocalAssemblyInputs {
    return {
      agentId: this.agentId,
      workspaceCwd: this.workspaceCwd,
      model: this.model,
      options: this.options,
      context: this.context,
      skillsManager: this.skillsManager,
      settingSourcesIncludeProject: this.settingSourcesIncludeProject,
      systemPromptPipeline: this.systemPromptPipeline,
    };
  }

  private async resolveSystemPrompt(
    userText: string,
    options: SendOptions,
    memoryFacts: ReadonlyArray<MemoryFact>,
  ): Promise<string | undefined> {
    const base = await resolveSystemPromptForSend(
      this.options.systemPrompt,
      options.systemPrompt,
      () => buildSystemPromptContextHelper(this.assemblyInputs(), userText, memoryFacts),
    );
    this.personalityRegistry = await ensurePersonalityRegistryIfNeeded({
      agentId: this.agentId,
      workspaceCwd: this.workspaceCwd,
      personalityStore: this.personalityStore,
      personalityRegistry: this.personalityRegistry,
    });
    return applyPersonalityOverlay(this.activePreset(), base);
  }

  /** @internal — read-only personality lookup (composes the helper, honors fork ALS). */
  private activePreset(): PersonalityPreset | undefined {
    return resolveActivePersonalityPreset({
      agentId: this.agentId,
      personalityStore: this.personalityStore,
      personalityRegistry: this.personalityRegistry,
    });
  }

  private applyModelOverride(overrideModel: ModelSelection | undefined): void {
    if (overrideModel === undefined) return;
    this.model = overrideModel;
    updateRegisteredAgent(this.agentId, { model: overrideModel });
  }

  private async runPreHook(userText: string): Promise<void> {
    const preRun = await this.hooksExecutor.run({
      event: "preRun",
      input: { message: userText },
      agentId: this.agentId,
    });
    if (preRun.blocked) {
      throw new ConfigurationError(
        `preRun hook denied execution: ${preRun.reason ?? "unspecified"}`,
        { code: "hook_denied" },
      );
    }
  }

  private dispatchRun({
    message,
    options,
    systemPrompt,
    memoryFacts,
    priorMessages,
    memoryTools,
    memoryProviderOverride,
  }: DispatchRunArgs): Promise<Run> {
    // SDK 2.0 Phase 1 physical Stage 2b — iter 23 KERNEL FLIP:
    // When `memoryProviderOverride` is supplied (env-flag path), inject
    // it via a shallow-cloned `agentOptions` so agent-loop's iter 18
    // T1.3 wiring threads it into `inputs.memoryProvider` automatically.
    // When undefined: pass `this.options` verbatim (zero behavior change
    // — the existing consumer-supplied `options.memoryProvider` path
    // wins unchanged).
    const effectiveAgentOptions =
      memoryProviderOverride !== undefined && this.options.memoryProvider === undefined
        ? { ...this.options, memoryProvider: memoryProviderOverride }
        : this.options;
    return dispatchLocalRun({
      inputs: {
        agentId: this.agentId,
        model: this.model,
        options: effectiveAgentOptions,
        workspaceCwd: this.workspaceCwd,
        hooksExecutor: this.hooksExecutor,
        pluginManager: this.pluginManagerCode,
        resolvedSubagents: this.resolvedSubagents,
        settingSourcesIncludeProject: this.settingSourcesIncludeProject,
      },
      message,
      sendOptions: options,
      systemPrompt,
      memoryFacts,
      priorMessages,
      memoryTools,
      activePreset: this.activePreset(),
    });
  }

  close(): void {
    this.disposed = true;
  }

  async reload(): Promise<void> {
    this.resolvedSubagents = await reloadLocalAgent(this);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await disposeLocalAgentSession(this);
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.dispose();
  }

  /** T3.2 / ADR D94 — public `invalidateCache` API. @internal */
  invalidateCache = (reason: string, opts: { applyNow?: boolean } = {}): Promise<void> =>
    invalidateCacheImpl(
      this.agentId,
      reason,
      opts,
      this.disposed,
      () => this.dispose(),
      (p) => {
        this.invalidationPending = p;
      },
    );

  /**
   * Activate a personality preset (Hermes #26, ADRs D160-D164).
   *
   * Reserved names `none`, `default`, `neutral` clear the active preset.
   *
   * - `opts.save: true` → persist across process restarts (delete on clear,
   *   never write null — EC-B).
   * - `opts.reset: true` → also clear session history (preserves by default).
   *
   * Always invalidates the prompt cache (D94 deferred default).
   *
   * @public
   */
  usePersonality(
    name: string,
    opts?: { save?: boolean; reset?: boolean },
  ): Promise<PersonalityPreset | null> {
    if (this.disposed) throw new Error("Agent has been disposed");
    return localAgentUsePersonality(this, name, opts);
  }

  // The two operations `local-agent-capabilities.ts` is ABOUT: their runtime answers live beside the
  // static answer `supports()` gives, so a change to one cannot drift from the other.
  listArtifacts(): Promise<SDKArtifact[]> {
    return localAgentCapabilities.listArtifacts();
  }

  downloadArtifact(_path: string): Promise<Buffer> {
    return localAgentCapabilities.downloadArtifact();
  }

  runUntil(
    goal?: string,
    options?: import("../../types/goal-events.js").GoalOptions,
  ): import("../../types/goal-events.js").RunUntilIterator {
    return localAgentRunUntil(this, goal, options);
  }
  fork(
    options: import("../runtime/lifecycle/fork-agent.js").ForkOptions,
  ): Promise<import("../runtime/lifecycle/fork-agent.js").ForkResult> {
    return localAgentFork(
      {
        agentId: this.agentId,
        options: this.options,
        personalitySlugSnapshot: this.personalityStore.active(this.agentId),
      },
      options,
    );
  }
  runToCompletion(
    message: string,
    options?: import("../../types/run.js").RunToCompletionOptions,
  ): Promise<import("../../types/run.js").RunToCompletionResult> {
    return localAgentRunToCompletion(this, message, options);
  }
  streamToCompletion(
    message: string,
    options?: import("../../types/run.js").RunToCompletionOptions,
  ): AsyncGenerator<
    import("../../types/messages.js").SDKMessage,
    import("../../types/run.js").StreamToCompletionResult
  > {
    return localAgentStreamToCompletion(this, message, options);
  }
}

function resolveCwd(cwd: string | string[] | undefined): string {
  return (Array.isArray(cwd) ? cwd[0] : cwd) ?? process.cwd();
}

function includesSetting(options: AgentOptions, source: string): boolean {
  const sources = options.local?.settingSources;
  return (
    sources !== undefined && (sources.includes(source as never) || sources.includes("all" as never))
  );
}
