/**
 * `apply_patch` — built-in tool for coding agents.
 *
 * Codex's V4A patch grammar (`*** Begin Patch` … `*** End Patch`): `*** Add/Update/Delete File:`, an
 * optional `*** Move to:`, and `@@`-anchored `+`/`-`/context hunks matched with a context-tolerant ladder
 * (exact → rstrip → trim → unicode). See `internal/v4a-patch.ts` for the parser + matcher.
 *
 * Applied STRICTLY atomically: the whole patch is planned (every file read + new content computed + path
 * security-checked) before ANY write. A parse error, context mismatch, or path violation anywhere ⇒ typed
 * error and ZERO writes (stronger than Codex, which writes file-by-file and can leave partial writes).
 *
 * Return shape (always a JSON string — never throws on a bad patch):
 *   - `{ ok: true, files_patched: string[] }`
 *   - `{ ok: false, error: 'parse_error' | 'path_traversal' | 'forbidden_path' | 'not_found' |
 *        'patch_failed' | 'duplicate_target' | 'file_exists' | 'io_error' }`
 *
 * Security/robustness (M18 review): forbidden secrets (`.env`/`.git`/`node_modules`/`.theo`) are blocked
 * at ANY path depth and against absolute-path spelling; a file touched by two hunks is rejected
 * (`duplicate_target`); Add over an existing file is rejected (`file_exists`); Delete of a missing file
 * is `not_found`; any unexpected fs error maps to `io_error` (the handler never throws).
 */

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import type { CustomTool } from "@theokit/sdk";
import { Tool } from "@theokit/sdk";
import { z } from "zod";
import { anchorPath, resolveBaseDir } from "./internal/base-dir.js";
import {
  assertNoSymlinkEscape,
  ForbiddenPathError,
  isForbiddenPath,
  PathTraversalError,
  safePathJoin,
} from "./internal/path-guard.js";
import { applyUpdateChunks, parseV4A, type V4AHunk, V4APatchError } from "./internal/v4a-patch.js";

export interface CreateApplyPatchToolOptions {
  /** M76 — name exposed to the model. Omitted => today's literal (additive). The name is a contract:
   *  the approval key, what the model sees and what telemetry records. */
  name?: string;
  /** M76 — description exposed to the model. Omitted => today's literal (additive). */
  description?: string;
  /** Absolute path to the project root. Every hunk path is gated against this boundary. */
  projectRoot: string;
  /**
   * Base for relative paths in the model's input. Default: `projectRoot`.
   * Must be `projectRoot` or a directory inside it; anything else throws at construction.
   * `projectRoot` stays the boundary every resolved path is checked against.
   */
  baseDir?: string;
}

/**
 * Build the `apply_patch` tool over Codex's V4A patch grammar — one call that adds, updates, deletes
 * and moves several files at once.
 *
 * Prefer it to a run of {@link createEditFileTool} calls when a change spans files, because the whole
 * patch is planned before anything is written: every file read, every new content computed and every
 * path security-checked first, and any failure aborts with zero writes. A sequence of `edit_file`
 * calls has no such property — the third can fail with the first two already on disk. The price is
 * that it leaves no backup, where `edit_file` writes a `.bak`.
 *
 * Refusals: `parse_error`, `path_traversal`, `forbidden_path` (checked at every path segment here,
 * not just the first), `not_found`, `patch_failed` (context did not match), `duplicate_target` (two
 * hunks touching one file, which would silently lose the earlier edit), `file_exists` (Add over an
 * existing file) and `io_error` for anything the filesystem raises during the write phase.
 */
