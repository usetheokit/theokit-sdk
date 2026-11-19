import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Agent } from "../src/agent.js";
import {
  installWorkspacePlugin,
  PluginManifestError,
  parsePluginManifest,
  TrustRecordError,
  trustWorkspacePlugin,
  untrustWorkspacePlugin,
} from "../src/index.js";
import { removeTempDirRobustSync, useTempCwd } from "./helpers/temp-workspace.js";
import {
  workspaceTrustRecordPath,
  writeWorkspaceTrustRecord,
} from "./helpers/workspace-plugin-trust.js";

useTempCwd("theokit-ws-plugin-install-");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeTempDirRobustSync(d);
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ws-plugin-install-"));
  dirs.push(d);
  return d;
}

function source(entry = "index.mjs", marker = "v1"): string {
  const dir = join(tmp(), "src-plugin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "PLUGIN.md"),
    `---\nname: echo\nversion: 1.0.0\nentry: ${entry}\n---\n\nBody\n`,
  );
  if (!entry.includes("..")) {
    writeFileSync(
      join(dir, entry),
      `export default { kind: "general", name: "echo", marker: "${marker}", register() {} };\n`,
    );
  }
  return dir;
}

describe("parsePluginManifest", () => {
  it("defaults the version", () => {
    expect(parsePluginManifest("---\nname: a-b\nentry: i.js\n---\n")).toEqual({
      name: "a-b",
      version: "0.0.0",
      entry: "i.js",
    });
  });

  it("rejects an entry outside the folder", () => {
    expect(() => parsePluginManifest("---\nname: a\nentry: ../x.js\n---\n")).toThrow(
      /must stay inside the plugin folder/,
    );
    expect(() => parsePluginManifest("---\nname: a\nentry: ../x.js\n---\n")).toThrow(
      PluginManifestError,
    );
    expect(() => parsePluginManifest("---\nname: a\nentry: /x.js\n---\n")).toThrow(
      PluginManifestError,
    );
  });

  it("rejects a bad name, a missing entry and missing frontmatter", () => {
    expect(() => parsePluginManifest("---\nname: Bad_Name\nentry: i.js\n---\n")).toThrow(
      PluginManifestError,
    );
    expect(() => parsePluginManifest("---\nname: a\n---\n")).toThrow(/entry/);
    expect(() => parsePluginManifest("no frontmatter")).toThrow(PluginManifestError);
  });
});

describe("trustWorkspacePlugin", () => {
  it("is idempotent and writes mode 0600; untrust removes it", async () => {
    const folder = tmp();
    await trustWorkspacePlugin(folder);
    await trustWorkspacePlugin(folder);
    const path = workspaceTrustRecordPath();
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([realpathSync(folder)]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await untrustWorkspacePlugin(folder)).toBe(true);
    expect(await untrustWorkspacePlugin(folder)).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([]);
  });

  it("refuses a malformed record and leaves it unchanged", async () => {
    writeWorkspaceTrustRecord("{not json");
    const path = workspaceTrustRecordPath();
    await expect(trustWorkspacePlugin(tmp())).rejects.toBeInstanceOf(TrustRecordError);
    await expect(trustWorkspacePlugin(tmp())).rejects.toThrow(path);
    await expect(untrustWorkspacePlugin(tmp())).rejects.toBeInstanceOf(TrustRecordError);
    expect(readFileSync(path, "utf8")).toBe("{not json");
  });
});

describe("installWorkspacePlugin", () => {
  it("installs, trusts the copy, and Agent.create loads it", async () => {
    const ws = tmp();
    const sentinel = join(ws, "loaded");
    const src = source();
    writeFileSync(
      join(src, "index.mjs"),
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(sentinel)}, "x");\nexport default { kind: "general", name: "echo", register() {} };\n`,
    );
    const manifest = await installWorkspacePlugin({ source: src, workspace: ws });
    expect(manifest).toEqual({ name: "echo", version: "1.0.0", entry: "index.mjs" });
    const dest = join(ws, ".theokit", "plugins", "echo");
    expect(JSON.parse(readFileSync(workspaceTrustRecordPath(), "utf8"))).toEqual([
      realpathSync(dest),
    ]);
    const agent = await Agent.create({
      apiKey: `sk-test-${"0".repeat(40)}`,
      model: { id: "o4-mini" },
      providers: { routes: [{ capability: "chat", provider: "openai" }] },
      local: { cwd: ws, settingSources: ["plugins"] },
    });
    try {
      expect(((await agent.plugins?.list()) ?? []).map((p) => p.name)).toContain("echo");
      expect(existsSync(sentinel)).toBe(true);
    } finally {
      await agent.dispose?.();
    }
  });

  it("refuses an existing destination unless replace, and replaces", async () => {
    const ws = tmp();
    await installWorkspacePlugin({ source: source("index.mjs", "v1"), workspace: ws });
    await expect(
      installWorkspacePlugin({ source: source("index.mjs", "v2"), workspace: ws }),
    ).rejects.toThrow(/replace: true/);
    await installWorkspacePlugin({
      source: source("index.mjs", "v2"),
      workspace: ws,
      replace: true,
    });
    const dest = join(ws, ".theokit", "plugins");
    expect(readFileSync(join(dest, "echo", "index.mjs"), "utf8")).toContain("v2");
    expect(readdirSync(dest)).toEqual(["echo"]);
  });

  it("keeps the old plugin when a replace fails", async () => {
    const ws = tmp();
    await installWorkspacePlugin({ source: source("index.mjs", "v1"), workspace: ws });
    writeWorkspaceTrustRecord("{not json");
    await expect(
      installWorkspacePlugin({ source: source("index.mjs", "v2"), workspace: ws, replace: true }),
    ).rejects.toBeInstanceOf(TrustRecordError);
    const dest = join(ws, ".theokit", "plugins");
    expect(readFileSync(join(dest, "echo", "index.mjs"), "utf8")).toContain("v1");
    expect(readdirSync(dest)).toEqual(["echo"]);
  });

  it("refuses an entry that is a symlink to a file outside the source and copies nothing", async () => {
    const ws = tmp();
    const src = source("index.mjs");
    const outside = join(tmp(), "outside.mjs");
    writeFileSync(outside, "export default {};\n");
    const link = join(src, "link.mjs");
    symlinkSync(outside, link);
    writeFileSync(join(src, "PLUGIN.md"), "---\nname: echo\nentry: link.mjs\n---\n");
    await expect(installWorkspacePlugin({ source: src, workspace: ws })).rejects.toThrow(
      /inside the plugin folder/,
    );
    expect(existsSync(join(ws, ".theokit"))).toBe(false);
  });

  it("refuses a missing entry and a directory entry", async () => {
    const ws = tmp();
    const src = source("index.mjs");
    mkdirSync(join(src, "dir"));
    writeFileSync(join(src, "PLUGIN.md"), "---\nname: echo\nentry: dir\n---\n");
    await expect(installWorkspacePlugin({ source: src, workspace: ws })).rejects.toThrow(
      /regular file/,
    );
    writeFileSync(join(src, "PLUGIN.md"), "---\nname: echo\nentry: nope.mjs\n---\n");
    await expect(installWorkspacePlugin({ source: src, workspace: ws })).rejects.toThrow(
      /does not exist/,
    );
  });
});
