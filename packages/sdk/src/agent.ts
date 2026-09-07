import { AgentBuilder } from "./agent-builder.js";
import {
  AgentRunError,
  ConfigurationError,
  coerceToKnownAgentRunErrorCode,
  UnknownAgentError,
} from "./errors.js";
import {
  getRegisteredAgentOrThrow,
  paginateByKey,
  rehydrateExistingAgent,
  resolveAgentPersistenceCwd,
  runCreateUnderSpan,
  setAgentName,
  setArchivedFlag,
  toAgentInfo,
} from "./internal/agent/helpers.js";
import { enabledPluginNames } from "./internal/plugins/enabled-names.js";
import { discoverProviderPlugins } from "./internal/providers/discovery.js";
import { setAgentFacade } from "./internal/runtime/registry/agent-factory-registry.js";
import {
  flushRegistrySaves,
  getRegisteredAgent,
  hydrateRegistryFromDisk,
  listRegisteredAgents,
  removeRegisteredAgent,
} from "./internal/runtime/registry/agent-registry.js";
import {
  type LiveAgentRegistry,
  liveAgentRegistry,
} from "./internal/runtime/registry/live-agent-registry.js";
import {
  getRun as getRegisteredRun,
  listRunsByAgent,
} from "./internal/runtime/registry/run-registry.js";
import { enqueueSessionWrite } from "./internal/session/agent-session.js";
import { SPAN_NAMES } from "./internal/telemetry/span-names.js";
import { createTelemetry, type OTelSpan } from "./internal/telemetry/tracer.js";
import type {
  AgentDescription,
  AgentOperationOptions,
  AgentOptions,
  GetAgentOptions,
  GetRunOptions,
  ListAgentsOptions,
  ListResult,
  ListRunsOptions,
  SDKAgent,
  SDKAgentInfo,
} from "./types/agent.js";
import type { Run, RunResult } from "./types/run.js";
import type { SessionMessage } from "./types/session-message.js";

// T1.8 — memoized dynamic import for streamObject so the second+ call
// skips the promise resolution chain entirely. Module-level so it
// survives across Agent.streamObject invocations.
let streamObjectImport: Promise<typeof import("./stream-object.js")> | undefined;

/**
 * Result of a one-shot {@link Agent.prompt} call.
 *
 * @public
 */
export type AgentPromptResult = RunResult;

/**
 * Static façade for creating and managing Theo agents.
 *
 * @public
 */
export class Agent {
  private constructor() {
    // Static-only façade.
  }

  /**
   * Live-agent cache for production deploys (Production-Readiness #2, ADRs D307-D310).
   *
   * Caches `SDKAgent` instances by id with LRU eviction (when `size > maxAgents`)
   * and an idle-timeout sweep. Solves the OOM failure mode for long-running
   * Node servers spawning fresh agents per conversation.
   *
   * Defaults: `maxAgents: 100`, `idleTimeoutMs: 30 min`, sweep `60s`.
   * Configure for high-traffic SaaS:
   *
   * ```ts
   * Agent.registry.configure({ maxAgents: 1000, idleTimeoutMs: 15 * 60_000 });
   * process.on("SIGTERM", () => Agent.registry.evictAll());
   * ```
   *
   * Cache hits are automatic in `Agent.getOrCreate` (T2.6). Disable the cache
   * entirely via `configure({ maxAgents: 0 })` — every getOrCreate then
   * re-initializes.
   *
   * @public
   */
  static readonly registry: LiveAgentRegistry = liveAgentRegistry;

  /**
   * Create a new agent. Pass either `local` or `cloud` to pick a runtime.
   *
   * @public
   */
  static async create(options: AgentOptions): Promise<SDKAgent> {
    // T0.1: emit `agent.create` span around the FULL factory body so validation
    // throws and quota-gate rejections are recorded with ERROR status before
    // propagating to the caller.
    const telemetry = createTelemetry(options.telemetry);
    const runtime: "local" | "cloud" = options.cloud !== undefined ? "cloud" : "local";
    const span: OTelSpan = telemetry.startSpan(SPAN_NAMES.AGENT_CREATE, {
      runtime,
      pluginCount: enabledPluginNames(options.plugins).length,
    });
    try {
      // M47 wiring — provider-plugin discovery runs upfront (the `resolveProviderChain`
      // contract). Idempotent per process; fail-tolerant by design (never throws).
      await discoverProviderPlugins();
      const agent = await runCreateUnderSpan(options, span);
      return agent;
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: 2, message: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      span.end();
    }
  }

