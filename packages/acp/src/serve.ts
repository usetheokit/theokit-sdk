/**
 * `serveAcp({ agent })` — top-level entry that wires the ACP server.
 *
 * Constructs `AgentSideConnection` from `@agentclientprotocol/sdk@^0.22`,
 * delegates lifecycle methods to `lifecycle.ts`, and drives the prompt
 * translator from `translator.ts`. All state (sessions, warnings, defaults) is
 * per invocation — nothing is module-global, so two `serveAcp` calls on
 * different stream pairs do not see each other (D356).
 *
 * @public
 */

import { Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { resolveAgentFactory } from "./agent-resolver.js";
import {
  buildInitializeResponse,
  handleCancel,
  handleForkSession,
  handleListSessions,
  handleLoadSession,
  handleNewSession,
} from "./lifecycle.js";
import { handlePrompt } from "./prompt-handler.js";
import { SessionStore } from "./session-store.js";
import type { AcpServerOptions, PermissionMode } from "./types.js";

const DEFAULT_MAX_PROMPT_BYTES = 2 * 1024 * 1024;
const DEFAULT_PERMISSION_TIMEOUT_MS = 60_000;
const DEFAULT_PERMISSION_MODE: PermissionMode = "ask";

/**
 * Serve `options.agent` to an ACP host over JSON-RPC on stdio, blocking until the input stream ends.
 *
 * ```ts
 * await serveAcp({ agent: (sessionId) => Agent.create({ agentId: sessionId }) });
 * ```
 *
 * Needs `@agentclientprotocol/sdk` and `@theokit/sdk` installed (peer dependencies). It reads no
 * environment variable and no config file of its own; every knob is on {@link AcpServerOptions}.
 * **Do not write to stdout** from the agent or its tools — that stream carries the protocol frames.
 *
 * Resolves once `stdin` emits `end` or `close` AND `dispose()` has settled for every live session
 * (EC-1). A `dispose()` that throws is logged and swallowed, so a bad teardown cannot strand the
 * process.
 *
 * Rejects only when it cannot start: an `InvalidAgentError` when `agent` is neither a function nor
 * an object with a string `agentId` and a callable `send`. That class is exported, so branch on
 * `instanceof InvalidAgentError` rather than on `err.name` (#369). Nothing that happens afterwards
 * rejects this promise — per-request failures go back to
 * the host as JSON-RPC errors:
 *
 * | Condition | Code |
 * |---|---|
 * | `cwd` absent or not on disk (`session/new`, `session/load`, `session/fork`) | `-32602` |
 * | `session/load` for an id already loaded in this process | `-32602` |
 * | prompt with no text block, or over `maxPromptBytes` | `-32602` |
 * | `session/fork` whose parent IS loaded here — deferred to v0.2 | `-32602` |
 * | `session/prompt` or `session/fork` naming a session this process has not loaded | `-32001` |
 * | `session/load` the SDK cannot resume (wrong host, no shared storage) | `-32001` |
 * | agent factory threw | `-32603` |
 * | `permissionDefault` is `"ask"`/`"deny"` and the runtime cannot enforce it | `-32603` |
 * | run ended in a status ACP has no stop reason for | `-32603` |
 *
 * `session/fork` checks the parent BEFORE `cwd`, so a fork naming a parent this process does not
 * hold answers `-32001` and never reaches either `-32602` row above. Because the session store is
 * in-memory and per-process, that is the common case after a restart — `session/fork` is refused in
 * every case, but reading the refusal as "always `-32602`" is wrong.
 *
 * A prompt that completes maps the run onto an ACP stop reason: `end_turn`, `cancelled`, `refusal`
 * (safety), `max_tokens` (context or token cap), `max_turn_requests` (iteration cap).
 *
 * Traps worth knowing before you wire a host to this:
 * - `session/authenticate` always answers success without checking anything (D350) — do not read an
 *   empty `authMethods` plus a successful authenticate as "the agent authorised me".
 * - Only the TEXT blocks of a prompt reach the agent. Images, audio and resources are counted
 *   against `maxPromptBytes`, then dropped.
 * - `session/cancel` aborts the session's single `AbortController`, and nothing re-arms it. Every
 *   later prompt on that session is issued with an already-aborted signal, so treat a cancelled
 *   session as spent and open a new one.
 * - Of the SDK stream, only assistant text, thinking and tool calls are forwarded; `status`, `task`
 *   and `object_delta` messages have no ACP equivalent and are dropped silently.
 * - `serveAcp` does not close `stdout` and does not call `process.exit` — the caller owns the exit.
 *
 * @public
 */
export async function serveAcp(options: AcpServerOptions): Promise<void> {
  const log = options.log ?? ((msg: string) => process.stderr.write(`${msg}\n`));
  const factory = resolveAgentFactory(options.agent, { log });
  const store = new SessionStore();
  const maxPromptBytes = options.maxPromptBytes ?? DEFAULT_MAX_PROMPT_BYTES;
  const permissionMode = options.permissionDefault ?? DEFAULT_PERMISSION_MODE;
  const permissionTimeoutMs = options.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
  const trustedTools = new Set(options.trustedTools ?? []);

  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;

  // Convert Node streams ↔ Web streams for ndJsonStream. process.stdin is
  // a Node Readable; toWeb gives us the WHATWG ReadableStream.
  // For stdout we wrap into a Writable stream that flushes via the Node API.
  const inputWeb = Readable.toWeb(stdin as Readable) as ReadableStream<Uint8Array>;
  const outputWeb = new WritableStream<Uint8Array>({
    write(chunk: Uint8Array): Promise<void> {
      return new Promise((resolve, reject) => {
        const ok = stdout.write(chunk, (err) => (err ? reject(err) : undefined));
        if (ok) resolve();
        else stdout.once("drain", resolve);
      });
    },
  });
  const stream = acp.ndJsonStream(outputWeb, inputWeb);

  const closedPromise = new Promise<void>((resolve) => {
    stdin.once("end", () => resolve());
    stdin.once("close", () => resolve());
  });

  // Construct connection. The agentBuilder is invoked synchronously by the SDK.
  new acp.AgentSideConnection((conn) => {
    return {
      initialize: async (params) =>
        buildInitializeResponse(params, {
          capabilities: options.capabilities,
          ...(options.info !== undefined ? { info: options.info } : {}),
        }),

      authenticate: async (_params): Promise<acp.AuthenticateResponse> => {
        // D350 — auth deferred to v0.2; return empty success.
        return {};
      },

      newSession: async (params) => {
        const result = await handleNewSession(params, { factory, store, log, permissionMode });
        if ("error" in result) {
          throw new acp.RequestError(result.error.code, result.error.message, result.error.data);
        }
        return result.response;
      },

      loadSession: async (params) => {
        const result = await handleLoadSession(params, { store, log });
        if ("error" in result) {
          throw new acp.RequestError(result.error.code, result.error.message);
        }
        return result.response;
      },

      unstable_forkSession: async (params) => {
        const result = await handleForkSession(params, { store, log });
        if ("error" in result) {
          throw new acp.RequestError(result.error.code, result.error.message);
        }
        return result.response;
      },

      listSessions: async (params) => handleListSessions(params, store),

      cancel: async (params) => {
        handleCancel(params, { store });
      },

      prompt: async (params) => {
        const result = await handlePrompt(params, {
          store,
          conn,
          maxPromptBytes,
          permissionMode,
          permissionTimeoutMs,
          trustedTools,
          log,
        });
        if ("error" in result) {
          throw new acp.RequestError(result.error.code, result.error.message);
        }
        return result.response;
      },
    };
  }, stream);

  // EC-1: wait for stdin close, then dispose every live session before resolving.
  await closedPromise;
  const sessions = store.list();
  log(`[acp] stdin closed; disposing ${sessions.length} session(s)`);
  await Promise.allSettled(
    sessions.map(async (session) => {
      try {
        await session.agent.dispose?.();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`[acp] dispose of ${session.sessionId} threw: ${msg}`);
      }
    }),
  );
}
