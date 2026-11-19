/**
 * ACP lifecycle handlers (D352, D354, EC-1/3/5/6).
 *
 * - `buildInitializeResponse` — capability advertisement (D353)
 * - `handleNewSession` — mint a UUID, build the agent through the factory (D351)
 * - `handleLoadSession` — `Agent.resume(sessionId, { local: { cwd } })` (D352, EC-6)
 * - `handleForkSession` — refuses every request; `INVALID_SESSION` when the parent is not in the
 *   store, `INVALID_REQUEST` once it is; deferred to v0.2 (D352, EC-3)
 * - `handleListSessions` — snapshot of the in-memory store
 * - `handleCancel` — abort the session's `AbortController` (D354)
 *
 * Each takes `(params, deps)` and returns either `{ response }` or `{ error }` so `serve.ts` can map
 * the error onto `acp.RequestError` at one place. They are NOT pure: they mint ids, read the clock
 * and mutate the session store.
 *
 * @internal
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { Agent, type AgentLike } from "@theokit/sdk";
import { assertPermissionEnforceable } from "./permission-plugin.js";
import type { AcpSession, SessionStore } from "./session-store.js";
import type { AcpAgentInfo, AcpCapabilities, AgentFactory, PermissionMode } from "./types.js";

// ===== initialize =====

interface InitializeDeps {
  capabilities?: AcpCapabilities;
  info?: AcpAgentInfo;
}

/**
 * Build the `initialize` reply. Ignores the request entirely — the negotiated protocol version is
 * always `acp.PROTOCOL_VERSION` from the installed `@agentclientprotocol/sdk`, never the client's.
 *
 * Advertises `loadSession` (default `true`), the three prompt flags (`image` and `embeddedContext`
 * default `true`, `audio` defaults `false`), and `AcpServerOptions.info` as `agentInfo` when the
 * caller supplied one (#350 — it was accepted and never read). `authMethods` is always empty.
 *
 * `agentInfo` is OMITTED rather than defaulted. Falling back to this package's own metadata would
 * label every agent as the adapter serving it, and a name that is confidently wrong is worse for a
 * host to display than one that is absent.
 */
export function buildInitializeResponse(
  _params: acp.InitializeRequest,
  deps: InitializeDeps,
): acp.InitializeResponse {
  const userCaps = deps.capabilities ?? {};
  return {
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: userCaps.loadSession ?? true,
      promptCapabilities: {
        image: userCaps.prompt?.image ?? true,
        audio: userCaps.prompt?.audio ?? false,
        embeddedContext: userCaps.prompt?.embeddedContext ?? true,
      },
    },
    ...(deps.info !== undefined ? { agentInfo: { ...deps.info } } : {}),
    authMethods: [],
  };
}

// ===== newSession =====

interface NewSessionDeps {
  factory: AgentFactory;
  store: SessionStore;
  log: (msg: string) => void;
  /** When `ask`/`deny`, refuse the session up front if the agent cannot enforce permissions. */
  permissionMode?: PermissionMode;
}

type AcpResult<T> = { ok: true; value: T } | { ok: false; error: AcpError };

/** A JSON-RPC error a handler wants `serve.ts` to raise. `data` is accepted but never sent today. */
export interface AcpError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * The JSON-RPC codes this package names. Only THREE of the four are ever emitted:
 * `INVALID_REQUEST`, `INTERNAL_ERROR` and `INVALID_SESSION`.
 *
 * `AUTH_REQUIRED` has no producer anywhere in `packages/acp` — `serve.ts`'s `authenticate` answers an
 * empty success without checking anything (D350), so no path reaches `-32002`. It is a value reserved
 * for the deferred auth work, not a code a host can observe today.
 *
 * `INVALID_REQUEST` is `-32602` (JSON-RPC "invalid params"), not `-32600` — the name predates the
 * value and the value is what goes on the wire.
 */
export const ACP_ERR = {
  INVALID_REQUEST: -32_602,
  INTERNAL_ERROR: -32_603,
  INVALID_SESSION: -32_001,
  AUTH_REQUIRED: -32_002,
} as const;

/**
 * Validate and resolve `params.cwd` to an absolute existing path (EC-5).
 * Returns `Result` so caller can map to ACP error.
 */
