/**
 * The MCP client pool behind `mcpLifecycle: 'session'`, and who owns a run's clients.
 *
 * MOVED HERE 2026-09-02 from `real-local-run.ts`. It is a process-wide resource with its own
 * lifecycle rules — acquisition, idle reaping, per-session disposal — living inside a file whose
 * other five concerns were about assembling one run. Ownership (`runOwnsMcpClients`) is derived in
 * ONE place so `buildMcpMap` and the run's `finally` cannot disagree about who releases a client;
 * keeping that guarantee is the reason the two functions travel together.
 *
 * @internal
 */

import type { AgentOptions } from "../../types/agent.js";
import { createMcpClient, type McpClient } from "../mcp/client.js";
import { McpClientPool } from "./mcp-pool.js";
import type { CreateRealLocalRunOptions } from "./real-local-run-options.js";

/**
 * M77 — the process-wide pool backing `mcpLifecycle: 'session'`.
 *
 * Keyed by `(agentId, server, config)`, so it is session-scoped despite being a module-level object:
 * `agentId` IS the session identity here (it is what `getSessionMessages` keys the transcript cache
 * by), and `LocalAgent.dispose()` releases its own entries. Two agents never see each other's
 * clients.
 */
const sessionMcpPool = new McpClientPool<McpClient>();

/** M77 — release one session's pooled MCP clients. Called from `LocalAgent.dispose()`. */
export function disposeSessionMcpClients(agentId: string): void {
  sessionMcpPool.disposeSession(agentId, (client) => {
    void client.close();
  });
}

/**
 * M77 — the production seam, exported for the wiring test.
 *
 * Exported (`_` prefix, `@internal`) rather than left private because the pool is only worth having
 * if `buildMcpMap` actually reaches it. Testing the pool class alone would prove the CLASS reuses,
 * not that the SYSTEM does — the exact gap the M76 review found in the ask-bridge.
 *
 * @internal
 */
export function _buildMcpMapForTests(options: CreateRealLocalRunOptions): Map<string, McpClient> {
  return buildMcpMap(options);
}

/**
 * theokit#155 — does THIS RUN own the MCP clients it was handed?
 *
 * Under the default `'run'` lifecycle the client is built for this send and dies with it, so the
 * run closes it. Under `'session'` the pool owns it: closing it at the end of the turn SIGTERMs the
 * child process, and the next turn spawns a new one — which is exactly why the option measured
 * 0 ms of savings. Ownership is derived here, once, so `buildMcpMap` and the run's `finally` cannot
 * disagree about who releases the resource.
 */
export function runOwnsMcpClients(agentOptions: AgentOptions): boolean {
  return agentOptions.mcpLifecycle !== "session";
}

export function buildMcpMap(options: CreateRealLocalRunOptions): Map<string, McpClient> {
  const map = new Map<string, McpClient>();
  const inline = options.sendOptions.mcpServers ?? options.agentOptions.mcpServers;
  if (inline === undefined) return map;

  // M77 — `'run'` stays the default: a client per send, dropped with the run. Only an explicit
  // `mcpLifecycle: 'session'` reaches the pool, because pooling changes the failure model (see the
  // option's docblock). The reap runs on acquisition rather than on a timer: a timer would keep the
  // process alive, and a pool nobody touches has nothing worth reaping.
  const pooled = !runOwnsMcpClients(options.agentOptions);
  if (pooled) sessionMcpPool.reapIdle((c) => void c.close());

  for (const [name, config] of Object.entries(inline)) {
    map.set(
      name,
      pooled
        ? sessionMcpPool.acquire(options.agentId, name, config, () => createMcpClient(name, config))
        : createMcpClient(name, config),
    );
  }
  return map;
}