export function createApplyPatchTool(opts: CreateApplyPatchToolOptions): CustomTool {
  const { projectRoot } = opts;
  const baseDir = resolveBaseDir("createApplyPatchTool", projectRoot, opts.baseDir);

  return Tool.create({
    name: opts.name ?? "apply_patch",
    description:
      opts.description ??
      "Apply a Codex-style V4A patch. The patch is `*** Begin Patch` … `*** End Patch` wrapping one or " +
        "more hunks: `*** Add File: <path>` (then `+`lines), `*** Delete File: <path>`, or `*** Update " +
        "File: <path>` (optional `*** Move to: <path>`) with `@@`-anchored `+` (add) / `-` (remove) / ` ` " +
        "(context) lines. Read a file first so your context/removed lines match. Applied atomically — a " +
        "mismatch anywhere aborts the whole patch with zero writes; each path is security-checked. Returns " +
        "{ ok, files_patched } or { ok: false, error }.",
    inputSchema: z.object({
      patch: z.string().min(1).describe("V4A patch: *** Begin Patch … *** End Patch."),
    }),
    handler: async ({ patch }) => applyV4APatch(projectRoot, baseDir, patch),
  });
}

/** A single filesystem mutation in the apply plan. A `move` is expressed as a write + an rm. */
type FsOp = { write: { abs: string; content: string } } | { rm: string };

type PlanResult = { ops: FsOp[]; patched: string[] } | { error: string };