function resolveCwdOrError(rawCwd: string | undefined): AcpResult<string> {
  if (typeof rawCwd !== "string" || rawCwd.length === 0) {
    return {
      ok: false,
      error: { code: ACP_ERR.INVALID_REQUEST, message: "cwd is required" },
    };
  }
  const resolved = path.resolve(rawCwd);
  if (!existsSync(resolved)) {
    return {
      ok: false,
      error: { code: ACP_ERR.INVALID_REQUEST, message: `cwd not found: ${resolved}` },
    };
  }
  return { ok: true, value: resolved };
}

/**
 * Create a session: validate `params.cwd`, mint a UUID, await the factory, register the session.
 *
 * `cwd` is required and must already exist — it is resolved against the SERVER process's cwd when
 * relative, and never created. The generated id is what the host must quote in every later request.
 *
 * Errors: `INVALID_REQUEST` when `cwd` is missing/empty/absent from disk; `INTERNAL_ERROR` when the
 * factory throws. The store is left untouched on either.
 */
export async function handleNewSession(
  params: acp.NewSessionRequest,
  deps: NewSessionDeps,
): Promise<{ response: acp.NewSessionResponse } | { error: AcpError }> {
  const cwdResult = resolveCwdOrError(params.cwd);
  if (!cwdResult.ok) return { error: cwdResult.error };

  const sessionId = randomUUID();
  let agent: AgentLike;
  try {
    agent = await deps.factory(sessionId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.log(`[acp] new_session factory threw: ${msg}`);
    return {
      error: {
        code: ACP_ERR.INTERNAL_ERROR,
        message: `agent factory threw: ${msg}`,
      },
    };
  }

  if (deps.permissionMode !== undefined && deps.permissionMode !== "auto") {
    try {
      assertPermissionEnforceable(agent, deps.permissionMode, sessionId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: unknown }).code;
      deps.log(`[acp] new_session refused: ${msg}`);
      return {
        error: {
          code: ACP_ERR.INTERNAL_ERROR,
          message: msg,
          ...(typeof code === "string" ? { data: { code } } : {}),
        },
      };
    }
  }

  const session: AcpSession = {
    sessionId,
    agent,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    abortController: new AbortController(),
    cwd: cwdResult.value,
  };
  deps.store.create(session);

  return { response: { sessionId } };
}

// ===== loadSession =====

interface LoadSessionDeps {
  store: SessionStore;
  log: (msg: string) => void;
}

const STORAGE_HINT =
  " — if running on serverless/multi-host infra, pass conversationStorage to Agent.create (see docs/recipes/conversation-storage-postgres.md)";

/**
 * Re-attach to a conversation the SDK already persisted, keyed by `params.sessionId` as the agentId.
 *
 * Resolves it through `Agent.resume`, so it only succeeds where that agent's conversation storage is
 * reachable from THIS process — the default local store is per-host, which is why the failure
 * message carries a serverless hint.
 *
 * Errors: `INVALID_REQUEST` for a bad `cwd` or an id this process already holds (loading twice is
 * refused rather than replacing the live session); `INVALID_SESSION` when the resume fails, whatever
 * the underlying cause. Returns an EMPTY response on success — the id the host sent stays valid.
 */
export async function handleLoadSession(
  params: acp.LoadSessionRequest,
  deps: LoadSessionDeps,
): Promise<{ response: acp.LoadSessionResponse } | { error: AcpError }> {
  const cwdResult = resolveCwdOrError(params.cwd);
  if (!cwdResult.ok) return { error: cwdResult.error };

  if (deps.store.has(params.sessionId)) {
    return {
      error: {
        code: ACP_ERR.INVALID_REQUEST,
        message: `session ${params.sessionId} already loaded`,
      },
    };
  }

  let agent: AgentLike;
  try {
    agent = await Agent.resume(params.sessionId, { local: { cwd: cwdResult.value } });
  } catch (err) {
    // EC-6: helpful hint for serverless users
    const msg = err instanceof Error ? err.message : String(err);
    deps.log(`[acp] load_session Agent.resume threw for ${params.sessionId}: ${msg}`);
    return {
      error: {
        code: ACP_ERR.INVALID_SESSION,
        message: `session not found: ${params.sessionId}${STORAGE_HINT}`,
      },
    };
  }

  const session: AcpSession = {
    sessionId: params.sessionId,
    agent,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    abortController: new AbortController(),
    cwd: cwdResult.value,
  };
  deps.store.create(session);

  return { response: {} };
}

