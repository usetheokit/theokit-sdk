import { diag } from "../../diagnostics.js";
import type { AgentRuntime, RegisteredAgent } from "./agent-registry-contract.js";
import { fromSerialized, loadRegistry, saveRegistry } from "./agent-registry-store.js";

/**
 * Process-wide agent registry. Holds the metadata needed to satisfy
 * Agent.list/Agent.get/Agent.resume across local and cloud runtimes,
 * plus the user-provided config that drives `agent.send()`.
 *
 * Write-through to disk per ADR D17: every mutation schedules a coalesced
 * save to `<cwd>/.theokit/agents/registry.json`. Reads stay sync; the public
 * `Agent.resume` / `Agent.list` / `Agent.get` entry points hydrate from disk
 * lazily via `hydrateRegistryFromDisk`.
 *
 * **T3.1 of plan `arch-review-fixes-2026-06-06` (ADR D431):** the shared
 * `AgentRuntime` and `RegisteredAgent` types are now defined in
 * `agent-registry-contract.ts` (a leaf types file) and re-exported here for
 * back-compat with downstream code. The store layer (`agent-registry-store.ts`)
 * imports the types from the contract too, breaking the previous
 * runtime↔store cycle.
 *
 * @internal
 */

// Re-exported for back-compat — consumers that historically imported these
// from `./agent-registry.js` keep working. New code SHOULD import from
// `./agent-registry-contract.js` directly.
export type { AgentRuntime, RegisteredAgent };

const agents = new Map<string, RegisteredAgent>();
/**
 * In-flight AND completed hydrations, keyed by `cwd`.
 *
 * M107 — this used to be a `Set<string>` marking "already hydrated", and the mark was written
 * BEFORE the `await` on the disk read. A second concurrent `hydrateRegistryFromDisk(cwd)` therefore
 * saw the mark and returned immediately, while the first call had not populated anything yet — so
 * the second caller listed an EMPTY registry and got `[]`. Memoizing the promise instead of a flag
 * makes the second caller await the same read.
 *
 * The bug was latent while `Agent.list` always hydrated `process.cwd()`; making `cwd` a real
 * parameter turns "two concurrent listings of a not-yet-hydrated project" into an ordinary path —
 * and that listing feeds `activeKnown`, a NEVER-delete guard on a path that calls `unlink`. An empty
 * listing there is not a slow listing, it is a deleted transcript.
 */
const hydrations = new Map<string, Promise<void>>();
const pendingSaves = new Map<string, Promise<void>>();
const dirtyCwds = new Set<string>();

function resolveRegistryCwd(agent: Pick<RegisteredAgent, "cwd">): string {
  return agent.cwd ?? process.cwd();
}

/** `local.registry: false` keeps an agent out of every file this module writes. */
function isPersisted(agent: RegisteredAgent): boolean {
  return agent.options.local?.registry !== false;
}

function snapshotForCwd(cwd: string): Record<string, RegisteredAgent> {
  const snapshot: Record<string, RegisteredAgent> = {};
  for (const agent of agents.values()) {
    if (resolveRegistryCwd(agent) === cwd && isPersisted(agent)) {
      snapshot[agent.agentId] = agent;
    }
  }
  return snapshot;
}

/**
 * Coalesce burst writes per-cwd: if a save is already pending, the new
 * mutation rides on it (the pending save picks up the latest in-memory state
 * via `snapshotForCwd`).
 *
 * @internal
 */
function scheduleSaveForCwd(cwd: string): Promise<void> {
  // Always mark dirty so a save already in flight will re-loop and pick up
  // this mutation. Without this, two synchronous registerAgent calls would
  // coalesce into ONE save whose snapshot only captured the first agent —
  // the second mutation's data would silently drop off disk.
  dirtyCwds.add(cwd);
  const existing = pendingSaves.get(cwd);
  if (existing !== undefined) return existing;
  const promise = (async () => {
    try {
      while (dirtyCwds.has(cwd)) {
        dirtyCwds.delete(cwd);
        // Yield once so the in-flight microtask burst (registerAgent +
        // updateRegisteredAgent calls fired in the same tick) all commit
        // their `agents.set` before we snapshot.
        await Promise.resolve();
        await saveRegistry(cwd, snapshotForCwd(cwd));
        // Loop guard: if a mutation arrived during saveRegistry's await,
        // dirtyCwds.has(cwd) is true again — go around for another save.
      }
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      diag(`[theokit-sdk] registry persist failed (${cwd}): ${msg}\n`);
    } finally {
      pendingSaves.delete(cwd);
    }
  })();
  pendingSaves.set(cwd, promise);
  return promise;
}

export function registerAgent(agent: RegisteredAgent): void {
  agents.set(agent.agentId, agent);
  if (!isPersisted(agent)) return;
  void scheduleSaveForCwd(resolveRegistryCwd(agent));
}

