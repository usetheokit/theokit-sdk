/**
 * #598 — enumerate the sessions on disk, saying where each id came from.
 *
 * ## Why this exists
 *
 * Every transcript helper this package published mapped FORWARD — `sessionUuidFor`,
 * `transcriptPath`, `legacyTranscriptPath`, `encodeProjectDir`, `transcriptRoot`. **None enumerated.**
 * So a consumer that needed the list rebuilt it, and two independent ones did, in opposite
 * directions, and both got it wrong on the first attempt:
 *
 * | consumer | direction | what broke |
 * |---|---|---|
 * | `@theokit/agents` | file → id | derived the id from the file STEM |
 * | a downstream agent runtime | id → file | compared session ids against filenames |
 *
 * The second measured, against 5.0.1: the protected set never matched, **so neither the registered
 * sessions nor the live one were protected and everything classified as an orphan** — a garbage
 * collector that would delete the session in use.
 *
 * ## Why documentation was not the fix
 *
 * `b85dab4` documented the rename thoroughly. One of those two consumers had READ it and broke
 * anyway; the other had not and broke identically. Two samples, one informed and one not, same
 * defect. If reading were sufficient the informed sample would have survived — so the cause is the
 * shape of the surface, not the reader.
 *
 * And it cannot be closed by publishing an inverse: the filename is a UUIDv8 over SHA-256, which has
 * none. Whoever holds the file must read the id from INSIDE it, and that the id lives in the first
 * record is this package's knowledge. Both consumers had to discover it by reading bytes.
 *
 * ## Why the id is not just a string
 *
 * An `id: string` that is sometimes read from the transcript and sometimes inferred from the
 * filename is the same defect one layer up: a value that reads as authoritative and occasionally is
 * not. That is precisely what produced the garbage-collector failure above.
 *
 * So every entry carries {@link SessionListing.idSource}, and an entry whose id could not be
 * determined is `undefined` rather than guessed. A caller deciding what to DELETE needs to tell
 * "this session is not registered" from "I could not read this file" — those look identical in a
 * plain list and mean opposite things.
 *
 * @public
 */

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { encodeProjectDir, transcriptRoot } from "./session-transcript.js";

/** How the `id` on a {@link SessionListing} was obtained. */
export type SessionIdSource =
  /** Read from the `sessionId` of the transcript's first well-formed record. Authoritative. */
  | "transcript"
  /**
   * Not determined: the file was unreadable, empty, or its first records carried no `sessionId`.
   * `id` is `undefined` — deliberately not the filename, which is a hash and not an id.
   */
  | "unavailable";

/** One session found on disk. */
export interface SessionListing {
  /**
   * The session id, or `undefined` when {@link idSource} is `"unavailable"`.
   *
   * Never derived from the filename. The filename is a UUIDv8 over SHA-256 of the id, so treating
   * it as the id is the exact defect this function exists to prevent.
   */
  readonly id: string | undefined;
  /** Where {@link id} came from. Check this before acting on `id`. */
  readonly idSource: SessionIdSource;
  /** The `cwd` of the first transcript record that carries one, within the same bounded scan. */
  readonly cwd?: string | undefined;
  /** Absolute path to the `.jsonl` transcript. */
  readonly transcript: string;
  /** Last modification time of the transcript. */
  readonly modifiedAt: Date;
}

/** Options for {@link listSessions}. */
export interface ListSessionsOptions {
  /**
   * Root under which `projects/<encoded-cwd>/` lives. Defaults to {@link transcriptRoot}, which
   * honours `THEOKIT_HOME`.
   */
  readonly baseDir?: string;
  /**
   * How many bytes of each transcript to read looking for the id. Default 65536.
   *
   * A cap rather than a full read because a transcript grows without bound and the id is in the
   * first record. A session whose id is not in the first 64KB reports `"unavailable"` rather than
   * being read to the end — bounded work with a declared outcome beats an unbounded read.
   */
  readonly idScanBytes?: number;
}

export const DEFAULT_ID_SCAN_BYTES = 64 * 1024;

/**
 * Every session transcript under `<baseDir>/projects/<encoded-cwd>/`, with the id read from inside
 * each file.
 *
 * An absent directory yields `[]` — a cwd with no sessions is the common case, not an error.
 *
 * ```ts
 * for (const s of await listSessions(process.cwd())) {
 *   if (s.idSource === "unavailable") continue;   // do not guess, and do not delete
 *   …
 * }
 * ```
 */
export async function listSessions(
  cwd: string,
  options: ListSessionsOptions = {},
): Promise<readonly SessionListing[]> {
  const dir = join(options.baseDir ?? transcriptRoot(), "projects", encodeProjectDir(cwd));
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const out: SessionListing[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const transcript = join(dir, name);
    let modifiedAt: Date;
    try {
      modifiedAt = (await stat(transcript)).mtime;
    } catch {
      // Vanished between readdir and stat — a live session being rotated. Skipping is correct:
      // reporting a file that no longer exists would be worse than omitting it.
      continue;
    }
    const { id, cwd } = await scanTranscriptHead(
      transcript,
      options.idScanBytes ?? DEFAULT_ID_SCAN_BYTES,
    );
    out.push({
      id,
      cwd,
      idSource: id === undefined ? "unavailable" : "transcript",
      transcript,
      modifiedAt,
    });
  }
  return out;
}

/** What a bounded scan of one transcript's head found. */
export interface TranscriptHead {
  readonly id?: string | undefined;
  readonly cwd?: string | undefined;
}

/**
 * The first `sessionId` and the first string `cwd` found in the first `maxBytes` of a transcript.
 *
 * Reads at most `maxBytes` and stops once both are found. Tolerant of malformed lines for the same
 * reason `readTranscript` is: a truncated final line in a live transcript is normal, and failing the
 * whole listing over it would make the function useless exactly when it matters.
 */
export async function scanTranscriptHead(path: string, maxBytes: number): Promise<TranscriptHead> {
  const found: { id?: string; cwd?: string } = {};
  const take = (line: string): boolean => {
    const head = headOfLine(line);
    found.id ??= head.id;
    found.cwd ??= head.cwd;
    return found.id !== undefined && found.cwd !== undefined;
  };
  let buffered = "";
  try {
    const stream = createReadStream(path, { encoding: "utf8", end: maxBytes - 1 });
    for await (const chunk of stream) {
      buffered += chunk as string;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      if (lines.some(take)) {
        stream.destroy();
        return found;
      }
    }
  } catch {
    return found;
  }
  take(buffered);
  return found;
}

function headOfLine(line: string): TranscriptHead {
  const none: TranscriptHead = {};
  if (line.trim() === "") return none;
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) return none;
    const { sessionId, cwd } = parsed as { sessionId?: unknown; cwd?: unknown };
    return {
      id: typeof sessionId === "string" && sessionId !== "" ? sessionId : undefined,
      cwd: typeof cwd === "string" && cwd !== "" ? cwd : undefined,
    };
  } catch {
    return none;
  }
}
