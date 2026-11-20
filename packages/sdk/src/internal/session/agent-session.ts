import type { SessionStore } from "../../types/session-store.js";
import {
  type PersistTurnInput,
  persistTurn,
  readSessionMessages,
  type TranscriptLocation,
} from "./agent-session-store.js";

/**
 * Per-agent conversation history kept across runs (and across `Agent.resume()`
 * within the same process). Lets the fixture responder recall prior facts when
 * the user asks a follow-up question.
 *
 * SE40 — disk persistence IS the native Claude-shaped `.jsonl` transcript. The
 * in-memory cache holds the narrowed `SessionMessage[]` (user/assistant text) so
 * a send can read `priorMessages` synchronously; the whole rich turn (user +
 * assistant + tool blocks) lands on disk once per send via {@link persistTurnToTranscript}
 * (fed by `run.conversation()`). Hydration on resume reconstructs the session by
 * walking the transcript DAG (`readSessionMessages`).
 *
 * @internal
 */

// `SessionMessage` lives in `./session-types.ts` (leaf types file). Re-exported
// for back-compat with downstream importers that pulled it from here.
export type { SessionMessage } from "./types.js";

import type { SessionMessage } from "./types.js";

// M75 — the cache lives in a leaf; see session-cache.ts for the reason (cycle broken by extraction).
export {
  hydratedKeys,
  invalidateSessionCache,
  sessions,
  transcriptKey,
} from "./session-cache.js";

import { diag } from "../diagnostics.js";
import { globalSingleton } from "../global-singleton.js";
import { hydratedKeys, sessions, transcriptKey } from "./session-cache.js";

const pendingWrites = new Map<string, Promise<void>>();
const recordCounts = new Map<string, number>();

/**
 * Append a session message to the in-memory cache only. Disk persistence for the
 * whole turn happens once per send via {@link persistTurnToTranscript}; the cache
 * feeds `priorMessages` / `onBeforeSend.previousMessageCount` synchronously.
 *
 * @internal
 */
export function appendSessionMessage(agentId: string, message: SessionMessage): void {
  const existing = sessions.get(agentId) ?? [];
  existing.push(message);
  // `delete` + `set` reinserts at the END: a JS `Map` preserves insertion order, so the first key
  // is always the least recently touched. That is the entire LRU, with no new structure (parsimony
  // rungs 2/5 — the ordering we need is already a language guarantee).
  sessions.delete(agentId);
  sessions.set(agentId, existing);
  enforceCeiling();
}

/**
 * Ceiling on sessions kept in memory.
 *
 * The runtime only reads the **active** session; the rest is pure cache, rebuildable from the
 * on-disk transcript. 32 is deliberately generous — the primary removal path is the explicit
 * `discardSession()` at the end of the agent's life, and this ceiling is a safety net against a
 * long-lived process running hundreds of sessions (plan risk #2: a tight ceiling could evict a
 * session still referenced by an in-flight async path).
 */
export const MAX_CACHED_SESSIONS = 32;

function enforceCeiling(): void {
  while (sessions.size > MAX_CACHED_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) return;
    sessions.delete(oldest);
    forgetBookkeeping(oldest);
  }
}

/**
 * Erases the bookkeeping for an `agentId` across EVERY `cwd` it appears in.
 *
 * The three maps are keyed by `transcriptKey(cwd, agentId)`; `sessions` is the only one keyed by the
 * raw `agentId`. The ceiling's first version deleted from all three using `sessions`' key — that is,
 * deleted nothing — and left `hydratedKeys` **orphaned**. Since `hydrateSession` returns early when
 * the marker is present, an evicted session came back **empty** instead of rehydrating from disk:
 * silent amnesia, and a regression new to M95, because before it nothing evicted.
 *
 * The ceiling only knows the `agentId`, not the `cwd`, so it scans by suffix — which is the format
 * `transcriptKey` produces. A scan rather than an index because these maps hold tens of entries, not
 * thousands: a reverse index here would be new structure for a problem that does not exist.
 */
