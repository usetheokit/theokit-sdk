/**
 * Public helpers to parse, trust and install a workspace plugin (#1041).
 *
 * The loader imports a workspace plugin only when its folder's realpath is in
 * `~/.theokit/plugins/trusted-workspace-plugins.json`. These functions are the supported way to get
 * a folder into that record without writing the SDK's internal format by hand.
 */

import { randomBytes } from "node:crypto";
import { cp, lstat, mkdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { PluginManifestError } from "./errors.js";
import { atomicWriteJson } from "./internal/persistence/atomic-write.js";
import { withFileLock } from "./internal/persistence/file-lock.js";
import { parseSimpleYaml, splitFrontmatter } from "./internal/runtime/context/context-yaml-lite.js";
import { parsePluginFrontmatter } from "./internal/runtime/plugin-loader/plugin-frontmatter.js";
import {
  readWorkspaceTrustRecordStrict,
  workspaceTrustRecordPath,
} from "./internal/runtime/plugin-loader/workspace-plugin-trust.js";

/** A validated `PLUGIN.md` manifest. */
export interface PluginManifest {
  name: string;
  version: string;
  /** Relative path of the plugin's entry file inside its folder. */
  entry: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MANIFEST_FILE = "PLUGIN.md";

function entryProblem(entry: string): string | undefined {
  if (entry.startsWith("/") || entry.startsWith("\\") || /^[A-Za-z]:/.test(entry)) {
    return `plugin entry "${entry}" must be relative and stay inside the plugin folder`;
  }
  if (entry.split(/[\\/]/).includes("..")) {
    return `plugin entry "${entry}" must stay inside the plugin folder (no ".." segments)`;
  }
  return undefined;
}

/**
 * Parse the YAML frontmatter of a `PLUGIN.md` with the SDK's own frontmatter schema.
 *
 * @throws PluginManifestError naming the first problem.
 */
export function parsePluginManifest(text: string): PluginManifest {
  const fm = parseFrontmatterFields(text);
  if (fm.name === undefined || !NAME_RE.test(fm.name)) {
    throw new PluginManifestError(
      `plugin name ${JSON.stringify(fm.name)} must match ${NAME_RE.source}`,
    );
  }
  if (fm.entry === undefined) throw new PluginManifestError("plugin manifest requires an entry");
  const problem = entryProblem(fm.entry);
  if (problem !== undefined) throw new PluginManifestError(problem);
  return { name: fm.name, version: fm.version ?? "0.0.0", entry: fm.entry };
}

function parseFrontmatterFields(text: string): ReturnType<typeof parsePluginFrontmatter> {
  const { yaml } = splitFrontmatter(text);
  if (yaml === undefined) throw new PluginManifestError("PLUGIN.md has no frontmatter");
  try {
    return parsePluginFrontmatter(parseSimpleYaml(yaml), "PLUGIN.md");
  } catch (cause) {
    throw new PluginManifestError(
      `PLUGIN.md frontmatter is invalid: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

async function mutateTrustRecord(
  mutate: (entries: string[]) => string[] | undefined,
): Promise<boolean> {
  const path = workspaceTrustRecordPath();
  await mkdir(dirname(path), { recursive: true });
  return withFileLock(path, async () => {
    const next = mutate(readWorkspaceTrustRecordStrict(path));
    if (next === undefined) return false;
    await atomicWriteJson(path, next, { mode: 0o600 });
    return true;
  });
}

/** Add the folder's realpath to the workspace trust record. Idempotent; the write is atomic. */
export async function trustWorkspacePlugin(folder: string): Promise<void> {
  const real = await realpath(resolve(folder));
  await mutateTrustRecord((entries) => (entries.includes(real) ? undefined : [...entries, real]));
}

/** Remove the folder from the trust record. Resolves `true` when an entry was removed. */
export async function untrustWorkspacePlugin(folder: string): Promise<boolean> {
  const resolved = resolve(folder);
  const real = await realpath(resolved).catch(() => resolved);
  return mutateTrustRecord((entries) => {
    const kept = entries.filter((e) => e !== real && e !== resolved);
    return kept.length === entries.length ? undefined : kept;
  });
}

/** The entry must be a regular file whose realpath is inside `folder`'s realpath. */
async function assertEntryInside(folder: string, entry: string): Promise<void> {
  const root = await realpath(folder);
  let real: string;
  try {
    real = await realpath(join(folder, entry));
  } catch (cause) {
    throw new PluginManifestError(`plugin entry "${entry}" does not exist in ${folder}`, { cause });
  }
  const rel = relative(root, real);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new PluginManifestError(`plugin entry "${entry}" must stay inside the plugin folder`);
  }
  if (!(await stat(real)).isFile()) {
    throw new PluginManifestError(`plugin entry "${entry}" is not a regular file`);
  }
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

/**
 * Validate `source`, copy it to `<workspace>/.theokit/plugins/<name>/`, then trust the copy.
 * An existing destination is refused unless `replace` is set; a replace copies to a temporary
 * sibling first, so a failed copy leaves the old plugin in place.
 */
export async function installWorkspacePlugin(input: {
  source: string;
  workspace: string;
  replace?: boolean;
}): Promise<PluginManifest> {
  const source = resolve(input.source);
  const manifest = parsePluginManifest(await readFile(join(source, MANIFEST_FILE), "utf-8"));
  await assertEntryInside(source, manifest.entry);

  const pluginsDir = join(resolve(input.workspace), ".theokit", "plugins");
  const dest = join(pluginsDir, manifest.name);
  const replacing = await exists(dest);
  if (replacing && input.replace !== true) {
    throw new PluginManifestError(
      `plugin "${manifest.name}" is already installed at ${dest}; pass replace: true to replace it`,
    );
  }
  await mkdir(pluginsDir, { recursive: true });

  const tag = randomBytes(6).toString("hex");
  const staged = join(pluginsDir, `.${manifest.name}.new-${tag}`);
  const backup = join(pluginsDir, `.${manifest.name}.old-${tag}`);
  try {
    await cp(source, staged, { recursive: true });
    await assertEntryInside(staged, manifest.entry);
    if (replacing) await rename(dest, backup);
    try {
      await rename(staged, dest);
      await trustWorkspacePlugin(dest);
    } catch (err) {
      await rm(dest, { recursive: true, force: true });
      if (replacing) await rename(backup, dest);
      throw err;
    }
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
  await rm(backup, { recursive: true, force: true });
  return manifest;
}
