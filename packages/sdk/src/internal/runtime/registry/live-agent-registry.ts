/**
 * Live-agent cache for production deploys (Production-Readiness #2, ADRs D307-D310).
 *
 * Caches `SDKAgent` instances by id with LRU eviction (when `size > maxAgents`)
 * and an idle-timeout sweep (configurable interval, default 60s). Solves the
 * "OOM at some point" failure mode of long-running Node servers that keep
 * spawning fresh agents per conversation.
 *
 * **Distinct from `agent-registry.ts`** (the metadata registry that persists
 * `RegisteredAgent` to `registry.json` per cwd). That module is the "address
 * book"; this module is the "live cache". Conflating them violates SRP — see
 * ADR D307.
 *
 * Defaults (ADR D308): `maxAgents: 100`, `idleTimeoutMs: 30 min`, sweep `60s`.
 * Calibrated for indie/small-team Node deploys; high-traffic SaaS should
 * `configure({ maxAgents: 1000 })`.
 *
 * @public (singleton exposed via `Agent.registry`)
 */

import type { SDKAgent } from "../../../types/agent.js";
import { diag } from "../../diagnostics.js";
import { globalSingleton } from "../../global-singleton.js";

export type EvictReason = "lru" | "idle" | "explicit";

/**
 * Knobs for {@link LiveAgentRegistry.configure}.
 *
 * The three numeric fields are a partial reconfigure — one left out keeps its current value.
 * `onEvict` is NOT: it is assigned on every call, so `configure({ maxAgents: 200 })` clears a
 * listener registered earlier. Re-pass the listener whenever you reconfigure.
 *
 * Two values are load-bearing zeroes. `maxAgents: 0` disables caching entirely, so every lookup
 * misses and every agent is rebuilt; `idleTimeoutMs: 0` keeps the cache but leaves LRU as the only
 * eviction, because the sweep is not started at all below that threshold. Negative numbers are
 * clamped rather than rejected — up to 1000ms for `sweepIntervalMs`, up to 0 for the other two.
 *
 * @public
 */
export interface AgentRegistryOptions {
  /**
   * Maximum number of agents kept alive simultaneously. LRU eviction when
   * exceeded. Default: 100.
   *
   * Setting `0` disables the cache entirely — every `Agent.getOrCreate`
   * re-initializes (high cost, but predictable memory).
   */
  maxAgents?: number;

  /**
   * Idle timeout in milliseconds. Agents not used for this duration are
   * evicted on the next sweep tick. Default: 1_800_000 (30 minutes).
   * Set `0` to disable idle eviction.
   */
  idleTimeoutMs?: number;

  /**
   * Sweep interval in milliseconds. Default: 60_000 (60s).
   * Lower = more responsive eviction but more CPU. Higher = staler entries.
   */
  sweepIntervalMs?: number;

  /**
   * Called whenever an agent is evicted. Listener errors are swallowed
   * with a one-shot stderr warn (do not crash the eviction loop).
   */
  onEvict?: (id: string, reason: EvictReason) => void;
}

interface CacheEntry {
  agent: SDKAgent;
  lastUsedAt: number;
}

const DEFAULT_MAX_AGENTS = 100;
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/**
 * An LRU-plus-idle cache of live `SDKAgent` instances, reached through `Agent.registry`.
 *
 * It exists for long-running servers that would otherwise build a fresh agent per conversation and
 * never release one. Do not confuse it with the metadata registry in `agent-registry.ts`, which
 * persists `RegisteredAgent` records to disk: that one is the address book, this one is the live
 * cache, and they share nothing.
 *
 * The lifecycle rule that matters to callers: eviction — by LRU, by idle timeout, or by an explicit
 * `evict` — calls `dispose()` on the agent. A reference you held onto before eviction is a disposed
 * agent, not a detached one. `get` counts as a use and refreshes the entry's timestamp, so polling
 * for an agent keeps it alive indefinitely.
 *
 * Idle eviction depends on a background sweep that only `configure` starts. A registry nobody
 * configured caches with the documented defaults but evicts by LRU alone, so entries can sit past
 * `idleTimeoutMs` indefinitely; call `configure` — even with no changes — to arm the sweep.
 *
 * Failures on the eviction path are swallowed and reported to the diagnostics channel — a throwing
 * `dispose()` or a throwing `onEvict` listener must not stop the sweep. Configuration is
 * process-wide and last-call-wins.
 *
 * @public
 */
export class LiveAgentRegistry {
  readonly #agents = new Map<string, CacheEntry>();
  #maxAgents = DEFAULT_MAX_AGENTS;
  #idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;
  #sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS;
  #onEvict: ((id: string, reason: EvictReason) => void) | undefined;
  #sweepTimer: NodeJS.Timeout | undefined;
  /** Holds per agent instance (not per id: an evicted instance can outlive a newer one). */
  readonly #holds = new Map<SDKAgent, { id: string; count: number }>();
  /** Holds claimed per id while a build is still in flight, before the instance is known. */
  readonly #reserved = new Map<string, number>();
  /** Evicted while held: disposed (and reported) when the last hold ends. */
  readonly #pendingDispose = new Map<SDKAgent, string>();

