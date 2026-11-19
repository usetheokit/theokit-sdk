/**
 * Lifecycle helpers for {@link import("./local-agent.js").LocalAgent} — writer-lease
 * acquisition/release, `dispose()` teardown, and `reload()` re-discovery.
 *
 * Extracted from `local-agent.ts` to keep that file under the 400-LoC guard (G8),
 * mirroring `local-agent-runtime-extensions.ts`. The grouping is by CONCEPT, not by
 * leftover: all four helpers below answer "what does this agent own outside a single
 * run, and how is it handed back?" — the store lease, the pooled MCP clients, the
 * pending disk writes, and the file-discovered submanagers.
 *
 * @internal
 */

import type { AgentDefinition, AgentOptions } from "../../types/agent.js";
import type { SessionStore } from "../../types/session-store.js";
import { diag } from "../diagnostics.js";
import type { TurnReviewQueue } from "../memory/turn-review.js";
import { withCwdMutex } from "../persistence/cwd-mutex.js";
import type { FileContextManager } from "../runtime/context/context-manager.js";
import type { PluginsManager } from "../runtime/plugin-loader/plugins-manager.js";
import { flushRegistrySaves } from "../runtime/registry/agent-registry.js";
import { liveAgentRegistry } from "../runtime/registry/live-agent-registry.js";
import type { SkillsManager } from "../runtime/skills/skills-manager.js";
import { loadSubagents } from "../runtime/skills/subagents-loader.js";
import { discardSession } from "../session/agent-session.js";
import { flushSessionWrites } from "../session/index.js";
import { disposeSessionMcpClients } from "./real-local-run-mcp.js";

/**
 * Takes the writer lease when the store knows how to take one.
 *
 * Testing for the capability rather than requiring it in the interface keeps the two-method port
 * `types/session-store.ts` declares — an external store (Postgres, S3) has no file lease and does not
 * must not be forced to pretend it has one (ISP).
 *
 * @internal
 */
export async function acquireLeaseIfPossible(store: SessionStore, agentId: string): Promise<void> {
  // `acquire` is a DECLARED optional member now, so this probes a contract instead of guessing at an
  // undeclared one through a cast. The behaviour is unchanged; what changed is that a store author
  // can read the hook in the interface they implement.
  if (typeof store.acquire !== "function") return;
  try {
    await store.acquire(agentId);
  } catch (err) {
    // `SessionBusyError` PROPAGATES — that is the whole point: another process holds the session, and whoever
    // called it needs to decide (`exec` forks to a new id).
    if (err instanceof Error && err.name === "SessionBusyError") throw err;
    // Any other I/O failure (EACCES in a read-only directory, ENOSPC) is **not** contention: there
    // is no second writer, there is a place where nothing can be written. Failing init in that case
    // would trade "no concurrency protection" for "the agent does not start" — and the write itself
    // is best-effort by contract, so the turn would proceed the same without the lease.
    //
    // Measured: nine personality tests use a `baseDir` under `/var/empty`, where the lease's
    // the lease fails. They never write a transcript; requiring the lease there would mean
    // requiring permission to protect a file that does not exist.
    diag(
      `[theokit-sdk] writer lease unavailable for ${agentId} (${
        err instanceof Error ? err.message : String(err)
      }) — proceeding without single-writer protection\n`,
    );
  }
}

/**
 * Releases an agent's lease, when the store knows how to release one by id.
 *
 * A store injected by the consumer is not required to have a lifecycle, so the capability is tested
 * rather than required. The previous wording said declaring it "would force every external store to
 * implement a method most do not need (ISP)" — which conflates DECLARING with REQUIRING. An optional
 * member forces nothing; what it does is let the author of a store see the hook exists.
 *
 * @internal
 */
export async function releaseLeaseIfPossible(store: SessionStore, agentId: string): Promise<void> {
  if (typeof store.release === "function") await store.release(agentId);
}

async function disposeSessionStore(store: SessionStore): Promise<void> {
  if (typeof store.dispose === "function") await store.dispose();
}

