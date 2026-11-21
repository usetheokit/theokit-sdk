/**
 * #1041: parse, trust and install a workspace plugin. HOME is a fresh tmpdir per test
 * (`vitest.setup.ts`), so each test's trust record is its own.
 */
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
import { removeTempDirRobustSync } from "./helpers/temp-workspace.js";
import {
  workspaceTrustRecordPath,
  writeWorkspaceTrustRecord,
} from "./helpers/workspace-plugin-trust.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeTempDirRobustSync(d);
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ws-plugin-install-"));
  dirs.push(d);
  return d;
}

function source(name = "echo", entry = "index.mjs", body = "v1"): string {
  const dir = tmp();
  writeFileSync(join(dir, "PLUGIN.md"), `---\nname: ${name}\nentry: ${entry}\n---\n\nBody.\n`);
  writeFileSync(
    join(dir, "index.mjs"),
    `// ${body}\nexport default { kind: "general", name: ${JSON.stringify(name)}, register() {} };\n`,
  );
  return dir;
}

describe("parsePluginManifest", () => {
  it("defaults version and rejects bad names and entries", () => {
    expect(parsePluginManifest("---\nname: a-b\nentry: i.js\n---\n")).toEqual({
      name: "a-b",
      version: "0.0.0",
      entry: "i.js",
    });
    const bad = "---\nname: a\nentry: ../x.js\n---\n";
    expect(() => parsePluginManifest(bad)).toThrow(PluginManifestError);
    expect(() => parsePluginManifest(bad)).toThrow(/must stay inside the plugin folder/);
    for (const text of [
      "---\nname: A\nentry: i.js\n---\n",
      "---\nname: a\nentry: /etc/x\n---\n",
      "---\nname: a\n---\n",
      "no frontmatter",
    ]) {
      expect(() => parsePluginManifest(text)).toThrow(PluginManifestError);
    }
  });
});

describe("trustWorkspacePlugin", () => {
  it("is idempotent and writes the record with mode 0600", async () => {
    const dir = tmp();
    await trustWorkspacePlugin(dir);
    await trustWorkspacePlugin(dir);
    const path = workspaceTrustRecordPath();
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([realpathSync(dir)]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await untrustWorkspacePlugin(dir)).toBe(true);
    expect(await untrustWorkspacePlugin(dir)).toBe(false);
  });

  it("rejects a corrupt record with TrustRecordError and leaves it unchanged", async () => {
    writeWorkspaceTrustRecord("{not json");
    const err = await trustWorkspacePlugin(tmp()).catch((e) => e);
    expect(err).toBeInstanceOf(TrustRecordError);
    expect(err.message).toContain(workspaceTrustRecordPath());
    expect(readFileSync(workspaceTrustRecordPath(), "utf8")).toBe("{not json");
  });

  it("rejects an array with non-string entries without rewriting it", async () => {
    writeWorkspaceTrustRecord('["/a", 3]');
    await expect(trustWorkspacePlugin(tmp())).rejects.toBeInstanceOf(TrustRecordError);
    expect(readFileSync(workspaceTrustRecordPath(), "utf8")).toBe('["/a", 3]');
  });
});

describe("installWorkspacePlugin", () => {
  it("copies, trusts, and Agent.create loads the installed plugin", async () => {
    const ws = tmp();
    const manifest = await installWorkspacePlugin({ source: source(), workspace: ws });
    expect(manifest.name).toBe("echo");
    const dest = join(ws, ".theokit", "plugins", "echo");
    expect(existsSync(join(dest, "index.mjs"))).toBe(true);
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
    } finally {
      await agent.dispose?.();
    }
  });

  it("refuses an existing destination unless replace is set, and replaces cleanly", async () => {
    const ws = tmp();
    await installWorkspacePlugin({ source: source(), workspace: ws });
    await expect(installWorkspacePlugin({ source: source(), workspace: ws })).rejects.toThrow(
      /already exists/,
    );
    await installWorkspacePlugin({
      source: source("echo", "index.mjs", "v2"),
      workspace: ws,
      replace: true,
    });
    const plugins = join(ws, ".theokit", "plugins");
    expect(readdirSync(plugins)).toEqual(["echo"]);
    expect(readFileSync(join(plugins, "echo", "index.mjs"), "utf8")).toContain("v2");
  });

  it("keeps the old plugin when the new source is refused", async () => {
    const ws = tmp();
    await installWorkspacePlugin({ source: source(), workspace: ws });
    const bad = source("echo", "missing.mjs");
    await expect(
      installWorkspacePlugin({ source: bad, workspace: ws, replace: true }),
    ).rejects.toThrow(PluginManifestError);
    expect(readFileSync(join(ws, ".theokit", "plugins", "echo", "index.mjs"), "utf8")).toContain(
      "v1",
    );
  });

  it("refuses an entry symlinked outside the source folder and copies nothing", async () => {
    const outside = tmp();
    writeFileSync(join(outside, "evil.mjs"), "export default {};\n");
    const src = tmp();
    writeFileSync(join(src, "PLUGIN.md"), "---\nname: evil\nentry: index.mjs\n---\n");
    symlinkSync(join(outside, "evil.mjs"), join(src, "index.mjs"));
    const ws = tmp();
    await expect(installWorkspacePlugin({ source: src, workspace: ws })).rejects.toThrow(
      /must stay inside the plugin folder/,
    );
    expect(existsSync(join(ws, ".theokit"))).toBe(false);
    expect(existsSync(workspaceTrustRecordPath())).toBe(false);
  });

  it("refuses an entry that is a directory", async () => {
    const src = tmp();
    writeFileSync(join(src, "PLUGIN.md"), "---\nname: d\nentry: sub\n---\n");
    mkdirSync(join(src, "sub"));
    await expect(installWorkspacePlugin({ source: src, workspace: tmp() })).rejects.toThrow(
      /not a file/,
    );
  });
});