  /**
   * Reconfigure registry behavior. Process-wide singleton (D310) — last
   * configure call wins for all subsequent operations.
   */
  configure(opts: AgentRegistryOptions): void {
    if (opts.maxAgents !== undefined) this.#maxAgents = Math.max(0, opts.maxAgents);
    if (opts.idleTimeoutMs !== undefined) this.#idleTimeoutMs = Math.max(0, opts.idleTimeoutMs);
    if (opts.sweepIntervalMs !== undefined)
      this.#sweepIntervalMs = Math.max(1_000, opts.sweepIntervalMs);
    this.#onEvict = opts.onEvict;
    // Reset sweep with new config.
    this.#stopSweep();
    if (this.#idleTimeoutMs > 0) this.#startSweep();
  }

  /**
   * Lookup a cached agent. `get` is a use — refreshes `lastUsedAt` so the
   * entry survives LRU eviction.
   */
  get(id: string): SDKAgent | undefined {
    const entry = this.#agents.get(id);
    if (entry === undefined) return undefined;
    entry.lastUsedAt = Date.now();
    return entry.agent;
  }

  /**
   * Insert or overwrite an agent in the cache. Triggers fire-and-forget LRU
   * eviction when `size > maxAgents`.
   *
   * EC-4: when `id` already maps to a DIFFERENT agent instance, dispose the
   * old one before overwriting (race protection against two `getOrCreate`
   * calls creating two agents but only the second being cached — the first
   * would leak file handles + lifecycle controllers).
   */
  set(id: string, agent: SDKAgent): void {
    if (this.#maxAgents === 0) return; // cache disabled
    const existing = this.#agents.get(id);
    if (existing !== undefined && existing.agent !== agent) {
      if (this.#isHeld(id, existing.agent)) {
        this.#pendingDispose.set(existing.agent, id);
      } else {
        // Dispose the old entry off the hot path. Errors swallowed per D309.
        void existing.agent.dispose().catch(() => {
          diag(`[theokit-sdk] dispose during overwrite failed (${id})\n`);
        });
      }
    }
    this.#agents.set(id, { agent, lastUsedAt: Date.now() });
    if (this.#agents.size > this.#maxAgents) void this.#evictLRU();
  }

  /**
   * Remove the entry from the cache WITHOUT calling `dispose()` or
   * `onEvict`. Used by `LocalAgent.dispose()` itself so the disposed
   * instance can never be returned by a subsequent `get(id)` (dispose-cache
   * race fix). Idempotent — calling on an unknown id is a no-op.
   *
   * @internal
   */
  forget(id: string): void {
    this.#agents.delete(id);
  }

  /**
   * Explicitly evict an agent by id. Returns `true` when the entry was
   * present (false = already gone). Calls `agent.dispose()` + `onEvict`
   * with reason `"explicit"`.
   */
  async evict(id: string): Promise<boolean> {
    const entry = this.#agents.get(id);
    if (entry === undefined) return false;
    this.#agents.delete(id);
    await this.#disposeOrDefer(id, entry.agent, "explicit");
    return true;
  }

  /**
   * Number of live holds on the agent currently or last held under `id` (cached or evicted
   * but not yet disposed). For tests and diagnostics.
   */
  leaseCount(id: string): number {
    let n = 0;
    for (const hold of this.#holds.values()) if (hold.id === id) n += hold.count;
    return n;
  }

  /** @internal Claim `id` before a build so nothing evicts the entry it produces. */
  reserve(id: string): void {
    this.#reserved.set(id, (this.#reserved.get(id) ?? 0) + 1);
  }

  /** @internal Drop one reservation made by {@link reserve}. */
  unreserve(id: string): void {
    const n = (this.#reserved.get(id) ?? 0) - 1;
    if (n > 0) this.#reserved.set(id, n);
    else this.#reserved.delete(id);
  }

  /** @internal Hold `agent` so it is never disposed by eviction. Returns an idempotent release. */
  hold(id: string, agent: SDKAgent): () => void {
    const h = this.#holds.get(agent);
    if (h === undefined) this.#holds.set(agent, { id, count: 1 });
    else h.count += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#releaseHold(id, agent);
    };
  }

  #releaseHold(id: string, agent: SDKAgent): void {
    const h = this.#holds.get(agent);
    if (h !== undefined) {
      h.count -= 1;
      if (h.count > 0) return;
      this.#holds.delete(agent);
    }
    const entry = this.#agents.get(id);
    if (entry !== undefined && entry.agent === agent) entry.lastUsedAt = Date.now();
    const pending = this.#pendingDispose.get(agent);
    if (pending !== undefined && !this.#isHeld(pending, agent)) {
      this.#pendingDispose.delete(agent);
      void this.#disposeAndNotify(pending, agent, "explicit");
      return;
    }
    if (this.#agents.size > this.#maxAgents) void this.#evictLRU();
  }

  #isHeld(id: string, agent: SDKAgent): boolean {
    return (
      (this.#holds.get(agent)?.count ?? 0) > 0 ||
      ((this.#reserved.get(id) ?? 0) > 0 && this.#agents.get(id)?.agent === agent)
    );
  }

  async #disposeOrDefer(id: string, agent: SDKAgent, reason: EvictReason): Promise<void> {
    if (this.#isHeld(id, agent)) {
      this.#pendingDispose.set(agent, id);
      return;
    }
    await this.#disposeAndNotify(id, agent, reason);
  }

  /**
   * Evict every cached agent. Used by graceful shutdown (`process.on('SIGTERM')`)
   * or end-of-test cleanup.
   */
  async evictAll(): Promise<void> {
    const entries = Array.from(this.#agents.entries());
    this.#agents.clear();
    this.#stopSweep();
    for (const [id, entry] of entries) {
      await this.#disposeOrDefer(id, entry.agent, "explicit");
    }
  }

  /** Number of currently cached agents. */
  size(): number {
    return this.#agents.size;
  }

  /** Ids of cached agents, newest first (by lastUsedAt). */
  ids(): readonly string[] {
    return Array.from(this.#agents.entries())
      .sort((a, b) => b[1].lastUsedAt - a[1].lastUsedAt)
      .map(([id]) => id);
  }

  /**
   * LRU eviction: drop the entry with the smallest `lastUsedAt`. Runs only
   * when `size > maxAgents`. Asynchronous because `dispose()` is a Promise;
   * the hot-path caller (`set`) does not await.
   *
   * @internal
   */
  async #evictLRU(): Promise<void> {
    if (this.#agents.size <= this.#maxAgents) return; // size may have shrunk
    let oldestId: string | undefined;
    let oldestAt = Infinity;
    for (const [id, entry] of this.#agents) {
      if (this.#isHeld(id, entry.agent)) continue;
      if (entry.lastUsedAt < oldestAt) {
        oldestAt = entry.lastUsedAt;
        oldestId = id;
      }
    }
    if (oldestId === undefined) return;
    const entry = this.#agents.get(oldestId);
    if (entry === undefined) return;
    this.#agents.delete(oldestId);
    await this.#disposeAndNotify(oldestId, entry.agent, "lru");
  }

  /** Background sweep — drops entries whose `lastUsedAt < now - idleTimeoutMs`. */
  async #sweepIdle(): Promise<void> {
    if (this.#idleTimeoutMs === 0) return;
    const threshold = Date.now() - this.#idleTimeoutMs;
    const toEvict: Array<[string, CacheEntry]> = [];
    for (const [id, entry] of this.#agents) {
      if (entry.lastUsedAt < threshold && !this.#isHeld(id, entry.agent)) toEvict.push([id, entry]);
    }
    for (const [id, entry] of toEvict) {
      // EC-8 race safety: re-check the entry identity. If `set(id, newAgent)`
      // landed during the previous await, the newer entry's `lastUsedAt` is
      // recent and we must NOT delete it.
      const current = this.#agents.get(id);
      if (current?.agent !== entry.agent || this.#isHeld(id, entry.agent)) continue;
      this.#agents.delete(id);
      await this.#disposeAndNotify(id, entry.agent, "idle");
    }
  }

  #startSweep(): void {
    this.#sweepTimer = setInterval(() => void this.#sweepIdle(), this.#sweepIntervalMs);
    // unref so the sweep does not keep the event loop alive on process exit.
    this.#sweepTimer.unref?.();
  }

  #stopSweep(): void {
    if (this.#sweepTimer !== undefined) {
      clearInterval(this.#sweepTimer);
      this.#sweepTimer = undefined;
    }
  }

  /** Dispose + notify with errors swallowed (D309). Single chokepoint. */
  async #disposeAndNotify(id: string, agent: SDKAgent, reason: EvictReason): Promise<void> {
    try {
      await agent.dispose();
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      diag(`[theokit-sdk] dispose during eviction failed (${id}): ${msg}\n`);
    }
    if (this.#onEvict !== undefined) {
      try {
        this.#onEvict(id, reason);
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        diag(`[theokit-sdk] onEvict listener threw (${id}): ${msg}\n`);
      }
    }
  }
}

/**
 * Process-wide singleton (ADR D310).
 *
 * Through `globalSingleton`, not a bare module-level `const`. A module-level const is a singleton per
 * MODULE INSTANCE, and a package can be loaded more than once in a process — two copies in
 * `node_modules`, ESM and CJS side by side, a monorepo with distinct versions. This is the PUBLIC one
 * of the package's module-level singleton states, so two copies of it mean two views of which agents
 * are live, and a caller reading the wrong one sees none.
 */
export const liveAgentRegistry = globalSingleton(
  "theokit-sdk.runtime.live-agents",
  () => new LiveAgentRegistry(),
);
