/**
 * `edit_file` — built-in tool for coding agents.
 *
 * Replaces a string in a project-relative file. Tries exact match first,
 * then whitespace-normalized match. Creates a `.bak` backup before editing.
 *
 * Return shape (always a JSON string):
 *   - `{ ok: true, replacements: 1 }` on success
 *   - `{ ok: false, error: 'no_change' | 'no_match' | 'not_found' | 'path_traversal' |
 *        'forbidden_path' }` on refusal
 */

import { constants as fsConstants } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import type { CustomTool } from "@theokit/sdk";

import { Tool } from "@theokit/sdk";
import {
  FileNotFoundError,
  type FilesystemProvider,
  resolveFilesystem,
} from "@theokit/sdk/filesystem";
import { z } from "zod";
import { anchorPath, resolveBaseDir } from "./internal/base-dir.js";
import { ContextMatchError, replaceUnique } from "./internal/context-match.js";
import {
  assertNoSymlinkEscape,
  ForbiddenPathError,
  isForbiddenPath,
  PathTraversalError,
  safePathJoin,
} from "./internal/path-guard.js";

export interface CreateEditFileToolOptions {
  /**
   * M76 — the name exposed to the model. Omitted ⇒ today's literal (additive).
   *
   * It exists because, in Codex, the name is BORN in the tool definition and is the approval decision
   * key — three consumers (model, approval, telemetry) of a string decided in one place. Renaming
   * after construction changes the identity of something already published to the model. `withName`
   * remains for the genuinely dynamic case.
   */
  name?: string;
  /** M76 — description exposed to the model. Omitted => today's literal (additive). */
  description?: string;
  /** Absolute path to the project root. Every edit is gated against this boundary. */
  projectRoot: string;
  /**
   * Base for relative paths in the model's input. Default: `projectRoot`.
   * Must be `projectRoot` or a directory inside it; anything else throws at construction.
   * `projectRoot` stays the boundary every resolved path is checked against.
   */
  baseDir?: string;
  /** Optional injected filesystem (`@theokit/sdk/filesystem`) — when provided, the read + `.bak` backup +
   *  write go through the backend (surface-agnostic); omitted ⇒ the local `fs` path (byte-identical). */
  filesystem?: FilesystemProvider;
}

type EditOutcome = { ok: true; result: string } | { ok: false; error: "no_match" };

/** Pure string-replacement core shared by the local and backend paths (no I/O): exact → whitespace-
 *  normalized → context-tolerant ladder. Extracting it keeps the matching algorithm single-sourced (DRY)
 *  while both fs paths do their own read/backup/write. */
function computeEdit(content: string, old_string: string, new_string: string): EditOutcome {
  const exactIdx = content.indexOf(old_string);
  if (exactIdx !== -1) {
    return {
      ok: true,
      result: content.slice(0, exactIdx) + new_string + content.slice(exactIdx + old_string.length),
    };
  }
  const normalizedContent = normalizeWhitespace(content);
  const normalizedOld = normalizeWhitespace(old_string);
  const normalizedIdx = normalizedContent.indexOf(normalizedOld);
  if (normalizedIdx !== -1) {
    const span = findOriginalSpan(content, normalizedContent, normalizedIdx, normalizedOld.length);
    return {
      ok: true,
      result: content.slice(0, span.start) + new_string + content.slice(span.end),
    };
  }
  try {
    return { ok: true, result: replaceUnique(content, old_string, new_string) };
  } catch (err) {
    if (err instanceof ContextMatchError) return { ok: false, error: "no_match" };
    throw err;
  }
}

/** Apply an edit through an injected FilesystemBackend (project-relative path space, like read_file):
 *  read → write a `.bak` backup → write the result. The path-scope guards run in the caller. */
async function editViaBackend(
  filesystem: FilesystemProvider,
  ctx: unknown,
  path: string,
  old_string: string,
  new_string: string,
): Promise<string> {
  const backend = await resolveFilesystem(filesystem, ctx ?? {});
  let content: string;
  try {
    content = await backend.readFile(path);
  } catch (err) {
    // Mirror the local path: only a missing file maps to `not_found`; every other read failure
    // (a directory, a permission error, a security rejection) propagates — fail-loud, never swallowed.
    if (err instanceof FileNotFoundError) {
      return JSON.stringify({ ok: false, error: "not_found", path });
    }
    throw err;
  }
  const outcome = computeEdit(content, old_string, new_string);
  if (!outcome.ok) return JSON.stringify({ ok: false, error: "no_match", path });
  await backend.writeFile(`${path}.bak`, content);
  await backend.writeFile(path, outcome.result);
  return JSON.stringify({ ok: true, replacements: 1 });
}