  /**
   * One-shot prompt: create an agent, send a single message, wait, **dispose**.
   *
   * `Agent.prompt` is STATIC and owns the agent's whole lifecycle. To send to an
   * agent you already hold, use the instance method — `agent.send(message)` —
   * which keeps the conversation and does not dispose anything:
   *
   * ```ts
   * const agent = await Agent.create({ ... });
   * const run = await agent.send("first");     // NOT agent.prompt(...)
   * const run2 = await agent.send("follow-up"); // full context retained
   * ```
   *
   * There is no `agent.prompt()` (#302). The natural sentence for the second
   * operation is "prompt the agent", so it is the method people reach for; the
   * two differ in whether the agent survives the call, which is why they do not
   * share a name.
   *
   * When `options.throwOnError === true`, rejects with `AgentRunError` if
   * the run terminates with `status: 'error'` (instead of resolving with the
   * error wrapped in the RunResult). Cancelled runs still resolve normally.
   *
   * @public
   */
  static async prompt(message: string, options: AgentOptions): Promise<AgentPromptResult> {
    const agent = await Agent.create(options);
    try {
      const run = await agent.send(message);
      const result = await run.wait();
      if (
        options.throwOnError === true &&
        result.status === "error" &&
        result.error !== undefined
      ) {
        throw new AgentRunError(result.error.message, {
          code: coerceToKnownAgentRunErrorCode(result.error.code),
          cause: result.error.cause,
        });
      }
      return result;
    } finally {
      // T1.9 — dispose error MUST NOT mask the original error from
      // the try block. A failing dispose is cleanup, not business
      // logic — swallow silently so the consumer always sees the
      // real error (or the real result) from agent.send().
      try {
        await agent.dispose();
      } catch {
        // Swallowed — dispose cleanup must not propagate.
      }
    }
  }

  /**
   * Reattach to an existing agent by ID.
   *
   * @public
   */
  static async resume(agentId: string, options: Partial<AgentOptions> = {}): Promise<SDKAgent> {
    let existing = getRegisteredAgent(agentId);
    if (existing === undefined) {
      // D21: fall back to the persisted registry. Different cwds get isolated
      // registry.json files; we read the cwd the caller is operating in.
      const persistenceCwd = resolveAgentPersistenceCwd(options);
      await hydrateRegistryFromDisk(persistenceCwd);
      existing = getRegisteredAgent(agentId);
    }
    if (existing !== undefined) {
      return await rehydrateExistingAgent(agentId, existing, options);
    }
    // Cold miss: throw UnknownAgentError so chat-assistant bots can
    // explicitly branch to `Agent.create({ agentId, ...full options })` on
    // first contact. The previous silent cold-create with the caller's
    // partial options was a footgun — it persisted incomplete agents
    // (no model, no system prompt) that then failed at first send.
    //
    // Migration: callers that want the OLD "always succeed" behaviour
    // should catch `UnknownAgentError` and call `Agent.create` themselves.
    throw new UnknownAgentError(
      `Agent "${agentId}" not found. Use Agent.create({ agentId, ... }) for first-time setup, or catch UnknownAgentError to branch resume-vs-create.`,
      { code: "unknown_agent" },
    );
  }

  /**
   * Start building an {@link AgentOptions} via fluent chain. See ADR D25.
   * Terminals: `.build()`, `.create()`, `.getOrCreate(id)`.
   *
   * The builder receives `create` + `getOrCreate` as injected callbacks so
   * that `agent-builder.ts` doesn't need a static import of `Agent` — keeps
   * the module graph acyclic (G6).
   *
   * @public
   */
  static builder(): AgentBuilder {
    return new AgentBuilder({
      create: (options) => Agent.create(options),
      getOrCreate: (agentId, options) => Agent.getOrCreate(agentId, options),
    });
  }

