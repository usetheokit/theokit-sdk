/**
 * `write_file` — built-in tool for coding agents.
 *
 * Writes UTF-8 content to a project-relative path. Creates parent
 * directories recursively. Refuses binary-file overwrites, path
 * traversal, and sensitive paths.
 *
 * Return shape (always a JSON string):
 *   - `{ ok: true, path, bytes }` on success
 *   - `{ ok: false, error: 'path_traversal' | 'forbidden_path' |
 *        'binary_file' }` on refusal
 */

import { stat as fsStat, mkdir, open, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CustomTool } from "@theokit/sdk";
import { Tool } from "@theokit/sdk";
import {
  FileNotFoundError,
  type FilesystemBackend,
  FilesystemError,
  type FilesystemProvider,
  FilesystemReadOnlyError,
  FilesystemSecurityError,
  resolveFilesystem,
  StaleFileError,
} from "@theokit/sdk/filesystem";
import { z } from "zod";
import { anchorPath, resolveBaseDir } from "./internal/base-dir.js";
import {
  assertNoSymlinkEscape,
  ForbiddenPathError,
  isForbiddenPath,
  PathTraversalError,
  safePathJoin,
} from "./internal/path-guard.js";
import { evaluateReadBeforeWrite, type ReadTracker } from "./read-tracker.js";

/** Byte window inspected for null bytes when deciding binary vs text. */
const BINARY_PROBE_BYTES = 8 * 1024;

/** The run-scoped context a `defineTool` handler receives as its 2nd argument. */
type WriteToolContext = { signal?: AbortSignal; context?: unknown };

/**
 * Options for {@link createWriteFileTool}. `requireReadBeforeWrite` and `readTracker` are a pair —
 * the flag without the tracker is refused at construction rather than quietly disabling the guard.
 */
export interface CreateWriteFileToolOptions {
  /** M76 — name exposed to the model. Omitted => today's literal (additive). The name is a contract:
   *  the approval key, what the model sees and what telemetry records. */
  name?: string;
  /** M76 — description exposed to the model. Omitted => today's literal (additive). */
  description?: string;
  /** Absolute path to the project root. Every write is gated against this boundary. */
  projectRoot: string;
  /**
   * Base for relative paths in the model's input. Default: `projectRoot`.
   * Must be `projectRoot` or a directory inside it; anything else throws at construction.
   * `projectRoot` stays the boundary every resolved path is checked against.
   */
  baseDir?: string;
  /**
   * SE31 — optional pluggable filesystem backend (`@theokit/sdk/filesystem`), or
   * a per-request resolver `(ctx) => FilesystemBackend`. When provided, writes
   * route through it (its own boundary + `readOnly` + per-request root) instead
   * of the local project fs. Omitted ⇒ identical current behavior (local
   * `projectRoot`). The `.env`/`.git` policy still applies (storage-independent).
   */
  filesystem?: FilesystemProvider<WriteToolContext>;
  /**
   * SE32 — when true (and a {@link ReadTracker} is supplied), refuse to
   * overwrite an existing file that was not read first, or that changed on disk
   * since it was read (`read_required` / `stale_file`). A NEW file writes
   * freely. Default OFF (unchanged behavior).
   */
  requireReadBeforeWrite?: boolean;
  /** SE32 — the per-run tracker populated by the paired `read_file` tool. */
  readTracker?: ReadTracker;
}

/**
 * Build the `write_file` tool. It OVERWRITES: reach for {@link createEditFileTool} when the file
 * exists and only part of it changes.
 *
 * Parent directories are created recursively. Refusals arrive as `{ ok: false, error }`:
 * `forbidden_path`, `path_traversal`, `binary_file`, plus `read_required` / `stale_file` when
 * read-before-write is on, plus `read_only` / `write_failed` on the backend path.
 *
 * The `binary_file` probe (a null byte in the first 8 KB of the file being replaced) runs on the
 * local path only. A `filesystem` backend has no equivalent, so overwriting a binary file through a
 * backend is not refused.
 *
 * Throws at construction — not at call time — when `requireReadBeforeWrite` is set without a
 * `readTracker`. A guard that silently does nothing is worse than no guard, and construction is the
 * only place the pairing can be checked.
 */