function forgetBookkeeping(agentId: string): void {
  const suffix = transcriptKey("", agentId).slice(0 - agentId.length - 2);
  for (const k of [...hydratedKeys]) if (k.endsWith(suffix)) hydratedKeys.delete(k);
  for (const k of [...pendingWrites.keys()]) if (k.endsWith(suffix)) pendingWrites.delete(k);
  for (const k of [...recordCounts.keys()]) if (k.endsWith(suffix)) recordCounts.delete(k);
}

/**
 * Erases the agent's module bookkeeping and returns how many entries were removed.
 *
 * M95 — `invalidateSessionCache` used to clear **two** of the four maps (`sessions`, `hydratedKeys`);
 * `pendingWrites` and `recordCounts` were never touched by id, so they grew for the life of the
 * process. Neither is large per entry — the leak is in count, not volume — but a cache with no owner
 * for removal is a cache that only grows.
 *
 * Returns the count so the caller can prove the removal; a second discard returns 0, which is what
 * makes the idempotency test possible without exposing the maps.
 */
export function discardSession(cwd: string, agentId: string): number {
  const key = transcriptKey(cwd, agentId);
  let removed = 0;
  // `sessions` is NOT erased here — and the distinction is measured, not aesthetic. It holds the
  // readable conversation, and there is a legitimate reader AFTER dispose: the golden
  // `two-concurrent-sends-serialize` calls `getSessionMessages(agentId)` after `agent.dispose()`.
  // Erasing it here returned an empty list and broke two goldens. What bounds it is the LRU ceiling
  // above; the three below are pure bookkeeping, with no post-dispose reader.
  //
  // The key is `transcriptKey(cwd, agentId)` in ALL THREE — not the raw `agentId`. The first version
  // erased two of them by `agentId` and therefore **never erased anything**; the test did not catch
  // it because it only asserted that the SECOND call returns 0, which is true either way.
  if (hydratedKeys.delete(key)) removed++;
  if (pendingWrites.delete(key)) removed++;
  if (recordCounts.delete(key)) removed++;
  return removed;
}

export function getSessionMessages(agentId: string): SessionMessage[] {
  return sessions.get(agentId) ?? [];
}

/**
 * Persist a full conversation turn (user + assistant + tool blocks) to the native
 * transcript. Chained per-(agent, transcript) so on-disk order matches send order,
 * and fire-and-forget so `send()` is not blocked by disk I/O. Every
 * M50 — when the caller supplies `turn.autoCompact`, size-driven auto-compaction (usage real vs
 * the model's context window) runs in this same chain, surfaced via the optional `onCompact` observer.
 *
 * @internal
 */
export function persistTurnToTranscript(
  store: SessionStore,
  loc: TranscriptLocation,
  sessionId: string,
  turn: PersistTurnInput,
  onCompact?: () => void,
): void {
  const key = transcriptKey(loc.cwd, loc.agentId);
  // PRE-EXISTING debt, exposed when M75 fixed the Biome config that used to abort before
  // sweeping these files (a nested root under refactor/). It is not new code and was not touched
  // by M75; refactoring SDK internals without review would trade a visible problem for a diff
  // risky. Tracked in usetheodev/theokit-sdk#151.
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: see the reason just above
  const chained = (pendingWrites.get(key) ?? Promise.resolve()).then(async () => {
    try {
      await persistTurn(store, loc, sessionId, turn);
      const count = (recordCounts.get(key) ?? 0) + 1;
      recordCounts.set(key, count);
      // M50 — the 50-turn no-summary boundary stub is GONE (it silently amnesia'd the session).
      // Auto-compaction is now size-driven with a real summary: see `maybeAutoCompact` below,
      // invoked in this same write chain by the post-run lifecycle when usage is known.
      if (turn.autoCompact !== undefined) {
        const { autoCompactIfNeeded } = await import("./compact-session.js");
        const fired = await autoCompactIfNeeded({
          store,
          loc,
          sessionId,
          usageTotal: turn.autoCompact.usageTotal,
          contextWindow: turn.autoCompact.contextWindow,
          turnCount: count,
          summarize: turn.autoCompact.summarize,
        });
        if (fired) onCompact?.();
      }
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      diag(`[theokit-sdk] session transcript write failed (${loc.agentId}): ${msg}\n`);
    }
  });
  pendingWrites.set(
    key,
    chained.then(
      () => undefined,
      () => undefined,
    ),
  );
}

