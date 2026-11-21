/**
 * Shared loader for `.theokit/<dir>/<name>.md` (or `.theokit/<dir>/<name>/PLUGIN.md`)
 * config files. Mirrors the SKILL.md pattern: YAML frontmatter delimited by
 * `---` blocks + optional markdown body for prose / rationale.
 *
 * Consumed by hooks-loader (T1.2), context-manager (T2.2), and
 * plugins-manager (T3.2) — DRY across all 3 user-edited config surfaces.
 *
 * ADRs: D74 (markdown format), D75 (1 file = 1 entity), D76 (Zod schema).
 *
 * @internal
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

// T5.10 — 1 MB cap on individual markdown config files. A crafted
// multi-MB file would be read into memory in full — a local DoS
// vector on resource-constrained environments (edge, CI workers).
const MAX_MD_FILE_BYTES = 1_048_576; // 1 MB

import type { z } from "zod";

import { ConfigurationError } from "../../errors.js";
import { parseSimpleYaml } from "../runtime/context/yaml-frontmatter.js";

export interface MarkdownEntity<T> {
  /** Slug from filename (without `.md`) for flat pattern, or subdir name for nested. */
  slug: string;
  /** Validated frontmatter. */
  frontmatter: T;
  /** Markdown body (everything after the closing `---`). May be empty. */
  body: string;
  /** Absolute source path for audit / error context. */
  source: string;
}

export interface LoadOptions<T> {
  /** Absolute path to the directory containing `*.md` files (flat) or
   *  subdirs with `PLUGIN.md` (nested). */
  dir: string;
  /** Zod schema validating the frontmatter shape. */
  schema: z.ZodType<T>;
  /** `"flat"` = top-level `<slug>.md` files; `"nested"` = subdirs each with
   *  `PLUGIN.md`. Default: `"flat"`. */
  pattern?: "flat" | "nested";
  /** Error code prefix (e.g., `"hook"` → `"hook_frontmatter_invalid"`). */
  errorCodePrefix: string;
}

/**
 * Load all markdown config entities from a directory, validating each
 * file's frontmatter against the provided Zod schema.
 *
 * Edge cases handled:
 * - **ENOENT on dir** → returns `[]` graciously.
 * - **EACCES on dir** → throws `<prefix>_dir_read_error` (EC-11 distinct).
 * - **Missing frontmatter `---` block** → throws `<prefix>_missing_frontmatter`.
 * - **Frontmatter delimited by `+++`** (Hugo/TOML) → throws `<prefix>_missing_frontmatter`.
 * - **Truncated frontmatter (no closing `---`)** → throws `<prefix>_missing_frontmatter`.
 * - **Body containing `---` horizontal rule** → NOT confused with frontmatter
 *   end; only the first `---...---` block at file head is the frontmatter.
 * - **Zod schema validation failure** → throws `<prefix>_frontmatter_invalid`
 *   with Zod error path embedded in the message.
 *
 * Note on cross-platform: filenames are case-sensitive in Linux, case-insensitive
 * in macOS/Windows. Use lowercase slug convention to avoid collisions.
 * T5.10: individual files capped at 1 MB to prevent local DoS on edge/CI.
 *
 * @internal
 */
export async function loadMarkdownEntities<T>(opts: LoadOptions<T>): Promise<MarkdownEntity<T>[]> {
  const { dir, schema, pattern = "flat", errorCodePrefix } = opts;
  const entries = await readDirSafe(dir, errorCodePrefix);
  if (entries === null) return [];

  const out: MarkdownEntity<T>[] = [];
  for (const entry of entries) {
    const resolved = resolveEntryPath(entry, pattern, dir);
    if (resolved === null) continue;
    // T5.10 — reject files > 1 MB before reading into memory.
    await assertFileSizeUnderCap(resolved.source, errorCodePrefix);
    const raw = await readFile(resolved.source, "utf8").catch(() => null);
    if (raw === null) continue;
    const split = splitFrontmatter(raw, resolved.source, errorCodePrefix);
    const fields = parseSimpleYaml(split.frontmatter);
    const parsed = schema.safeParse(fields);
    if (!parsed.success) {
      throw new ConfigurationError(
        `Invalid frontmatter in ${resolved.source}: ${parsed.error.message}`,
        { code: `${errorCodePrefix}_frontmatter_invalid` },
      );
    }
    out.push({
      slug: resolved.slug,
      frontmatter: parsed.data,
      body: split.body.trim(),
      source: resolved.source,
    });
  }
  return out;
}

/** T5.10 — reject files > 1 MB before reading into memory. */
async function assertFileSizeUnderCap(source: string, errorCodePrefix: string): Promise<void> {
  try {
    const info = await stat(source);
    if (info.size > MAX_MD_FILE_BYTES) {
      throw new ConfigurationError(
        `Config file ${source} exceeds 1 MB size limit (${info.size} bytes). ` +
          "Reduce the file or split into multiple entities.",
        { code: `${errorCodePrefix}_file_too_large` },
      );
    }
  } catch (cause) {
    if (cause instanceof ConfigurationError) throw cause;
    // stat failed — file unreadable; let readFile handle the ENOENT/EACCES
  }
}

async function readDirSafe(
  dir: string,
  errorCodePrefix: string,
): Promise<import("node:fs").Dirent[] | null> {
  try {
    return (await readdir(dir, { withFileTypes: true })) as import("node:fs").Dirent[];
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw new ConfigurationError(`Failed to read ${dir}`, {
      code: `${errorCodePrefix}_dir_read_error`,
      cause,
    });
  }
}

function resolveEntryPath(
  entry: { name: string; isFile(): boolean; isDirectory(): boolean },
  pattern: "flat" | "nested",
  dir: string,
): { slug: string; source: string } | null {
  if (pattern === "flat") {
    if (!entry.isFile() || !entry.name.endsWith(".md")) return null;
    return { slug: entry.name.slice(0, -3), source: join(dir, entry.name) };
  }
  if (!entry.isDirectory()) return null;
  return { slug: entry.name, source: join(dir, entry.name, "PLUGIN.md") };
}

/**
 * Split a markdown file into frontmatter (between two `---` lines at the top)
 * and body. Rejects `+++` (Hugo/TOML), truncated frontmatter, and missing
 * frontmatter with typed `ConfigurationError`.
 *
 * @internal
 */
function splitFrontmatter(
  raw: string,
  source: string,
  errorCodePrefix: string,
): { frontmatter: string; body: string } {
  // Strict: file MUST start with `---\n`, then frontmatter content, then `---\n`.
  // The body is whatever follows the closing `---`. Other `---` lines in body
  // (horizontal rules) are NOT confused with the frontmatter delim because
  // the regex anchors `^---\s*\n` at the start of the file.
  const match = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/.exec(raw);
  if (match === null) {
    throw new ConfigurationError(
      `Missing or malformed frontmatter in ${source} (expected \`---\` delimited block at file head)`,
      { code: `${errorCodePrefix}_missing_frontmatter` },
    );
  }
  return {
    frontmatter: match[1] ?? "",
    body: raw.slice(match[0].length),
  };
}