// ===== forkSession (unstable_forkSession) =====

interface ForkSessionDeps {
  store: SessionStore;
  log: (msg: string) => void;
}

/**
 * Refuses every fork request. There is no success path in v0.1.
 *
 * It still validates first, so the code tells the host WHICH thing was wrong: `INVALID_SESSION` when
 * the parent is not loaded here, `INVALID_REQUEST` for an unusable `cwd`, and otherwise
 * `INVALID_REQUEST` with the "deferred to v0.2" message. The SDK's `agent.fork()` is a one-shot
 * ephemeral sub-run (D110-D114), not a session split, so wiring it here would give hosts a
 * session id that dies after one turn (EC-3).
 */
export async function handleForkSession(
  params: acp.ForkSessionRequest,
  deps: ForkSessionDeps,
): Promise<{ response: acp.ForkSessionResponse } | { error: AcpError }> {
  const parent = deps.store.get(params.sessionId);
  if (parent === undefined) {
    return {
      error: {
        code: ACP_ERR.INVALID_SESSION,
        message: `parent session not loaded: ${params.sessionId}`,
      },
    };
  }

  // EC-5: resolve params.cwd if provided; else inherit parent.cwd
  let resolvedCwd = parent.cwd;
  if (typeof params.cwd === "string" && params.cwd.length > 0) {
    const cwdResult = resolveCwdOrError(params.cwd);
    if (!cwdResult.ok) return { error: cwdResult.error };
    resolvedCwd = cwdResult.value;
  }

  // V0.1: ACP `unstable_forkSession` is experimental upstream and our SDK's
  // `agent.fork()` is a one-shot ephemeral sub-run (D110-D114), not a
  // long-lived session split. Returning invalid_request prevents misuse
  // until v0.2 implements proper session forking via Agent.create() with
  // parent options inheritance.
  // (EC-3 still observed: any host that calls this on a CloudAgent gets a
  // clean invalid_request rather than UnsupportedRunOperationError.)
  void parent; // parent lookup kept for symmetry + parentId validation
  void resolvedCwd;
  void deps.log;
  return {
    error: {
      code: ACP_ERR.INVALID_REQUEST,
      message:
        "session/fork is deferred to @theokit/acp v0.2 — current SDK fork is a one-shot sub-run, not a session split",
    },
  };
}

// ===== listSessions =====

/**
 * Snapshot the sessions THIS process is holding in memory. Never errors, ignores every filter on the
 * request, and does not read persisted conversations — a restart empties it.
 *
 * `title` is the agent's `agentId`, `lastUpdatedAt` is the last time a prompt or cancel touched the
 * session (not the last agent output).
 */
export function handleListSessions(
  _params: acp.ListSessionsRequest,
  store: SessionStore,
): acp.ListSessionsResponse {
  const sessions = store.list().map((s) => ({
    sessionId: s.sessionId,
    cwd: s.cwd,
    title: s.agent.agentId,
    lastUpdatedAt: new Date(s.lastUsedAt).toISOString(),
  }));
  return { sessions };
}

// ===== cancel =====

interface CancelDeps {
  store: SessionStore;
}

/**
 * Abort the in-flight turn of a session. Idempotent, and silently succeeds for an unknown id —
 * `session/cancel` is a notification, so there is no channel to report one.
 *
 * Scoped to the turn, not to the session: `handlePrompt` arms a fresh `AbortController` before each
 * prompt (`armTurn`), so cancelling one answer leaves the session usable for the next. It used to
 * abort a controller created once at session creation and never replaced, which handed every later
 * prompt an already-aborted signal and killed the session while it still looked alive (#349).
 */
export function handleCancel(params: acp.CancelNotification, deps: CancelDeps): void {
  const session = deps.store.get(params.sessionId);
  if (session === undefined) return; // idempotent — silently succeed on unknown sessionId
  session.lastUsedAt = Date.now();
  if (!session.abortController.signal.aborted) {
    session.abortController.abort("cancelled by ACP client");
  }
}