export function createWriteFileTool(opts: CreateWriteFileToolOptions): CustomTool {
  const { projectRoot, filesystem } = opts;
  const baseDir = resolveBaseDir("createWriteFileTool", projectRoot, opts.baseDir);
  // SE32 — fail fast on a misconfiguration: requiring read-before-write without
  // a tracker would SILENTLY disable the guard (a dangerous false sense of
  // safety). Refuse at construction (Rule 8) instead of a silent no-op.
  if (opts.requireReadBeforeWrite && !opts.readTracker) {
    throw new Error(
      "createWriteFileTool: requireReadBeforeWrite is true but no readTracker was provided — " +
        "pass the same ReadTracker instance to createReadFileTool and createWriteFileTool.",
    );
  }
  // The tracker is only consulted when read-before-write is enabled.
  const guard = opts.requireReadBeforeWrite ? opts.readTracker : undefined;

  return Tool.create({
    name: opts.name ?? "write_file",
    description:
      opts.description ??
      "Write UTF-8 content to a project-relative file, creating parent directories as needed. " +
        "OVERWRITES any existing file at the path. Prefer editing an existing file with edit_file " +
        "over rewriting it; use write_file to create a NEW file or fully replace a small one. If the " +
        "file already exists, read_file it first so you do not discard content you have not seen. " +
        "Refuses paths that escape the write root and sensitive files (.env, .git/, node_modules/, " +
        ".theo/, lock files); the default local root also refuses binary-file overwrites. Returns " +
        "{ ok, path, bytes } or { ok: false, error }.",
    inputSchema: z.object({
      path: z.string().min(1).describe("Project-relative file path."),
      content: z.string().describe("UTF-8 content to write."),
    }),
    handler: async ({ path, content }, ctx) => {
      if (isForbiddenPath(path) || isForbiddenPath(anchorPath(baseDir, path))) {
        return JSON.stringify({ ok: false, error: "forbidden_path", path });
      }
      // SE31 — route through the pluggable backend when one is configured (the
      // backend owns its own boundary, readOnly, and provider); else local fs.
      if (filesystem) {
        const backend = await resolveFilesystem(filesystem, ctx ?? {});
        return writeViaBackend(backend, path, content, guard);
      }
      return writeViaLocalFs(projectRoot, baseDir, path, content, guard);
    },
  });
}

/**
 * SE32 — map a read-before-write decision to the tool's error JSON, or `null`
 * when the write may proceed. `currentMtimeMs` is `null` for a not-yet-existing
 * file. No-op (returns null) when no tracker guards this write.
 */
function readBeforeWriteError(
  guard: ReadTracker | undefined,
  path: string,
  currentMtimeMs: number | null,
): string | null {
  if (!guard) return null;
  const decision = evaluateReadBeforeWrite(guard, path, currentMtimeMs);
  if (decision === "read_required")
    return JSON.stringify({ ok: false, error: "read_required", path });
  if (decision === "stale") return JSON.stringify({ ok: false, error: "stale_file", path });
  return null;
}

/** Local-`projectRoot` write path: boundary + read-before-write + binary guard + write. */
async function writeViaLocalFs(
  projectRoot: string,
  baseDir: string,
  path: string,
  content: string,
  guard: ReadTracker | undefined,
): Promise<string> {
  let absolutePath: string;
  try {
    absolutePath = safePathJoin(projectRoot, anchorPath(baseDir, path));
    assertNoSymlinkEscape(absolutePath, projectRoot);
  } catch (err) {
    if (err instanceof PathTraversalError || err instanceof ForbiddenPathError) {
      return JSON.stringify({ ok: false, error: "path_traversal", path });
    }
    throw err;
  }

  // SE32 — read-before-write check against the current on-disk mtime. NOTE: the
  // local path detects a file that CHANGED between read and write, but the
  // window between this stat and the writeFile below is an accepted TOCTOU
  // (same-user local context — matching @theokit/sdk/filesystem's LocalFilesystem
  // disclaimer). The `filesystem` backend path additionally forwards
  // `expectedMtime` for a tighter write-time re-check.
  const rbw = readBeforeWriteError(guard, path, await statMtimeOrNull(absolutePath));
  if (rbw) return rbw;

  // Binary file guard: probe existing file for null bytes before overwriting
  if (await isBinaryFile(absolutePath)) {
    return JSON.stringify({ ok: false, error: "binary_file", path });
  }

  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf-8");
  const bytes = Buffer.byteLength(content, "utf-8");

  return JSON.stringify({ ok: true, path, bytes });
}

