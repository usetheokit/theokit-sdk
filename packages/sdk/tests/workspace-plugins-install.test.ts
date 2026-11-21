/**
 * Public workspace plugin APIs (#1041): parse a manifest, trust a folder, install a plugin.
 * `HOME` is a fresh tmpdir per test (`vitest.setup.ts`), so each test has its own trust record.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Agent } from "../src/agent.js";
import {
  installWorkspacePlugin,
  PluginManifestError,
  parsePluginManifest,
  TrustRecordError,
  trustWorkspacePlugin,
  untrustWorkspacePlugin,
} from "../src/index.js";
import { globalSingleton } from "../src/internal/global-singleton.js";
import { _resetDiscovery } from "../src/internal/providers/discovery.js";
import { useTempCwd } from "./helpers/temp-workspace.js";
import {
  workspaceTrustRecordPath,
  writeWorkspaceTrustRecord,
} from "./helpers/workspace-plugin-trust.js";

useTempCwd("theokit-ws-plugins-");

const STUB_KEY = `sk-test-${"0".repeat(40)}`;
const MANIFEST = "---\nname: echo\nversion: 1.2.3\nentry: index.mjs\n---\n\nBody.\n";
const ENTRY = `export default {
  kind: "general",
  name: "echo",
  version: "1.2.3",
  register(ctx) {
    ctx.registerTool({
      name: "echo_token",
      description: "Echo a token",
      inputSchema: { type: "object", properties: {} },
      handler: () => "token",
    });
  },
};
`;

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ws-plugin-"));
  dirs.push(d);
  return d;
}

function source(manifest = MANIFEST): string {
  const dir = tmp();
  writeFileSync(join(dir, "PLUGIN.md"), manifest);
  writeFileSync(join(dir, "index.mjs"), ENTRY);
  return dir;
}

function record(): string[] {
  return JSON.parse(readFileSync(workspaceTrustRecordPath(), "utf8")) as string[];
}

afterEach(() => {
  vi.unstubAllGlobals();
  _resetDiscovery();
  globalSingleton("theokit-sdk.plugins.manifest-untrusted-warned", () => new Set<string>()).clear();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("parsePluginManifest", () => {
  it("reads name, version and entry, defaulting the version", () => {
    expect(parsePluginManifest(MANIFEST)).toEqual({
      name: "echo",
      version: "1.2.3",
      entry: "index.mjs",
    });
    expect(parsePluginManifest("---\nname: a\nentry: x.js\n---\n").version).toBe("0.0.0");
  });

  it("refuses an entry that leaves the plugin folder", () => {
    const text = "---\nname: a\nentry: ../x.js\n---\n";
    expect(() => parsePluginManifest(text)).toThrow(PluginManifestError);
    expect(() => parsePluginManifest(text)).toThrow(/entry must stay inside the plugin folder/);
    expect(() => parsePluginManifest("---\nname: a\nentry: /x.js\n---\n")).toThrow(
      /stay inside the plugin folder/,
    );
  });

  it("refuses a bad name, a missing entry and a missing frontmatter", () => {
    expect(() => parsePluginManifest("---\nname: Bad_Name\nentry: x.js\n---\n")).toThrow(/name/);
    expect(() => parsePluginManifest("---\nname: a\n---\n")).toThrow(/entry is required/);
    expect(() => parsePluginManifest("no frontmatter")).toThrow(PluginManifestError);
  });
});

describe("trustWorkspacePlugin", () => {
  it("is idempotent and writes the record with mode 0600", async () => {
    const dir = tmp();
    await trustWorkspacePlugin(dir);
    await trustWorkspacePlugin(dir);
    expect(record()).toEqual([realpathSync(dir)]);
    expect(statSync(workspaceTrustRecordPath()).mode & 0o777).toBe(0o600);
  });

  it("keeps other entries and untrust removes only its own", async () => {
    const a = tmp();
    const b = tmp();
    await trustWorkspacePlugin(a);
    await trustWorkspacePlugin(b);
    expect(await untrustWorkspacePlugin(a)).toBe(true);
    expect(await untrustWorkspacePlugin(a)).toBe(false);
    expect(record()).toEqual([realpathSync(b)]);
  });

  it("rejects with TrustRecordError naming the file and leaves a corrupt record unchanged", async () => {
    writeWorkspaceTrustRecord("{not json");
    const error = await trustWorkspacePlugin(tmp()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TrustRecordError);
    expect((error as Error).message).toContain(workspaceTrustRecordPath());
    expect(readFileSync(workspaceTrustRecordPath(), "utf8")).toBe("{not json");
  });
});

describe("installWorkspacePlugin", () => {
  it("copies, trusts and lets Agent.create register the tool", async () => {
    const ws = tmp();
    const manifest = await installWorkspacePlugin({ source: source(), workspace: ws });
    const dest = join(ws, ".theokit", "plugins", "echo");
    expect(manifest.name).toBe("echo");
    expect(existsSync(join(dest, "index.mjs"))).toBe(true);
    expect(record()).toEqual([realpathSync(dest)]);
    expect(readdirSync(join(ws, ".theokit", "plugins"))).toEqual(["echo"]);

    const agent = await Agent.create({
      apiKey: STUB_KEY,
      model: { id: "o4-mini" },
      providers: { routes: [{ capability: "chat", provider: "openai" }] },
      local: { cwd: ws, settingSources: ["plugins"] },
    });
    try {
      await (await agent.send("hi")).wait();
      const tools = (requests.at(-1)?.tools ?? []) as { function?: { name?: string } }[];
      expect(tools.map((t) => t.function?.name)).toContain("echo_token");
    } finally {
      await agent.dispose?.();
    }
  });

  it("refuses an existing destination unless replace is true", async () => {
    const ws = tmp();
    await installWorkspacePlugin({ source: source(), workspace: ws });
    await expect(installWorkspacePlugin({ source: source(), workspace: ws })).rejects.toThrow(
      /already installed/,
    );
    const next = source();
    writeFileSync(join(next, "extra.txt"), "x");
    await installWorkspacePlugin({ source: next, workspace: ws, replace: true });
    expect(existsSync(join(ws, ".theokit", "plugins", "echo", "extra.txt"))).toBe(true);
    expect(readdirSync(join(ws, ".theokit", "plugins"))).toEqual(["echo"]);
    expect(record()).toHaveLength(1);
  });

  it("refuses an entry that is a symlink to a file outside the source and copies nothing", async () => {
    const outside = join(tmp(), "secret.mjs");
    writeFileSync(outside, "export default {};");
    const src = tmp();
    writeFileSync(join(src, "PLUGIN.md"), MANIFEST);
    symlinkSync(outside, join(src, "index.mjs"));
    const ws = tmp();
    await expect(installWorkspacePlugin({ source: src, workspace: ws })).rejects.toThrow(
      PluginManifestError,
    );
    expect(existsSync(join(ws, ".theokit", "plugins", "echo"))).toBe(false);
    expect(existsSync(workspaceTrustRecordPath())).toBe(false);
  });

  it("refuses a missing or non-file entry", async () => {
    const src = tmp();
    writeFileSync(join(src, "PLUGIN.md"), MANIFEST);
    await expect(installWorkspacePlugin({ source: src, workspace: tmp() })).rejects.toThrow(
      /does not exist/,
    );
    mkdirSync(join(src, "index.mjs"));
    await expect(installWorkspacePlugin({ source: src, workspace: tmp() })).rejects.toThrow(
      /not a regular file/,
    );
  });

  it("leaves the old plugin and the corrupt record alone when the record is unreadable", async () => {
    const ws = tmp();
    await installWorkspacePlugin({ source: source(), workspace: ws });
    writeWorkspaceTrustRecord("{not json");
    const next = source();
    writeFileSync(join(next, "extra.txt"), "x");
    await expect(
      installWorkspacePlugin({ source: next, workspace: ws, replace: true }),
    ).rejects.toBeInstanceOf(TrustRecordError);
    expect(existsSync(join(ws, ".theokit", "plugins", "echo", "extra.txt"))).toBe(false);
    expect(existsSync(join(ws, ".theokit", "plugins", "echo", "index.mjs"))).toBe(true);
  });
});

let requests: Record<string, unknown>[] = [];
beforeEach(() => {
  requests = [];
  vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
    if (typeof init?.body !== "string") return new Response("{}", { status: 404 });
    requests.push(JSON.parse(init.body) as Record<string, unknown>);
    const records = [
      { choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ];
    const text = `${records.map((r) => `data: ${JSON.stringify(r)}\n\n`).join("")}data: [DONE]\n\n`;
    return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
  });
});