/**
 * Load the persisted transcript into the in-memory cache. Idempotent per
 * (baseDir, cwd, agentId). Call once per agent lifecycle before the first read.
 *
 * @internal
 */
export async function hydrateSession(
  agentId: string,
  loc: { store: SessionStore; cwd: string },
): Promise<void> {
  const key = transcriptKey(loc.cwd, agentId);
  if (hydratedKeys.has(key)) return;
  hydratedKeys.add(key);

  const persisted = await readSessionMessages(loc.store, agentId);
  if (persisted.length === 0) return;
  // M51 review F4 — the DISK is the source of truth at hydration time: after an invalidation
  // (compact/inject), an in-flight turn may have repopulated the cache with a SINGLE message before
  // this hydrate ran; the old "skip when non-empty" guard then pinned the parent to a 1-message
  // context (history + injected pair lost until restart). The persist chain serializes writes, so
  // the disk already contains that in-flight turn — replacing is always correct.
  sessions.set(agentId, persisted);
}

/**
 * Wait for all pending transcript writes to settle. Used by tests and by the
 * agent dispose path so on-disk state matches in-memory before the caller proceeds.
 *
 * @internal
 */
export async function flushSessionWrites(): Promise<void> {
  while (pendingWrites.size > 0) {
    const all = Array.from(pendingWrites.values());
    pendingWrites.clear();
    await Promise.all(all);
  }
}

/**
 * Drop the in-memory message cache for `agentId` and NOTHING else — the hydration marker in
 * `hydratedKeys` deliberately stays.
 *
 * That asymmetry is the feature, not an oversight, and it is what separates this from
 * `invalidateSessionCache`, which drops both. The single caller is the personality switch's
 * `reset: true` path (`internal/personality/switch.ts`): leaving the marker set makes
 * `hydrateSession` return early, so the next send starts from an EMPTY context instead of
 * replaying the pre-reset transcript off disk. Clearing the marker here would re-hydrate the
 * conversation the reset was asked to discard.
 *
 * The same shape read as a bug one function up: `forgetBookkeeping` documents an evicted session
 * coming back empty as "silent amnesia". The difference is intent — eviction wants the transcript
 * back, a reset does not. Anyone reaching for this to invalidate a cache wants
 * `invalidateSessionCache(cwd, agentId)` instead.
 */
export function clearSession(agentId: string): void {
  sessions.delete(agentId);
}

/**
 * M50 review F5 — run `fn` serialized on the SAME per-(cwd,agentId) write chain the per-turn
 * persistence uses, so a manual `Agent.compact` can never interleave with an in-flight turn's
 * writes (boundary landing mid-turn would orphan the turn from the replay).
 */
export function enqueueSessionWrite<T>(
  cwd: string,
  agentId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = transcriptKey(cwd, agentId);
  const prior = pendingWrites.get(key) ?? Promise.resolve();
  const result = prior.then(fn);
  pendingWrites.set(
    key,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

/** Test-only: drop every cached session and hydration marker. @internal */
export function clearAllSessions(): void {
  sessions.clear();
  hydratedKeys.clear();
  recordCounts.clear();
  // M50 review F11 — the auto-compact attempt marks live on globalThis; tests reset them here.
  // Through the helper, with the SAME key compact-session.ts uses: two files hand-rolling one slot is
  // how two copies of a mechanism drift apart.
  globalSingleton(
    "theokit-sdk.session.auto-compact-attempts",
    () => new Map<string, number>(),
  ).clear();
}
