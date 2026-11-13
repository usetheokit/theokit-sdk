import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigurationError } from "../../src/errors.js";
import { listWorkspacePlugins } from "../../src/index.js";
import { PluginsManager } from "../../src/internal/runtime/plugin-loader/plugins-manager.js";

let cwd: string;
let home: string;
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

function write(path: string, body: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
}
function fixture(base: string): void {
  const root = join(base, ".theokit", "plugins");
  write(join(root, "cli", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "cli-one" }));
  write(join(root, "md", "PLUGIN.md"), "---\nname: md-one\n---\nbody\n");
  write(join(root, "js", "plugin.json"), JSON.stringify({ name: "js-one" }));
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "wp-cwd-"));
  home = mkdtempSync(join(tmpdir(), "wp-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("listWorkspacePlugins", () => {
  it("lists all three manifest formats", async () => {
    fixture(cwd);
    const list = await listWorkspacePlugins(cwd);
    const root = join(cwd, ".theokit", "plugins");
    const by = Object.fromEntries(list.map((p) => [p.name, p]));
    expect(by["cli-one"]).toMatchObject({
      format: "claude-plugin-json",
      root: join(root, "cli"),
      manifestPath: join(root, "cli", ".claude-plugin", "plugin.json"),
    });
    expect(by["md-one"]).toMatchObject({
      format: "plugin-md",
      manifestPath: join(root, "md", "PLUGIN.md"),
    });
    expect(by["js-one"]).toMatchObject({
      format: "plugin-json",
      manifestPath: join(root, "js", "plugin.json"),
    });
    expect(list).toHaveLength(3);
  });

  it("does not list plugins under the home directory", async () => {
    write(join(home, ".theokit", "plugins", "h", "PLUGIN.md"), "---\nname: home-one\n---\n");
    expect(await listWorkspacePlugins(cwd)).toEqual([]);
  });

  it("lists .claude/plugins only when claude-code is declared", async () => {
    write(join(cwd, ".claude", "plugins", "c", "PLUGIN.md"), "---\nname: claude-one\n---\n");
    expect(await listWorkspacePlugins(cwd)).toEqual([]);
    const list = await listWorkspacePlugins(cwd, { compatSources: ["claude-code"] });
    expect(list.map((p) => p.name)).toEqual(["claude-one"]);
  });

  it("returns the names PluginsManager registers", async () => {
    fixture(cwd);
    const manager = new PluginsManager(cwd, undefined, true, false, undefined, []);
    await manager.initialize();
    const registered = (await manager.list()).map((p) => p.name).sort();
    const listed = (await listWorkspacePlugins(cwd)).map((p) => p.name).sort();
    expect(listed).toEqual(registered);
  });

  it("fails like PluginsManager on an unterminated frontmatter fence", async () => {
    write(join(cwd, ".theokit", "plugins", "bad", "PLUGIN.md"), "---\nname: bad\nno end\n");
    const manager = new PluginsManager(cwd, undefined, true, false, undefined, []);
    const fromManager = await manager.initialize().catch((e: unknown) => e);
    const fromListing = await listWorkspacePlugins(cwd).catch((e: unknown) => e);
    expect(fromManager).toBeInstanceOf(ConfigurationError);
    expect(fromListing).toBeInstanceOf(ConfigurationError);
    expect((fromListing as ConfigurationError).code).toBe((fromManager as ConfigurationError).code);
  });
});