async function applyV4APatch(projectRoot: string, baseDir: string, patch: string): Promise<string> {
  let hunks: V4AHunk[];
  try {
    hunks = parseV4A(patch);
  } catch (err) {
    const detail = err instanceof V4APatchError ? err.message : String(err);
    return JSON.stringify({ ok: false, error: "parse_error", detail });
  }
  // Plan (verify) the WHOLE patch before any write; then execute. First failure ⇒ zero writes. An
  // unexpected fs error during execute maps to a typed `io_error` (honors the always-JSON contract).
  try {
    const plan = await buildPlan(projectRoot, baseDir, hunks);
    if ("error" in plan) return plan.error;
    await executePlan(plan.ops);
    return JSON.stringify({ ok: true, files_patched: plan.patched });
  } catch (err) {
    return JSON.stringify({
      ok: false,
      error: "io_error",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

/** The file paths a hunk mutates (a move touches both its source and destination). */
function hunkTargets(hunk: V4AHunk): string[] {
  if (hunk.kind === "update" && hunk.movePath) return [hunk.path, hunk.movePath];
  return [hunk.path];
}

/** Read + compute + path-check every hunk into a write plan (no writes). First failure aborts. A file
 *  touched by two hunks is rejected (Codex forbids editing the same file twice — otherwise the second
 *  read sees the original and the first edit is silently lost). */
async function buildPlan(
  projectRoot: string,
  baseDir: string,
  hunks: V4AHunk[],
): Promise<PlanResult> {
  const dup = firstDuplicateTarget(hunks);
  if (dup !== null) {
    return { error: JSON.stringify({ ok: false, error: "duplicate_target", path: dup }) };
  }
  const ops: FsOp[] = [];
  const patched: string[] = [];
  for (const hunk of hunks) {
    const planned = await planHunk(projectRoot, baseDir, hunk);
    if ("error" in planned) return planned;
    ops.push(...planned.ops);
    patched.push(hunk.kind === "update" ? (hunk.movePath ?? hunk.path) : hunk.path);
  }
  return { ops, patched };
}

/** The first path touched by two hunks (Codex forbids editing the same file twice), or null. */
function firstDuplicateTarget(hunks: V4AHunk[]): string | null {
  const seen = new Set<string>();
  for (const hunk of hunks) {
    for (const t of hunkTargets(hunk)) {
      if (seen.has(t)) return t;
      seen.add(t);
    }
  }
  return null;
}

/** Execute the write plan (all reads/computes/checks already passed). */
async function executePlan(ops: FsOp[]): Promise<void> {
  for (const op of ops) {
    if ("rm" in op) {
      await rm(op.rm, { force: true });
    } else {
      await mkdir(dirname(op.write.abs), { recursive: true });
      await writeFile(op.write.abs, op.write.content, "utf-8");
    }
  }
}

/** Does a path exist (any type)? */
async function pathExists(abs: string): Promise<boolean> {
  try {
    await stat(abs);
    return true;
  } catch {
    return false;
  }
}

/** Plan one hunk (Codex Hunk-kind dispatch) into filesystem ops, or an error JSON string. */
async function planHunk(
  projectRoot: string,
  baseDir: string,
  hunk: V4AHunk,
): Promise<{ ops: FsOp[] } | { error: string }> {
  const scope = v4aScope(projectRoot, baseDir, hunk.path);
  if ("error" in scope) return scope;
  if (hunk.kind === "add") {
    // Codex rejects Add over an existing file — never silently clobber.
    if (await pathExists(scope.abs)) {
      return { error: JSON.stringify({ ok: false, error: "file_exists", path: hunk.path }) };
    }
    return { ops: [{ write: { abs: scope.abs, content: hunk.content } }] };
  }
  if (hunk.kind === "delete") {
    if (!(await pathExists(scope.abs))) {
      return { error: JSON.stringify({ ok: false, error: "not_found", path: hunk.path }) };
    }
    return { ops: [{ rm: scope.abs }] };
  }
  return planUpdate(projectRoot, baseDir, hunk, scope.abs);
}

/** Plan an Update hunk: read the OLD file, compute the new content, then write-in-place or move. */
async function planUpdate(
  projectRoot: string,
  baseDir: string,
  hunk: Extract<V4AHunk, { kind: "update" }>,
  abs: string,
): Promise<{ ops: FsOp[] } | { error: string }> {
  let content: string;
  try {
    content = await readFile(abs, "utf-8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      return { error: JSON.stringify({ ok: false, error: "not_found", path: hunk.path }) };
    }
    throw err;
  }
  let updated: string;
  try {
    updated = applyUpdateChunks(content, hunk.path, hunk.chunks);
  } catch (err) {
    if (err instanceof V4APatchError) {
      return {
        error: JSON.stringify({
          ok: false,
          error: "patch_failed",
          path: hunk.path,
          detail: err.message,
        }),
      };
    }
    throw err;
  }
  if (!hunk.movePath) return { ops: [{ write: { abs, content: updated } }] };
  const dest = v4aScope(projectRoot, baseDir, hunk.movePath);
  if ("error" in dest) return dest;
  // transform-then-rename: write the new content to the destination, remove the original.
  return { ops: [{ write: { abs: dest.abs, content: updated } }, { rm: abs }] };
}

/** Sensitive path segments — secret-bearing dirs/files that must never be written at ANY depth. */
const FORBIDDEN_SEGMENTS = new Set([".env", ".git", "node_modules", ".theo"]);

/** Any-segment forbidden check on a PROJECT-RELATIVE path. `isForbiddenPath` only inspects the first
 *  segment (so a nested `sub/.git/hooks/…` or an absolute `<root>/.env` slips past); a writing tool must
 *  block a sensitive segment at any depth. */
function isForbiddenRel(rel: string): boolean {
  return rel
    .split(/[/\\]/)
    .filter(Boolean)
    .some((s) => s !== ".env.example" && (FORBIDDEN_SEGMENTS.has(s) || /^\.env\./.test(s)));
}

/** Security-check a hunk path against the project root; returns the resolved abs path or an error JSON
 *  string. Resolves FIRST (rejecting traversal/symlink/absolute escape), then checks the resulting
 *  project-relative path for a forbidden segment at any depth (closes the nested/absolute `.env` hole). */
function v4aScope(
  projectRoot: string,
  baseDir: string,
  file: string,
): { abs: string } | { error: string } {
  let abs: string;
  try {
    abs = safePathJoin(projectRoot, anchorPath(baseDir, file));
    assertNoSymlinkEscape(abs, projectRoot);
  } catch (err) {
    if (err instanceof PathTraversalError || err instanceof ForbiddenPathError) {
      return { error: JSON.stringify({ ok: false, error: "path_traversal", path: file }) };
    }
    throw err;
  }
  if (isForbiddenPath(file) || isForbiddenRel(relative(projectRoot, abs))) {
    return { error: JSON.stringify({ ok: false, error: "forbidden_path", path: file }) };
  }
  return { abs };
}