  /**
   * Generate a typed object matching a Zod schema via a synthetic forced
   * tool call (ADR D33). One-shot: create transient agent → send prompt →
   * model calls `output` tool → parse args via Zod → return typed.
   *
   * @public
   */
  static async generateObject<T extends import("zod").ZodType>(
    options: import("./generate-object.js").GenerateObjectOptions<T>,
  ): Promise<import("./generate-object.js").GenerateObjectResult<import("zod").z.infer<T>>> {
    const { generateObjectImpl } = await import("./generate-object.js");
    return generateObjectImpl(options, {
      create: (opts) => Agent.create(opts),
      delete: (agentId) => Agent.delete(agentId),
    });
  }

  /**
   * Stream a structured output object alongside intermediate `partial`
   * deltas as the model accumulates its response (ADR D39). Returns an
   * `AsyncIterator<StreamObjectEvent<T>>` that yields zero or more
   * `partial` events and exactly one `complete` event at the end.
   *
   * The `complete` event carries the same `object: z.infer<T>` you would get
   * from `Agent.generateObject` — same prompt + schema + model produces
   * the same final object.
   *
   * @public
   */
  static streamObject<T extends import("zod").ZodType>(
    options: import("./stream-object.js").StreamObjectOptions<T>,
  ): AsyncGenerator<
    import("./stream-object.js").StreamObjectEvent<import("zod").z.infer<T>>,
    void,
    void
  > {
    // T1.8 — Lazy-import the implementation; memoized so the second+
    // call skips the promise chain entirely. Consumers that never call
    // streamObject don't pay the import cost at all.
    const deps = {
      create: (opts: import("./types/agent.js").AgentOptions) => Agent.create(opts),
      delete: (agentId: string) => Agent.delete(agentId),
    };
    async function* wrapper() {
      // T1.8 — memoized dynamic import: first call resolves the module;
      // subsequent calls reuse the cached promise (no re-await overhead).
      streamObjectImport ??= import("./stream-object.js");
      const { streamObjectImpl } = await streamObjectImport;
      yield* streamObjectImpl(options, deps);
    }
    return wrapper();
  }

  /**
   * Run N prompts in parallel with bounded concurrency (ADRs D134-D140).
   *
   * Each prompt gets a fresh agent (create → send → wait → dispose). Failures
   * are isolated per-prompt; the batch never throws on a single failure —
   * inspect `result.ok` to discriminate success vs error. Default
   * concurrency is 4. When `options.providers.apiKeys` has ≥2 keys per
   * provider, all in-flight agents share a single credential pool via
   * `AsyncLocalStorage` (EC-A) so rate-limit cooldowns are observed once
   * instead of duplicated per agent.
   *
   * Streaming progress is opt-in via `onResult` / `onProgress`. `AbortSignal`
   * cancels pending prompts; in-flight ones continue to completion (Node
   * AbortSignal semantics). `signal.reason` propagates to `error` when set.
   *
   * @public
   */
  static async batch(
    prompts: ReadonlyArray<string | import("./types/batch.js").BatchItem>,
    options: import("./types/batch.js").BatchOptions,
  ): Promise<import("./types/batch.js").BatchResult[]> {
    const { batchImpl } = await import("./internal/agent/batch.js");
    return batchImpl(prompts, options, { create: (opts) => Agent.create(opts) });
  }

  /**
   * Get an existing agent by ID, or create one with the supplied options if
   * the ID is not yet registered. Eliminates the resume-vs-create boilerplate
   * common to chat bots and other long-running agent consumers. See ADR D22.
   *
   * Resolution:
   * 1. Try `Agent.resume(agentId, options)`. Return on success.
   * 2. On `UnknownAgentError`, fall through to `Agent.create({ ...options, agentId })`.
   * 3. On same-process race (`ConfigurationError(code: "agent_id_already_exists")`
   *    during step 2), retry `Agent.resume` once and return the winner's handle.
   * 4. Any other error propagates verbatim.
   *
   * Caveats:
   * - The function-level `agentId` always wins over `options.agentId`.
   * - Options differ between calls? Last-call-wins for this handle (matches `Agent.resume`).
   * - A DISPOSED agent is replaced automatically. `dispose()` evicts the id from the
   *   live cache (`liveAgentRegistry.forget`), so the next `getOrCreate(id)` builds a
   *   fresh handle — no `Agent.delete(agentId)` needed.
   *
   *   This bullet used to say the opposite ("Disposed agents are NOT auto-deleted...
   *   call `Agent.delete(agentId)` first"). It was measured false in M91:
   *   `tests/agent-getorcreate-after-dispose.test.ts` builds an agent, disposes it, and
   *   gets a different instance back. The claim was about the PERSISTENT registry and
   *   read as being about the live cache — and consumers built around the wrong half.
   *   The agent-builder's M85 interrupt rotates the session id to work around a
   *   constraint that does not exist.
   *
   * - `close()` marks the handle disposed WITHOUT evicting the cache entry. It is
   *   internal and unused today; if it becomes reachable, this bullet stops being true
   *   for that path.
   *
   * @public
   */
  static async getOrCreate(agentId: string, options: AgentOptions): Promise<SDKAgent> {
    // T2.6: live-agent cache hit. `get` refreshes lastUsedAt so the entry
    // resists LRU eviction. Cache disabled via `Agent.registry.configure({ maxAgents: 0 })`
    // — set is no-op, get always returns undefined, so re-initialization runs.
    const cached = Agent.registry.get(agentId);
    if (cached !== undefined) return cached;

    const fresh = await getOrCreateUncached(agentId, options);
    Agent.registry.set(agentId, fresh);
    return fresh;
  }

