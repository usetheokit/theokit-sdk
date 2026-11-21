/**
 * Public helpers to parse a workspace plugin manifest, trust a plugin folder and install a plugin
 * into a workspace. The SDK loads a `.theokit/plugins/<name>/` folder only when its realpath is in
 * `~/.theokit/plugins/trusted-workspace-plugins.json`; these functions are the supported way to
 * write that record.
 *
 * Trust updates are a read-modify-write of one file: the write is atomic, but two concurrent
 * updates in different processes can lose one entry.
 */

import { randomBytes } from "node:crypto";
import { cp, mkdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { ConfigurationError, PluginManifestError } from "./errors.js";
import { atomicWriteJson } from "./internal/persistence/atomic-write.js";
import { splitFrontmatter } from "./internal/persistence/markdown-config-loader.js";
import { parseSimpleYaml } from "./internal/runtime/context/yaml-frontmatter.js";
import { PluginFrontmatterSchema } from "./internal/runtime/plugin-loader/plugin-frontmatter.js";
import {
  readWorkspaceTrustRecordStrict,
  workspaceTrustRecordPath,
} from "./internal/runtime/plugin-loader/workspace-plugin-trust.js";

export interface PluginManifest {
  name: string;
  version: string;
  entry: string;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ENTRY_OUTSIDE = "plugin manifest entry must stay inside the plugin folder";

function entryProblem(entry: string): string | undefined {
  if (entry.startsWith("/") || entry.startsWith("\\") || /^[A-Za-z]:/.test(entry)) {
    return `${ENTRY_OUTSIDE}: "${entry}" is absolute`;
  }
  if (entry.split(/[\\/]/).includes("..")) {
    return `${ENTRY_OUTSIDE}: "${entry}" contains ".."`;
  }
  return undefined;
}

/**
 * Parse the YAML frontmatter of a `PLUGIN.md` with the SDK's own plugin schema.
 * `name` and `entry` are required; `version` defaults to `0.0.0`.
 *
 * @throws PluginManifestError naming the first problem.
 */
export function parsePluginManifest(text: string): PluginManifest {
  let fields: Record<string, unknown>;
  try {
    fields = parseSimpleYaml(splitFrontmatter(text, "PLUGIN.md", "plugin").frontmatter);
  } catch (cause) {
    throw new PluginManifestError("PLUGIN.md has no valid `---` delimited frontmatter", { cause });
  }
  const parsed = PluginFrontmatterSchema.safeParse(fields);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join(".") || "frontmatter";
    throw new PluginManifestError(`Invalid plugin manifest: ${where}: ${issue?.message}`);
  }
  const { name, version, entry } = parsed.data;
  if (name === undefined || !NAME_PATTERN.test(name)) {
    throw new PluginManifestError(
      `Invalid plugin manifest: name must match ${NAME_PATTERN} (got ${JSON.stringify(name)})`,
    );
  }
  if (entry === undefined) {
    throw new PluginManifestError("Invalid plugin manifest: entry is required");
  }
  const problem = entryProblem(entry);
  if (problem !== undefined) throw new PluginManifestError(`Invalid plugin manifest: ${problem}`);
  return { name, version: version ?? "0.0.0", entry };
}

async function canonical(folder: string): Promise<string> {
  try {
    return await realpath(folder);
  } catch {
    return resolve(folder);
  }
}

async function writeTrustRecord(entries: unknown[]): Promise<void> {
  await atomicWriteJson(workspaceTrustRecordPath(), entries, { mode: 0o600, dirMode: 0o700 });
}

/**
 * Add the folder's realpath to the workspace trust record. Idempotent; the write is atomic with
 * mode 0600.
 *
 * @throws TrustRecordError when the record exists but cannot be parsed; it is left untouched.
 */
export async function trustWorkspacePlugin(folder: string): Promise<void> {
  const real = await realpath(folder);
  const entries = readWorkspaceTrustRecordStrict();
  if (entries.includes(real)) return;
  await writeTrustRecord([...entries, real]);
}

/**
 * Remove the folder's realpath from the trust record.
 *
 * @returns whether an entry was removed.
 * @throws TrustRecordError when the record exists but cannot be parsed.
 */
export async function untrustWorkspacePlugin(folder: string): Promise<boolean> {
  const real = await canonical(folder);
  const entries = readWorkspaceTrustRecordStrict();
  const kept = entries.filter((entry) => entry !== real);
  if (kept.length === entries.length) return false;
  await writeTrustRecord(kept);
  return true;
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Refuse an entry that is missing, not a regular file, or resolves outside `root`. */
async function assertEntryInside(root: string, entry: string): Promise<void> {
  let real: string;
  try {
    real = await realpath(join(root, entry));
  } catch (cause) {
    throw new PluginManifestError(`Plugin entry "${entry}" does not exist`, { cause });
  }
  if (!isInside(await realpath(root), real)) {
    throw new PluginManifestError(`${ENTRY_OUTSIDE}: "${entry}" resolves outside it`);
  }
  if (!(await stat(real)).isFile()) {
    throw new PluginManifestError(`Plugin entry "${entry}" is not a regular file`);
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** Move the staged copy into place; with an old copy, keep it aside until the rename succeeds. */
async function swapIn(staged: string, dest: string, hadOld: boolean): Promise<void> {
  if (!hadOld) {
    await rename(staged, dest);
    return;
  }
  const backup = `${dest}.old-${randomBytes(4).toString("hex")}`;
  await rename(dest, backup);
  try {
    await rename(staged, dest);
  } catch (cause) {
    await rename(backup, dest);
    throw cause;
  }
  await rm(backup, { recursive: true, force: true });
}

/**
 * Validate the plugin in `source`, copy it to `<workspace>/.theokit/plugins/<name>/` and trust the
 * copy. An existing destination is refused unless `replace` is true; a replacement is copied to a
 * temporary sibling first, so a failed copy leaves the old plugin in place.
 */
export async function installWorkspacePlugin(input: {
  source: string;
  workspace: string;
  replace?: boolean;
}): Promise<PluginManifest> {
  const manifest = parsePluginManifest(await readFile(join(input.source, "PLUGIN.md"), "utf8"));
  await assertEntryInside(input.source, manifest.entry);
  const pluginsDir = join(input.workspace, ".theokit", "plugins");
  const dest = join(pluginsDir, manifest.name);
  const hadOld = await exists(dest);
  if (hadOld && input.replace !== true) {
    throw new ConfigurationError(
      `Plugin "${manifest.name}" is already installed at ${dest}; pass replace: true to replace it`,
      { code: "plugin_already_installed" },
    );
  }
  readWorkspaceTrustRecordStrict();
  await mkdir(pluginsDir, { recursive: true });
  const staged = join(pluginsDir, `.${manifest.name}.tmp-${randomBytes(4).toString("hex")}`);
  try {
    await cp(input.source, staged, { recursive: true, verbatimSymlinks: true });
    await assertEntryInside(staged, manifest.entry);
    await swapIn(staged, dest, hadOld);
  } catch (error) {
    await rm(staged, { recursive: true, force: true });
    throw error;
  }
  await trustWorkspacePlugin(dest);
  return manifest;
}
