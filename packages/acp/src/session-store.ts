/**
 * In-memory session store mapping ACP `sessionId` → `AcpSession` (D356).
 *
 * Per-`serveAcp()` invocation. No global state.
 *
 * @internal
 */

import type { AgentLike } from "@theokit/sdk";

/** One live ACP session: the agent serving it, its cwd, its abort handle, and access timestamps. */
export interface AcpSession {
  readonly sessionId: string;
  readonly agent: AgentLike;
  readonly createdAt: number;
  lastUsedAt: number;
  /**
   * The abort handle of the CURRENT turn, replaced by {@link armTurn} at the start of each one.
   *
   * It is per-turn rather than per-session because that is what `session/cancel` means: the host
   * stops the answer being written, not the conversation. It used to be created once at session
   * creation and never replaced, so one cancel handed every later prompt an already-aborted signal
   * and the session was dead while still looking alive (#349).
   */
  abortController: AbortController;
  readonly cwd: string;
}

/**
 * Give `session` a fresh abort scope for a turn that is about to start, and return its signal.
 *
 * Called at the top of every prompt. The previous controller is dropped: whatever it was cancelling
 * has already finished or been aborted, and a turn must never inherit a decision made about an
 * earlier one.
 */
export function armTurn(session: AcpSession): AbortSignal {
  session.abortController = new AbortController();
  return session.abortController.signal;
}

/**
 * Sessions held by one `serveAcp` call. In-memory only: a restart loses every entry, which is why
 * `session/load` goes back through the SDK's conversation storage instead of this map.
 *
 * Not thread-safe and does not need to be — one Node process, one event loop.
 */
export class SessionStore {
  private readonly map = new Map<string, AcpSession>();

  /** @throws Error on a duplicate id — the caller must have checked `has` first. */
  create(session: AcpSession): void {
    if (this.map.has(session.sessionId)) {
      throw new Error(`duplicate sessionId: ${session.sessionId}`);
    }
    this.map.set(session.sessionId, session);
  }

  get(sessionId: string): AcpSession | undefined {
    return this.map.get(sessionId);
  }

  /** `true` when an entry was removed. Does NOT dispose the agent or abort its controller. */
  delete(sessionId: string): boolean {
    return this.map.delete(sessionId);
  }

  /** A new array over the live session objects — the array is a copy, the sessions are not. */
  list(): AcpSession[] {
    return [...this.map.values()];
  }

  size(): number {
    return this.map.size;
  }

  has(sessionId: string): boolean {
    return this.map.has(sessionId);
  }
}