export function getRegisteredAgent(agentId: string): RegisteredAgent | undefined {
  return agents.get(agentId);
}

/**
 * The registered agents, optionally narrowed by runtime and by workspace `cwd`.
 *
 * ## M107 — why `cwd` is a parameter here and not a filter at the call site
 *
 * The in-memory Map is process-wide, so hydrating a foreign `cwd` pours its entries into the SAME
 * Map that a later un-narrowed listing reads. Without this filter, listing project A would make
 * project B "own" A's sessions — and the consumer feeds that list into `activeKnown`, one of the
 * NEVER-delete guards on a path that calls `unlink`.
 *
 * The narrowing uses {@link resolveRegistryCwd}, NOT `agent.cwd === cwd`, and that is the whole
 * point: `cwd` is optional on a registered agent, and its absence ALREADY means `process.cwd()` for
 * the purposes of routing the entry to a file on disk. A naive equality check would drop every
 * cwd-less entry from the listing of its own project — an entry missing from `activeKnown` is an
 * entry the collector stops protecting. Filter and persistence must answer "which project owns
 * this?" the same way, or they are two oracles over one fact.
 *
 * @internal
 */
export function listRegisteredAgents(
  runtime?: AgentRuntime,
  cwd?: string,
  // B-115 (measured 2026-08-19): `Agent.list({ includeArchived })` compiled and was silently
  // dropped — archived agents were always included, with no way to hide them. Default `false`
  // (hide archived), matching the field's name and the common "includeX" list-API convention.
  includeArchived = false,
): RegisteredAgent[] {
  let out = Array.from(agents.values());
  if (runtime !== undefined) out = out.filter((agent) => agent.runtime === runtime);
  if (cwd !== undefined) out = out.filter((agent) => resolveRegistryCwd(agent) === cwd);
  if (!includeArchived) out = out.filter((agent) => !agent.archived);
  return out;
}

export function updateRegisteredAgent(
  agentId: string,
  update: Partial<RegisteredAgent>,
): RegisteredAgent | undefined {
  const existing = agents.get(agentId);
  if (existing === undefined) return undefined;
  const updated: RegisteredAgent = {
    ...existing,
    ...update,
    lastModified: Date.now(),
  };
  agents.set(agentId, updated);
  if (!isPersisted(updated)) return updated;
  void scheduleSaveForCwd(resolveRegistryCwd(updated));
  return updated;
}

export function removeRegisteredAgent(agentId: string): boolean {
  const existing = agents.get(agentId);
  const removed = agents.delete(agentId);
  if (removed && existing !== undefined && isPersisted(existing)) {
    void scheduleSaveForCwd(resolveRegistryCwd(existing));
  }
  return removed;
}

export function clearAgentRegistry(): void {
  agents.clear();
  hydrations.clear();
}

/**
 * Lazily load the persisted registry for `cwd` into the in-memory Map. Skips
 * if this cwd has already been hydrated in this process. Disk-only entries
 * win over the empty in-memory state; in-memory entries (already-registered
 * agents) are never overwritten by hydration.
 *
 * @internal
 */
export async function hydrateRegistryFromDisk(cwd: string): Promise<void> {
  const inFlight = hydrations.get(cwd);
  if (inFlight !== undefined) return inFlight;
  const hydration = (async () => {
    const persisted = await loadRegistry(cwd);
    for (const [id, entry] of Object.entries(persisted)) {
      if (!agents.has(id)) {
        agents.set(id, fromSerialized(entry));
      }
    }
  })().catch((cause: unknown) => {
    // A failed hydration must not stay memoized as "done": the next call would resolve
    // successfully over a registry that was never read — an empty list indistinguishable from
    // "this project has no agents". Dropping the entry lets the next call retry, and the error
    // still propagates to THIS caller (`error-handling.md § 2` — never swallow).
    hydrations.delete(cwd);
    throw cause;
  });
  hydrations.set(cwd, hydration);
  return hydration;
}

/**
 * Invalidate the hydration cache for `cwd` (or all cwds when omitted). Forces
 * the next `hydrateRegistryFromDisk(cwd)` to re-read from disk. Test-only.
 *
 * @internal
 */
export function invalidateRegistryHydration(cwd?: string): void {
  if (cwd !== undefined) hydrations.delete(cwd);
  else hydrations.clear();
}

/**
 * Wait for all pending registry saves to complete. Used by tests and by the
 * agent dispose path to guarantee on-disk state matches the in-memory state
 * before the caller continues.
 *
 * @internal
 */
export async function flushRegistrySaves(cwd?: string): Promise<void> {
  if (cwd !== undefined) {
    await (pendingSaves.get(cwd) ?? Promise.resolve());
    return;
  }
  while (pendingSaves.size > 0) {
    await Promise.all(Array.from(pendingSaves.values()));
  }
}