  /**
   * List agents (local or cloud). M107 — `cwd` is READ, not ignored. B-115 (2026-08-19) —
   * `includeArchived` and `limit`/`cursor` are READ too now; see `ListAgentsOptions`'s doc for the
   * pagination contract and why the unlimited (no `limit`) case is unaffected.
   *
   * @public
   */
  static async list(options: ListAgentsOptions = {}): Promise<ListResult<SDKAgentInfo>> {
    const cwd = ("cwd" in options ? options.cwd : undefined) ?? process.cwd();
    await hydrateRegistryFromDisk(cwd);
    const includeArchived =
      "includeArchived" in options ? (options.includeArchived ?? false) : false;
    const agents = listRegisteredAgents(options.runtime, cwd, includeArchived);
    const { items, nextCursor } = paginateByKey(
      agents,
      (agent) => agent.agentId,
      options.limit,
      options.cursor,
      /* sortByKey */ true,
    );
    return {
      items: items.map((agent) => toAgentInfo(agent)),
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    };
  }

  /**
   * Get metadata for a single agent. B-115 (2026-08-19) — `cwd` is READ now (see
   * `GetAgentOptions`'s doc); it used to be accepted and silently ignored.
   *
   * @public
   */
  static async get(agentId: string, options: GetAgentOptions = {}): Promise<SDKAgentInfo> {
    const agent = await getRegisteredAgentOrThrow(agentId, options.cwd);
    return toAgentInfo(agent);
  }

  /**
   * List runs for an agent. B-115 (2026-08-19) — `cwd` and `limit`/`cursor` are READ now (see
   * `ListRunsOptions`'s doc); they used to be accepted and silently ignored.
   *
   * @public
   */
  static async listRuns(agentId: string, options: ListRunsOptions = {}): Promise<ListResult<Run>> {
    await getRegisteredAgentOrThrow(agentId, options.cwd);
    const { items, nextCursor } = paginateByKey(
      listRunsByAgent(agentId),
      (run) => run.id,
      options.limit,
      options.cursor,
      /* sortByKey */ false,
    );
    return { items, ...(nextCursor !== undefined ? { nextCursor } : {}) };
  }

  /**
   * Get a single run.
   *
   * @public
   */
  static async getRun(runId: string, options: GetRunOptions = {}): Promise<Run> {
    if (options.runtime === "cloud") {
      // stale-claim-ok: a runtime throw, not a doc claim — whoever ships the PaaS must delete this
      // branch to make cloud work at all, so it cannot outlive its own truth the way a comment can.
      throw new ConfigurationError(
        "Cloud runtime is pre-release. Theo PaaS endpoints are not wired yet — getRun({ runtime: 'cloud' }) will be enabled when the PaaS ships.",
        { code: "cloud_runtime_pre_release" },
      );
    }
    const existing = getRegisteredRun(runId);
    if (existing !== undefined) return existing;
    throw new UnknownAgentError(
      `Run ${runId} is not in this process's registry. It may have been disposed, persisted in a previous process, or never created.`,
      { code: "run_not_found" },
    );
  }

