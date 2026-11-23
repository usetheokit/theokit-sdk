import { FsSessionStore } from "./internal/persistence/fs-session-store.js";
import { resolveSessionDir } from "./internal/persistence/session-dir.js";
import {
  messagesFromRecords,
  readSessionMessages as readFromStore,
} from "./internal/session/agent-session-store.js";
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

/** A stored session as a host sees it: found, not there, or there but not readable. */
export interface SessionHistory {
  readonly state: "present" | "absent" | "unreadable";
  readonly messages: SessionMessage[];
  /** Lines that were not valid records. A torn last line counts as 1. */
  readonly skippedLines: number;
  /** Set when state is "unreadable": the read or parse error, without file contents. */
  readonly reason?: string;
}

/**
 * Like {@link readSessionMessages}, but tells a session that does not exist (`absent`) from one
 * that was read (`present`) and one that could not be (`unreadable`: a read error other than
 * ENOENT, or a non-empty file with no valid record). Never throws for those cases.
 */
export async function readSessionHistory(
  options: ReadSessionMessagesOptions,
): Promise<SessionHistory> {
  const cwd = options.cwd ?? process.cwd();
  const baseDir = resolveSessionDir({ sessionDir: options.sessionDir });
  const store = new FsSessionStore({ baseDir, cwd });
  let read: Awaited<ReturnType<FsSessionStore["readHistory"]>>;
  try {
    read = await store.readHistory(options.sessionId);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    return unreadable(
      0,
      code === undefined
        ? "transcript could not be read"
        : `transcript could not be read (${code})`,
    );
  }
  if (read.absent) return { state: "absent", messages: [], skippedLines: 0 };
  if (read.records.length === 0 && read.skippedLines > 0) {
    return unreadable(read.skippedLines, "transcript has no valid record");
  }
  try {
    return {
      state: "present",
      messages: messagesFromRecords(read.records),
      skippedLines: read.skippedLines,
    };
  } catch {
    return unreadable(read.skippedLines, "transcript records could not be reconstructed");
  }
}

function unreadable(skippedLines: number, reason: string): SessionHistory {
  return { state: "unreadable", messages: [], skippedLines, reason };
}
