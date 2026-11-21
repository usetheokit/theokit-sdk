/**
 * Parse, trust and install a workspace plugin (#1041).
 *
 * The SDK loads a workspace plugin only when its folder's realpath is in
 * `~/.theokit/plugins/trusted-workspace-plugins.json`. These functions are the supported way to
 * get a folder there: they reuse the loader's frontmatter rules and trust-record path, never
 * overwrite a record they cannot read, and write it atomically with mode 0600.
 */

import { randomBytes } from "node:crypto";
import { cp, lstat, mkdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import type { z } from "zod";

import { ConfigurationError, PluginManifestError, TrustRecordError } from "./errors.js";
import { atomicWriteJson } from "./internal/persistence/atomic-write.js";
import { withFileLock } from "./internal/persistence/file-lock.js";
import { splitFrontmatter } from "./internal/persistence/markdown-config-loader.js";
import { theokitConfigRoot } from "./internal/persistence/paths.js";
import { parseSimpleYaml } from "./internal/runtime/context/yaml-frontmatter.js";
import { PluginFrontmatterSchema } from "./internal/runtime/plugin-loader/plugin-frontmatter.js";
import {
  readWorkspaceTrustRecordStrict,
  workspaceTrustRecordPath,
} from "./internal/runtime/plugin-loader/workspace-plugin-trust.js";

/** What `PLUGIN.md` declares, with `version` defaulted to `0.0.0`. */
export interface PluginManifest {
  name: string;
  version: string;
  entry: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const OUTSIDE = "must stay inside the plugin folder";

function entryProblem(entry: string): string | undefined {
  if (entry.startsWith("/") || entry.startsWith("\\") || /^[a-zA-Z]:/.test(entry)) {
    return `Plugin manifest entry "${entry}" ${OUTSIDE} (it must be a relative path)`;
  }
  if (entry.split(/[\\/]/).includes("..")) {
    return `Plugin manifest entry "${entry}" ${OUTSIDE} (no ".." segments)`;
  }
  return undefined;
}

function readFrontmatter(text: string): z.infer<typeof PluginFrontmatterSchema> {
  let fields: Record<string, unknown>;
  try {
    fields = parseSimpleYaml(splitFrontmatter(text, "PLUGIN.md", "plugin").frontmatter);
  } catch (err) {
    throw new PluginManifestError(
      `Invalid PLUGIN.md: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  const parsed = PluginFrontmatterSchema.safeParse(fields);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join(".") || "frontmatter";
    throw new PluginManifestError(`Invalid PLUGIN.md: ${where}: ${issue?.message ?? "invalid"}`);
  }
  return parsed.data;
}

/**
 * Parse the YAML frontmatter of a `PLUGIN.md`, with the SDK's own frontmatter schema.
 * Requires `name` (`^[a-z0-9][a-z0-9-]{0,63}$`) and a relative `entry` that stays inside the plugin
 * folder; `version` defaults to `0.0.0`.
 *
 * @throws PluginManifestError naming the first problem.
 */
export function parsePluginManifest(text: string): PluginManifest {
  const { name, version, entry } = readFrontmatter(text);
  if (name === undefined || !NAME_RE.test(name)) {
    throw new PluginManifestError(
      `Plugin manifest name ${JSON.stringify(name)} must match ${NAME_RE.source}`,
    );
  }
  if (entry === undefined) throw new PluginManifestError("Plugin manifest is missing `entry`");
  const problem = entryProblem(entry);
  if (problem !== undefined) throw new PluginManifestError(problem);
  return { name, version: version ?? "0.0.0", entry };
}

function invalidRecord(path: string, reason: string, cause?: unknown): never {
  throw new TrustRecordError(path, reason, { cause });
}

async function realpathOrResolve(folder: string): Promise<string> {
  try {
    return await realpath(folder);
  } catch {
    return resolve(folder);
  }
}

async function updateTrustRecord(
  change: (entries: string[]) => string[] | undefined,
): Promise<boolean> {
  const path = workspaceTrustRecordPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  return withFileLock(path, async () => {
    const next = change(readWorkspaceTrustRecordStrict(invalidRecord));
    if (next === undefined) return false;
    await atomicWriteJson(path, next, { mode: 0o600 });
    return true;
  });
}

/**
 * Add the folder's realpath to the workspace trust record. Idempotent; atomic write, mode 0600.
 *
 * @throws TrustRecordError when the record exists but cannot be parsed. It is never overwritten.
 */
export async function trustWorkspacePlugin(folder: string): Promise<void> {
  const real = await realpath(folder);
  await updateTrustRecord((entries) => (entries.includes(real) ? undefined : [...entries, real]));
}

/** Remove a folder from the trust record. Resolves `true` when an entry was removed. */
export async function untrustWorkspacePlugin(folder: string): Promise<boolean> {
  const targets = new Set([await realpathOrResolve(folder), resolve(folder)]);
  return updateTrustRecord((entries) => {
    const kept = entries.filter((e) => !targets.has(e));
    return kept.length === entries.length ? undefined : kept;
  });
}

/** The entry's realpath must be a regular file inside `root` (a realpath). */
async function checkEntry(root: string, entry: string): Promise<void> {
  let real: string;
  try {
    real = await realpath(join(root, entry));
  } catch {
    throw new PluginManifestError(`Plugin entry "${entry}" does not exist`);
  }
  if (real !== root && !real.startsWith(root.endsWith(sep) ? root : root + sep)) {
    throw new PluginManifestError(`Plugin entry "${entry}" ${OUTSIDE}`);
  }
  if (!(await stat(real)).isFile()) {
    throw new PluginManifestError(`Plugin entry "${entry}" is not a file`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** Put `stage` at `dest`; with an existing `dest`, set it aside first and restore it on failure. */
async function swapIn(stage: string, dest: string, suffix: string): Promise<void> {
  if (!(await exists(dest))) {
    await rename(stage, dest);
    return;
  }
  const backup = `${dest}.old-${suffix}`;
  await rename(dest, backup);
  try {
    await rename(stage, dest);
  } catch (err) {
    await rename(backup, dest);
    throw err;
  }
  await rm(backup, { recursive: true, force: true });
}

/**
 * Validate a plugin folder (`PLUGIN.md` and its entry), copy it to
 * `<workspace>/.theokit/plugins/<name>/`, then trust the copy.
 *
 * An existing destination is refused unless `replace` is set; with `replace` the copy is staged in
 * a temporary sibling and renamed over the old plugin, so a failed copy leaves the old one in place.
 *
 * @throws PluginManifestError for a bad manifest or an entry that is missing, not a file, or outside
 * the folder.
 */
export async function installWorkspacePlugin(input: {
  source: string;
  workspace: string;
  replace?: boolean;
}): Promise<PluginManifest> {
  const root = await realpath(input.source);
  const manifest = parsePluginManifest(await readFile(join(root, "PLUGIN.md"), "utf-8"));
  await checkEntry(root, manifest.entry);

  const pluginsDir = join(theokitConfigRoot(resolve(input.workspace)), "plugins");
  const dest = join(pluginsDir, manifest.name);
  if ((await exists(dest)) && input.replace !== true) {
    throw new ConfigurationError(
      `Plugin destination ${dest} already exists; pass replace: true to overwrite it.`,
      { code: "plugin_destination_exists" },
    );
  }
  const suffix = randomBytes(6).toString("hex");
  const stage = join(pluginsDir, `.${manifest.name}.tmp-${suffix}`);
  await mkdir(pluginsDir, { recursive: true });
  try {
    await cp(root, stage, { recursive: true });
    await checkEntry(await realpath(stage), manifest.entry);
    await swapIn(stage, dest, suffix);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  await trustWorkspacePlugin(dest);
  return manifest;
}
