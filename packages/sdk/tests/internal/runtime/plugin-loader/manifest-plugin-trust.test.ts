/**
 * B-686 (FR-002, FR-005, NFR-001): which workspace manifest plugins are imported, and which are not.
 *
 * The manager-level cases pin what `PluginsManager` offers the import step: only plugins listed from
 * the native root `.theokit/plugins` that declare an `entry`, each with the FOLDER it lives in (the
 * name the trust gate checks), while `plugins.list()` keeps exactly today's keys.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PluginsManager } from "../../../../src/internal/runtime/plugin-loader/plugins-manager.js";
import { removeTempDirRobustSync } from "../../../helpers/temp-workspace.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeTempDirRobustSync(d);
});

function workspace(): string {
  const ws = mkdtempSync(join(tmpdir(), "manifest-plugin-trust-"));
  dirs.push(ws);
  return ws;
}

/** Write `<ws>/<rootDir>/plugins/<folder>/PLUGIN.md` declaring `name` and, when given, `entry`. */
function manifest(
  ws: string,
  rootDir: string,
  folder: string,
  name: string,
  entry?: string,
): string {
  const dir = join(ws, rootDir, "plugins", folder);
  mkdirSync(dir, { recursive: true });
  const entryLine = entry === undefined ? "" : `entry: ${entry}\n`;
  writeFileSync(
    join(dir, "PLUGIN.md"),
    `---\nname: ${name}\nversion: 1.0.0\n${entryLine}---\n\nBody.\n`,
  );
  if (entry !== undefined && !entry.includes("..")) {
    writeFileSync(join(dir, entry), "export default {};\n");
  }
  return dir;
}

async function managerFor(ws: string, compat: boolean): Promise<PluginsManager> {
  const manager = new PluginsManager(
    ws,
    undefined,
    true,
    false,
    undefined,
    compat ? ["claude-code"] : [],
  );
  await manager.initialize();
  return manager;
}

describe("PluginsManager records where each listed plugin came from", () => {
  it("every listed entry's keys are a subset of name, version, capabilities, source and entry", async () => {
    const ws = workspace();
    manifest(ws, ".theokit", "echo", "echo", "index.mjs");
    manifest(ws, ".theokit", "bare", "bare");
    manifest(ws, ".claude", "foreign", "foreign", "index.mjs");
    const manager = await managerFor(ws, true);

    const list = await manager.list();
    expect(list).toHaveLength(3);
    const allowed = new Set(["name", "version", "capabilities", "source", "entry"]);
    for (const entry of list) {
      for (const key of Object.keys(entry))
        expect(allowed.has(key), `unexpected key ${key}`).toBe(true);
    }
  });

  it("a folder under both the native and a foreign root yields one candidate, the native one", async () => {
    const ws = workspace();
    const nativeDir = manifest(ws, ".theokit", "echo", "echo", "index.mjs");
    manifest(ws, ".claude", "echo", "echo", "index.mjs");
    const manager = await managerFor(ws, true);

    const candidates = manager.nativeEntryCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.folder).toBe("echo");
    expect(candidates[0]?.entryPath).toBe(join(nativeDir, "index.mjs"));
    expect((await manager.list()).filter((p) => p.name === "echo")).toHaveLength(2);
  });

  it("a folder pkg declaring name echo yields a candidate whose folder is pkg", async () => {
    const ws = workspace();
    manifest(ws, ".theokit", "pkg", "echo", "index.mjs");
    const manager = await managerFor(ws, false);

    const candidates = manager.nativeEntryCandidates();
    expect(candidates.map((c) => c.folder)).toEqual(["pkg"]);
    expect(candidates[0]?.metadata.name).toBe("echo");
  });

  it("a manifest with no entry yields no candidate and stays listed", async () => {
    const ws = workspace();
    manifest(ws, ".theokit", "bare", "bare");
    const manager = await managerFor(ws, false);

    expect(manager.nativeEntryCandidates()).toEqual([]);
    expect((await manager.list()).map((p) => p.name)).toEqual(["bare"]);
  });

  it("an entry of ../../escape.mjs refuses with path_traversal", async () => {
    const ws = workspace();
    manifest(ws, ".theokit", "evil", "evil", "../../escape.mjs");
    const manager = new PluginsManager(ws, undefined, true, false, undefined, []);

    await expect(manager.initialize()).rejects.toMatchObject({ code: "path_traversal" });
  });
});