/**
 * What {@link disposeLocalAgentSession} needs off the agent. Structural (not the class) so the
 * teardown order stays testable without constructing a whole `LocalAgent`.
 *
 * @internal
 */
export interface LocalAgentDisposeTarget {
  readonly agentId: string;
  readonly workspaceCwd: string;
  readonly lifecycleAbortController: AbortController;
  readonly sessionStore: SessionStore;
  /** `memory.review` queue, drained (bounded) before the agent's resources are released. */
  readonly reviewQueue?: TurnReviewQueue | undefined;
}

/**
 * Tear down everything the agent holds beyond a single run. The CALLER owns the
 * `disposed` flag (idempotence guard) — this function assumes it was already flipped.
 *
 * Order is load-bearing and is the reason this is one function rather than inline steps:
 * flush disk writes BEFORE releasing the store, or the lease is handed back with a write
 * still pending.
 *
 * @internal
 */
export async function disposeLocalAgentSession(agent: LocalAgentDisposeTarget): Promise<void> {
  // Evict from live cache so the next Agent.getOrCreate(id) builds fresh.
  liveAgentRegistry.forget(agent.agentId, agent);
  // Queued memory reviews finish (bounded) BEFORE the abort below: they are the agent's own
  // post-turn work, and the abort would cancel the reviewer's model call.
  await agent.reviewQueue?.drain();
  // D319: fire the lifecycle abort so any in-flight LLM `fetch()` cancels.
  // `abort()` is idempotent — safe to call even when already aborted.
  agent.lifecycleAbortController.abort();
  // Wait for any in-flight send + post-run lifecycle to release the per-agent send mutex.
  // Without this, `dispose()` could return before `writeSessionSummary` finishes, leaving the
  // caller to read a partially-written `.theokit/memory/sessions/<runId>.md` file.
  await withCwdMutex(`agent-send:${agent.agentId}`, () => Promise.resolve());
  // M77 — release this session's pooled MCP clients (`mcpLifecycle: 'session'`). A pooled client
  // outlives the run by design; without this it would outlive the AGENT too, leaving an orphan
  // child process per server for the life of the host. No-op for the default `'run'` lifecycle,
  // which never puts anything in the pool.
  disposeSessionMcpClients(agent.agentId);
  // Now flush any remaining disk writes so the on-disk state matches the in-memory state
  // before the caller proceeds (ADR D17 + D18).
  await flushSessionWrites();
  await flushRegistrySaves(agent.workspaceCwd);
  // M95 — releases the writer lease and erases this agent's FOUR module caches.
  //
  // Order matters: after `flushSessionWrites`, otherwise we would release the lease with a write
  // pending. `invalidateSessionCache` cleared two of the four maps; `pendingWrites` and
  // `recordCounts` were never erased by id and grew for the life of the process.
  await disposeSessionStore(agent.sessionStore);
  discardSession(agent.workspaceCwd, agent.agentId);
}

/**
 * What {@link reloadLocalAgent} needs off the agent.
 *
 * @internal
 */
export interface LocalAgentReloadTarget {
  readonly workspaceCwd: string;
  readonly settingSourcesIncludeProject: boolean;
  readonly options: AgentOptions;
  readonly context?: FileContextManager;
  readonly skillsManager: SkillsManager | undefined;
  readonly pluginsManager: PluginsManager | undefined;
}

/**
 * Re-read every file-discovered source and return the freshly resolved subagents (the one
 * piece of reload state that lives on the agent, so the caller assigns it).
 *
 * @internal
 */
export async function reloadLocalAgent(
  agent: LocalAgentReloadTarget,
): Promise<Record<string, AgentDefinition>> {
  if (agent.context !== undefined) await agent.context.refresh();
  if (agent.skillsManager !== undefined) await agent.skillsManager.refresh();
  if (agent.pluginsManager !== undefined) await agent.pluginsManager.refresh();
  return await loadSubagents(
    agent.workspaceCwd,
    agent.settingSourcesIncludeProject,
    agent.options.agents,
  );
}