/** Current mtime of `absolutePath`, or `null` when the file does not exist. */
async function statMtimeOrNull(absolutePath: string): Promise<number | null> {
  try {
    return (await fsStat(absolutePath)).mtimeMs;
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Current mtime of `path` via the backend, or `null` when absent. A single
 * `stat()` with a typed-not-found catch — avoids the exists()+stat() TOCTOU
 * where the file could vanish between the two calls (a `FileNotFoundError`
 * would otherwise escape the write handler's catch and crash the loop).
 */
async function backendMtimeOrNull(
  backend: FilesystemBackend,
  path: string,
): Promise<number | null> {
  try {
    return (await backend.stat(path)).mtimeMs;
  } catch (err) {
    if (err instanceof FileNotFoundError) return null;
    throw err;
  }
}

/**
 * SE31 — write through a {@link FilesystemBackend}, mapping its typed errors to
 * the tool's `{ ok: false, error }` JSON shape (never throws on a user mistake).
 */
async function writeViaBackend(
  backend: FilesystemBackend,
  path: string,
  content: string,
  guard: ReadTracker | undefined,
): Promise<string> {
  try {
    // SE32 — read-before-write against the backend's current mtime; on pass,
    // forward `expectedMtime` so the backend re-checks at write time (TOCTOU).
    let expectedMtime: number | undefined;
    if (guard) {
      const current = await backendMtimeOrNull(backend, path);
      const rbw = readBeforeWriteError(guard, path, current);
      if (rbw) return rbw;
      expectedMtime = current ?? undefined;
    }
    const stat = await backend.writeFile(
      path,
      content,
      expectedMtime !== undefined ? { expectedMtime } : undefined,
    );
    return JSON.stringify({ ok: true, path, bytes: stat.size });
  } catch (err) {
    return backendErrorToJson(err, path);
  }
}

/**
 * Map a {@link FilesystemBackend} typed error to the tool's `{ ok: false }` JSON
 * (a recoverable "bad path"/"stale" the agent should see, not a loop-crashing
 * throw). Rethrows anything untyped (a genuine bug should surface).
 */
function backendErrorToJson(err: unknown, path: string): string {
  if (err instanceof FilesystemSecurityError) {
    return JSON.stringify({ ok: false, error: "path_traversal", path });
  }
  if (err instanceof FilesystemReadOnlyError) {
    return JSON.stringify({ ok: false, error: "read_only", path });
  }
  if (err instanceof StaleFileError) {
    return JSON.stringify({ ok: false, error: "stale_file", path });
  }
  if (err instanceof FilesystemError) {
    return JSON.stringify({ ok: false, error: "write_failed", path });
  }
  throw err;
}

async function isBinaryFile(absolutePath: string): Promise<boolean> {
  let handle: import("node:fs/promises").FileHandle | undefined;
  try {
    handle = await open(absolutePath, "r");
  } catch {
    return false; // file doesn't exist yet — not binary
  }
  try {
    const stat = await handle.stat();
    const probeLen = Math.min(BINARY_PROBE_BYTES, Number(stat.size));
    if (probeLen <= 0) return false;
    const probe = Buffer.alloc(probeLen);
    const { bytesRead } = await handle.read(probe, 0, probeLen, 0);
    for (let i = 0; i < bytesRead; i += 1) {
      if (probe[i] === 0) return true;
    }
    return false;
  } finally {
    await handle.close();
  }
}
