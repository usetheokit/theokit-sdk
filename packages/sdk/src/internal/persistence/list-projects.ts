/**
 * #1079 — enumerate the project folders under `<baseDir>/projects/`, saying which cwd each belongs to.
 *
 * `encodeProjectDir` is not invertible, so the cwd is read from inside the transcripts, which record
 * the cwd they were written from. Read-only: nothing is written or created.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { ConfigurationError } from "../../errors.js";
import { DEFAULT_ID_SCAN_BYTES, scanTranscriptHead } from "./list-sessions.js";
import { transcriptRoot } from "./session-transcript.js";

/** One `projects/<encoded>/` folder found on disk. */
export interface ProjectListing {
  /** Folder name under `<baseDir>/projects`. */
  readonly encoded: string;
  /** Absolute cwd read from a transcript record, when one could be read. */
  readonly cwd?: string;
  readonly cwdSource: "transcript" | "unavailable";
  /** True when transcripts in this folder name different cwds (an encoding collision). */
  readonly cwdConflict?: boolean;
  /** Number of `.jsonl` transcripts in the folder. */
  readonly sessionCount: number;
  /** Newest transcript modification time, or the folder's own when it holds none. */
  readonly modifiedAt: Date;
}

/** Options for {@link listProjects}. */
export interface ListProjectsOptions {
  /** Root under which `projects/` lives. Defaults to {@link transcriptRoot}. */
  readonly baseDir?: string;
  /** Bytes of each transcript read looking for a `cwd`. Positive integer; default 65536. */
  readonly idScanBytes?: number;
}

interface Transcript {
  readonly name: string;
  readonly mtimeMs: number;
  readonly mtime: Date;
  readonly cwd: string | undefined;
}

async function readTranscripts(dir: string, maxBytes: number): Promise<Transcript[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: Transcript[] = [];
  for (const name of names.filter((n) => n.endsWith(".jsonl"))) {
    const path = join(dir, name);
    try {
      const { mtime, mtimeMs } = await stat(path);
      const { cwd } = await scanTranscriptHead(path, maxBytes);
      out.push({ name, mtime, mtimeMs, cwd });
    } catch {
      // Vanished between readdir and stat: omit it.
    }
  }
  return out;
}

async function describeProject(
  root: string,
  encoded: string,
  maxBytes: number,
): Promise<ProjectListing | undefined> {
  const dir = join(root, encoded);
  let dirStat: Awaited<ReturnType<typeof stat>>;
  try {
    dirStat = await stat(dir);
  } catch {
    return undefined;
  }
  if (!dirStat.isDirectory()) return undefined;
  const transcripts = await readTranscripts(dir, maxBytes);
  // Newest first; the filename breaks ties so the choice is deterministic.
  transcripts.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? -1 : 1));
  const withCwd = transcripts.filter((t) => t.cwd !== undefined);
  const cwd = withCwd[0]?.cwd;
  const base = {
    encoded,
    sessionCount: transcripts.length,
    modifiedAt: transcripts[0]?.mtime ?? dirStat.mtime,
  };
  if (cwd === undefined) return { ...base, cwdSource: "unavailable" };
  const conflict = withCwd.some((t) => t.cwd !== cwd);
  return { ...base, cwd, cwdSource: "transcript", ...(conflict ? { cwdConflict: true } : {}) };
}

/**
 * Every project folder under `<baseDir>/projects/`, with its cwd read from the transcripts inside.
 * An absent `projects/` directory yields `[]`.
 */
export async function listProjects(
  options: ListProjectsOptions = {},
): Promise<readonly ProjectListing[]> {
  const maxBytes = options.idScanBytes ?? DEFAULT_ID_SCAN_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new ConfigurationError(
      `idScanBytes must be a positive integer (got ${String(maxBytes)}); a scan of zero bytes can never find a cwd.`,
      { code: "list_projects_scan_bytes_invalid" },
    );
  }
  const root = join(options.baseDir ?? transcriptRoot(), "projects");
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const out: ProjectListing[] = [];
  for (const encoded of entries) {
    const listing = await describeProject(root, encoded, maxBytes);
    if (listing !== undefined) out.push(listing);
  }
  return out;
}
