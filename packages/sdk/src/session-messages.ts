import { FsSessionStore } from "./internal/persistence/fs-session-store.js";
import { resolveSessionDir } from "./internal/persistence/session-dir.js";
import { readSessionMessages as readFromStore } from "./internal/session/agent-session-store.js";
import type { SessionMessage } from "./types/session-message.js";

/** Which session to read, in the terms a host already has. */
export interface ReadSessionMessagesOptions {
  /** The session's agent id — the same id `Agent` was created or resumed with. */
  sessionId: string;
  /**
   * The working directory the session belongs to. Sessions are per-cwd, so the same
   * id under a different cwd is a different session. Defaults to `process.cwd()`.
   */
  cwd?: string;
  /**
   * Where transcripts live. Only needed when the agent was created with
   * `local.sessionDir`; otherwise the SDK's default location is used.
   */
  sessionDir?: string;
}

/**
 * Read the messages a session already contains, for a surface that needs to re-render it.
 *
 * #546 — the SDK read these records to give the model its context on resume, and a host had
 * no way to read the same thing: a resumed session showed an empty screen while the model
 * demonstrably remembered. The alternative was for the host to parse
 * `<sessionDir>/projects/<encoded-cwd>/<id>.jsonl` itself, which is a private contract —
 * both the record shape and the directory encoding are the SDK's to change.
 *
 * This is deliberately narrower than the internal reader it wraps. That one takes a
 * {@link SessionStore}, and exporting it would put that interface, its record shape and its
 * lease semantics into the public surface to serve a caller that only wants to render what
 * is already there. A host that HAS a custom store can already read from it directly.
 *
 * Parsing stays tolerant, as it is on the resume path: a malformed line costs one message,
 * not the screen. A session that was never written resolves to `[]` rather than throwing —
 * a fresh session has no history, which is not an error.
 *
 * @example
 * ```ts
 * const history = await readSessionMessages({ sessionId, cwd: projectDir });
 * for (const m of history) render(m.role, m.text);
 * ```
 */
export async function readSessionMessages(
  options: ReadSessionMessagesOptions,
): Promise<SessionMessage[]> {
  const cwd = options.cwd ?? process.cwd();
  const baseDir = resolveSessionDir({ sessionDir: options.sessionDir });
  return readFromStore(new FsSessionStore({ baseDir, cwd }), options.sessionId);
}