  /**
   * Archive a cloud agent.
   *
   * @public
   */
  static archive(agentId: string, _options: AgentOperationOptions = {}): Promise<void> {
    return setArchivedFlag(agentId, true);
  }

  /**
   * Restore an archived cloud agent.
   *
   * @public
   */
  static unarchive(agentId: string, _options: AgentOperationOptions = {}): Promise<void> {
    return setArchivedFlag(agentId, false);
  }

  /**
   * Set the human-facing `name` of a registered agent (the label `Agent.list()` returns). The registry
   * already carries a `name` field; this is the missing public mutator for it. Runtime-agnostic (mutates
   * the local per-cwd registry for local agents; the cloud registry for cloud agents).
   *
   * @public
   */
  static async rename(
    agentId: string,
    name: string,
    _options: AgentOperationOptions = {},
  ): Promise<void> {
    await setAgentName(agentId, name);
  }

  /**
   * M50 — compact a LOCAL agent's persisted session transcript (Codex `/compact` parity): the
   * history is summarized (recent user messages preserved verbatim + one marker'd summary) and an
   * append-only `compact_boundary` + replacement chain is written — resume replays only the
   * replacement + later turns. The summarizer defaults to the compression subsystem's aux-LLM
   * (its first real caller); tests/consumers may inject their own.
   *
   * @public
   */
  static async compact(
    agentId: string,
    options: {
      trigger?: "manual" | "auto";
      summarize?: (
        messages: readonly import("./compaction.js").CompressibleMessage[],
      ) => Promise<string>;
    } = {},
  ): Promise<import("./internal/session/compact-session.js").CompactResult> {
    const reg = await requireLocalAgent(agentId, "compact");
    const { compactSessionTranscript, buildDefaultSummarizer } = await import(
      "./internal/session/compact-session.js"
    );
    const { cwd, model, store } = await openLocalStore(reg);
    // M50 review F5 — serialize on the per-agent write chain so a manual compact never interleaves
    // with an in-flight turn's persistence.
    return enqueueSessionWrite(cwd, agentId, () =>
      compactSessionTranscript({
        store,
        loc: { cwd, agentId, model },
        sessionId: agentId,
        trigger: options.trigger ?? "manual",
        summarize:
          options.summarize ??
          buildDefaultSummarizer({
            agentModel: model,
            ...(reg.options.apiKey !== undefined ? { apiKey: reg.options.apiKey } : {}),
          }),
      }),
    );
  }

  /**
   * M51 — inject a SYNTHETIC user+assistant pair into a LOCAL session's persisted transcript WITHOUT
   * running an LLM turn (the Codex review-exit mechanism: the parent thread "learns" a result — e.g.
   * review findings — so follow-ups work). Appends onto the DAG leaf and invalidates the in-memory
   * cache; serialized on the per-agent write chain.
   *
   * @public
   */
  static async injectSessionTurn(
    agentId: string,
    turn: { userText: string; assistantText: string },
  ): Promise<void> {
    const reg = await requireLocalAgent(agentId, "injectSessionTurn");
    const { injectSessionTurn } = await import("./internal/session/inject-session.js");
    const { cwd, model, store } = await openLocalStore(reg);
    await injectSessionTurn({
      store,
      loc: { cwd, agentId, model },
      sessionId: agentId,
      userText: turn.userText,
      assistantText: turn.assistantText,
    });
  }

  /**
   * theokit#146 — read a LOCAL agent's persisted transcript as STRUCTURE, for rendering.
   *
   * A resumed session already replays correctly to the model, but a host had no way to draw it:
   * the only projection available folded a tool call to the string `[tool call] NAME`, dropping the
   * call id and every argument. A card UI got prose, so cross-restart resume was worth less than
   * starting fresh — which is what at least one consumer did.
   *
   * Each returned message carries both projections: `text` (unchanged, what the model replay uses)
   * and `parts` (`text` / `tool_use` / `tool_result` with ids, names, arguments and the
   * `toolUseId` that correlates a result back to its call).
   *
   * Read-only and local-only: it opens the agent's session store and walks the transcript, exactly
   * as {@link Agent.compact} and {@link Agent.injectSessionTurn} do. It appends nothing.
   *
   * @throws UnknownAgentError when `agentId` names no local agent.
   * @public
   */
  static async transcript(agentId: string): Promise<readonly SessionMessage[]> {
    const reg = await requireLocalAgent(agentId, "transcript");
    const { readSessionMessages } = await import("./internal/session/agent-session-store.js");
    const { store } = await openLocalStore(reg);
    return readSessionMessages(store, agentId);
  }