/** Apply an edit through the local `fs` (byte-identical to before): read → computeEdit → `.bak` → write. */
async function editViaLocal(
  projectRoot: string,
  baseDir: string,
  path: string,
  old_string: string,
  new_string: string,
): Promise<string> {
  const absolutePath = safePathJoin(projectRoot, anchorPath(baseDir, path));
  let content: string;
  try {
    content = await readFile(absolutePath, "utf-8");
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === "ENOENT") {
      return JSON.stringify({ ok: false, error: "not_found", path });
    }
    throw err;
  }
  const outcome = computeEdit(content, old_string, new_string);
  if (!outcome.ok) return JSON.stringify({ ok: false, error: "no_match", path });
  // The backup path is predictable, and the project-root guard above validated `path` — not
  // `<path>.bak`. Planting a symlink there made `copyFile` follow it and write outside the root:
  // an arbitrary write from a tool the caller only authorised to edit one file (CodeQL
  // js/insecure-temporary-file #32; the regression test reproduces it).
  //
  // O_NOFOLLOW is the stdlib answer — the kernel refuses to open a symlink at all, so no check
  // can go stale between the test and the write. An existing REGULAR .bak is still overwritten,
  // which keeps the documented behaviour intact.
  try {
    await writeFile(`${absolutePath}.bak`, content, {
      encoding: "utf-8",
      flag:
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    // ELOOP is the kernel refusing a symlink; EEXIST covers platforms that report it that way.
    // Fail the whole edit rather than proceeding without a backup: the caller asked for an edit
    // that keeps one, and a silent downgrade is what `error-handling.md` § 5 forbids.
    if (code === "ELOOP" || code === "EEXIST") {
      return JSON.stringify({ ok: false, error: "unsafe_backup_path", path });
    }
    throw err;
  }
  await writeFile(absolutePath, outcome.result, "utf-8");
  return JSON.stringify({ ok: true, replacements: 1 });
}

/** Shared path-scope guard for both fs paths — returns an error JSON string, or null when the path is safe. */
function editScopeError(path: string, projectRoot: string, baseDir: string): string | null {
  if (isForbiddenPath(path) || isForbiddenPath(anchorPath(baseDir, path))) {
    return JSON.stringify({ ok: false, error: "forbidden_path", path });
  }
  try {
    assertNoSymlinkEscape(safePathJoin(projectRoot, anchorPath(baseDir, path)), projectRoot);
    return null;
  } catch (err) {
    if (err instanceof PathTraversalError || err instanceof ForbiddenPathError) {
      return JSON.stringify({ ok: false, error: "path_traversal", path });
    }
    throw err;
  }
}

/**
 * Build the `edit_file` tool: replace one occurrence of `old_string` with `new_string` in place,
 * after copying the previous content to `<path>.bak`.
 *
 * Three matching attempts run in order and the first hit wins — the exact substring, then the same
 * text with runs of whitespace collapsed, then a line-based ladder tolerating trailing whitespace and
 * typographic punctuation. The FIRST exact occurrence is taken with no ambiguity check, so a short
 * `old_string` appearing twice edits the earlier one silently: include enough surrounding context to
 * make it unique. Only the ladder refuses an ambiguous target, and it is reached only when the exact
 * and whitespace-normalised passes have both failed.
 *
 * `old_string === new_string` is refused up front as `no_change`; the other refusals are `no_match`,
 * `not_found`, `forbidden_path` and `path_traversal`. Exactly one occurrence changes per call, so
 * replacing every occurrence means calling until `no_match`.
 */
export function createEditFileTool(opts: CreateEditFileToolOptions): CustomTool {
  const { projectRoot, filesystem } = opts;
  const baseDir = resolveBaseDir("createEditFileTool", projectRoot, opts.baseDir);

  return Tool.create({
    name: opts.name ?? "edit_file",
    description:
      opts.description ??
      "Make an exact string replacement in a project-relative file. Replaces the FIRST occurrence " +
        "of old_string with new_string (a whitespace-normalized fallback is attempted if the exact " +
        "match fails) and writes a .bak backup first. Read the file first so old_string matches the " +
        "on-disk text exactly; include enough surrounding context to make it unique — only the first " +
        "match is replaced, so a too-short old_string can edit the wrong location. old_string must be " +
        "non-empty and differ from new_string; to change every occurrence, call edit_file repeatedly. " +
        "Returns { ok, replacements } or { ok: false, error }.",
    inputSchema: z.object({
      path: z.string().min(1).describe("Project-relative file path."),
      old_string: z.string().min(1).describe("String to find in the file."),
      new_string: z.string().describe("Replacement string."),
    }),
    handler: async ({ path, old_string, new_string }, ctx) => {
      // A no-op edit (old === new) cannot change the file; refuse early so the description's
      // "old_string must differ from new_string" precondition is enforced, not just documented.
      if (old_string === new_string) {
        return JSON.stringify({ ok: false, error: "no_change", path });
      }

      // Path-scope guard (pure security) applies to both fs paths.
      const scopeErr = editScopeError(path, projectRoot, baseDir);
      if (scopeErr !== null) return scopeErr;

      // Injected filesystem (surface-agnostic) ⇒ read/backup/write via the backend; absent ⇒ local `fs`.
      return filesystem !== undefined
        ? editViaBackend(filesystem, ctx, path, old_string, new_string)
        : editViaLocal(projectRoot, baseDir, path, old_string, new_string);
    },
  });
}

/** Collapse runs of whitespace into a single space. */
function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Map a position range in the whitespace-normalized string back to the
 * original string. Walks both strings in lockstep.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: parser logic
function findOriginalSpan(
  original: string,
  _normalized: string,
  normStart: number,
  normLen: number,
): { start: number; end: number } {
  let origIdx = 0;
  let normIdx = 0;

  // Skip leading whitespace that was trimmed
  while (origIdx < original.length && /\s/.test(original[origIdx]!)) {
    origIdx++;
  }

  // Walk to normStart
  while (normIdx < normStart && origIdx < original.length) {
    if (/\s/.test(original[origIdx]!)) {
      // skip entire whitespace run in original, counts as one in normalized
      while (origIdx < original.length && /\s/.test(original[origIdx]!)) {
        origIdx++;
      }
      normIdx++; // the collapsed space
    } else {
      origIdx++;
      normIdx++;
    }
  }

  const start = origIdx;

  // Walk normLen characters
  let walked = 0;
  while (walked < normLen && origIdx < original.length) {
    if (/\s/.test(original[origIdx]!)) {
      while (origIdx < original.length && /\s/.test(original[origIdx]!)) {
        origIdx++;
      }
      walked++; // the collapsed space
    } else {
      origIdx++;
      walked++;
    }
  }

  return { start, end: origIdx };
}