  /**
   * theokit#123 — read-only introspection of a registered agent's tools and subagents.
   *
   * `Agent.list()` / `Agent.get()` enumerate agents and `agent.skills.list()` covers skills, but
   * tools and subagents lived only on `RegisteredAgent.options` — an internal contract. A
   * reflection endpoint (theokit-studio's `theokit dev`) therefore had to report empty lists for
   * both, and say so with an `unavailable_reason`.
   *
   * A PROJECTION, not the options object. Tool handlers and subagent prompts are stripped: a
   * handler is an executable that cannot cross a process boundary, and a prompt is the agent's
   * instructions rather than its signature — a reflection endpoint serializes what it is handed.
   *
   * @throws UnknownAgentError when `agentId` names no registered agent.
   * @public
   */
  static async describe(agentId: string): Promise<AgentDescription> {
    const agent = await getRegisteredAgentOrThrow(agentId);
    // theokit#123 — subagents are RESOLVED, not read off the declaration.
    //
    // The runtime's set is `loadSubagents(cwd, project?, inline)`: file-based roles from
    // `.theokit/agents/*.md` merged with the inline `agentOptions.agents`, and it is never written
    // back into `options`. Projecting `options.agents` therefore reported a disk-defined subagent as
    // absent — and because this shape promises arrays so a caller can tell "none" from "unknown",
    // that under-report was indistinguishable from an honest empty. The exact ambiguity the issue
    // asked to remove.
    const { loadSubagents } = await import("./internal/runtime/skills/subagents-loader.js");
    const settingSources = agent.options.local?.settingSources;
    const subagents = await loadSubagents(
      agent.cwd ?? process.cwd(),
      settingSources === undefined || settingSources.includes("project"),
      agent.options.agents,
    );
    return {
      agentId: agent.agentId,
      runtime: agent.runtime,
      ...(agent.model !== undefined ? { model: agent.model } : {}),
      // Always arrays, so a caller can tell "this agent has none" from "the SDK did not say".
      //
      // Honest limit, stated because the alternative is an implied claim: `tools` is still the
      // DECLARED catalog. Plugin tools and the reasoning `think` tool are assembled per run by
      // `buildRunToolCatalogInput`, so they are not knowable from the registry alone. Documented on
      // `AgentDescription.tools`.
      tools: (agent.options.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
      subagents: Object.entries(subagents).map(([name, def]) => ({
        name,
        description: def.description,
        ...(def.model !== undefined ? { model: def.model } : {}),
        ...(def.tools !== undefined ? { tools: def.tools } : {}),
      })),
    };
  }

  /**
   * Permanently delete a registered agent — local or cloud.
   *
   * #612 — this HYDRATES before removing, and until it did the method was a no-op against the
   * persisted registry whenever the agent was not already in this process's memory. Which is every
   * agent in a freshly started process: `removeRegisteredAgent` only schedules a save when the entry
   * was in the Map, so `agents.delete()` returned `false`, nothing was scheduled, and
   * `flushRegistrySaves()` flushed an empty queue. The entry survived and this returned normally.
   *
   * Every neighbouring mutator already did this — `rename` and `archive` reach
   * `getRegisteredAgentOrThrow`, which hydrates on a miss. `delete` was the only one that did not.
   *
   * `options.cwd` is read rather than defaulted away: it is declared on `AgentOperationOptions`, and
   * hydrating `process.cwd()` unconditionally is the B-115 defect — an option that compiles and does
   * nothing — on the one path that is supposed to remove data.
   *
   * Deleting an unknown id still resolves rather than throwing, deliberately. `rename` throws
   * `UnknownAgentError` and matching it here is defensible, but it is a breaking change for callers
   * that delete idempotently, and an entry and its transcript can legitimately outlive one another
   * in both directions. That decision belongs to its own change, not to a persistence fix.
   *
   * @public
   */
  static async delete(agentId: string, options: AgentOperationOptions = {}): Promise<void> {
    await hydrateRegistryFromDisk(options.cwd ?? process.cwd());
    removeRegisteredAgent(agentId);
    await flushRegistrySaves();
  }
}

async function getOrCreateUncached(agentId: string, options: AgentOptions): Promise<SDKAgent> {
  try {
    return await Agent.resume(agentId, options);
  } catch (err) {
    if (!(err instanceof UnknownAgentError)) throw err;
  }
  try {
    return await Agent.create({ ...options, agentId });
  } catch (err) {
    if (err instanceof ConfigurationError && err.code === "agent_id_already_exists") {
      return await Agent.resume(agentId, options);
    }
    throw err;
  }
}

// Module-init registration so internal subsystems (LocalAgent.runUntil /
// LocalAgent.fork, eval, scorers, cron) can invoke the public facade without
// inverting the public-api -> internal dependency direction. See
// `internal/runtime/registry/agent-factory-registry.ts` for rationale.
setAgentFacade({
  create: (options) => Agent.create(options),
  delete: (agentId) => Agent.delete(agentId),
  prompt: (message, options) => Agent.prompt(message, options),
  get: (agentId) => Agent.get(agentId),
  resume: (agentId, options) => Agent.resume(agentId, options),
  batch: (prompts, options) => Agent.batch(prompts, options),
});

/**
 * Resolve a registered LOCAL agent, hydrating the per-cwd registry first when this process has not
 * seen it yet.
 *
 * The three session methods — `compact`, `injectSessionTurn`, `transcript` — opened with the same
 * eight lines: look up, hydrate from disk on a miss (the case a fresh TUI hits before its first
 * turn, D21), look up again, then refuse anything that is not local. Same duplicated KNOWLEDGE the
 * docblock below records for `openLocalStore`, in the step above it: "how to find a registered local
 * agent" is one rule, and a change to the hydration path applied to two of three copies is a method
 * that silently stops working in a fresh process.
 *
 * `operation` only shapes the message — the refusal names what the caller was trying to do, which is
 * what the three hand-written strings were for.
 */
async function requireLocalAgent(
  agentId: string,
  operation: string,
): Promise<NonNullable<ReturnType<typeof getRegisteredAgent>>> {
  let reg = getRegisteredAgent(agentId);
  if (reg === undefined) {
    await hydrateRegistryFromDisk(process.cwd());
    reg = getRegisteredAgent(agentId);
  }
  if (reg === undefined || reg.runtime !== "local") {
    throw new UnknownAgentError(
      `No local agent "${agentId}" registered — ${operation} targets local sessions.`,
    );
  }
  return reg;
}

/**
 * Opens the local session store of a registered agent.
 *
 * This was duplicated across `Agent.compact` and `Agent.injectSessionTurn` — both resolved `cwd` and
 * `model` (with the same three-level fallback) and built the `FsSessionStore` with the same
 * `baseDir`. That is duplicated KNOWLEDGE: "how to locate a local agent's transcript" is ONE rule,
 * and fixing one copy without the other would make `compact` and `injectSessionTurn` operate on
 * different files — silent corruption, not an error.
 */
async function openLocalStore(reg: {
  cwd?: string;
  model?: { id: string };
  // #301 — `sessionDir` is the option; `baseDir` is its deprecated alias, and a
  // registered agent may carry either depending on when it was created.
  options: { model?: string | { id: string }; local?: { sessionDir?: string; baseDir?: string } };
}): Promise<{
  cwd: string;
  model: string;
  store: import("./internal/persistence/fs-session-store.js").FsSessionStore;
}> {
  const cwd = reg.cwd ?? process.cwd();
  const optModel = reg.options.model;
  const model =
    reg.model?.id ?? (typeof optModel === "string" ? optModel : optModel?.id) ?? "unknown";
  const { FsSessionStore } = await import("./internal/persistence/fs-session-store.js");
  const { defaultBaseDir, expandTilde } = await import(
    "./internal/persistence/session-transcript.js"
  );
  // #301 — `sessionDir` is the current name; `baseDir` is honoured as the
  // deprecated alias so a resume never fails on a rename.
  const configuredSessionDir = reg.options.local?.sessionDir ?? reg.options.local?.baseDir;
  const baseDir =
    configuredSessionDir !== undefined ? expandTilde(configuredSessionDir) : defaultBaseDir();
  return { cwd, model, store: new FsSessionStore({ baseDir, cwd }) };
}
