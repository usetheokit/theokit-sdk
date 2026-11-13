/**
 * T3.1 inspect tests + EC-E proof (Theokit.inspect against dist).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listWorkspacePlugins } from "@theokit/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/index.js";
import { listGatewayAdapters } from "../../src/inspect/gateway.js";
import { listPlugins } from "../../src/inspect/plugins.js";

function captureStdout(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => {
    lines.push(String(c));
    return true;
  });
  return { lines, restore: () => spy.mockRestore() };
}

describe("theokit inspect (T3.1)", () => {
  it("--json emits valid JSON", async () => {
    const out = captureStdout();
    const code = await main(["node", "theokit", "inspect", "--json"]);
    expect(code).toBe(0);
    const text = out.lines.join("");
    out.restore();
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it("default output lists providers + adapters + gateways", async () => {
    const out = captureStdout();
    const code = await main(["node", "theokit", "inspect"]);
    expect(code).toBe(0);
    const text = out.lines.join("");
    out.restore();
    expect(text).toMatch(/Builtin LLM providers/i);
    expect(text).toContain("ollama");
    expect(text).toContain("anthropic");
    expect(text).toMatch(/Memory embedding adapters/i);
    expect(text).toMatch(/Gateway adapters/i);
  });

  it("EC-E: lists 7 builtin providers (from Theokit.inspect public API)", async () => {
    const out = captureStdout();
    await main(["node", "theokit", "inspect", "--json"]);
    const text = out.lines.join("");
    out.restore();
    const parsed = JSON.parse(text) as { providers: Array<{ name: string }> };
    const names = parsed.providers.map((p) => p.name).sort();
    expect(names).toEqual(
      expect.arrayContaining([
        "anthropic",
        "openai",
        "openrouter",
        "gemini",
        "ollama",
        "lmstudio",
        "llamacpp",
      ]),
    );
  });

  it("EC-E: lists 6 embedding adapters including ollama (transport: local)", async () => {
    const out = captureStdout();
    await main(["node", "theokit", "inspect", "--json"]);
    const text = out.lines.join("");
    out.restore();
    const parsed = JSON.parse(text) as {
      embeddingAdapters: Array<{ id: string; transport: string }>;
    };
    const ollama = parsed.embeddingAdapters.find((a) => a.id === "ollama");
    expect(ollama).toBeDefined();
    expect(ollama?.transport).toBe("local");
  });

  it("--filter providers narrows output", async () => {
    const out = captureStdout();
    await main(["node", "theokit", "inspect", "--filter", "providers", "--json"]);
    const text = out.lines.join("");
    out.restore();
    const parsed = JSON.parse(text) as InspectResultLike;
    expect(parsed.providers.length).toBeGreaterThan(0);
    expect(parsed.embeddingAdapters.length).toBe(0);
    expect(parsed.gateways.length).toBe(0);
    expect(parsed.plugins.length).toBe(0);
  });

  it("--filter invalid → exit 2", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await main(["node", "theokit", "inspect", "--filter", "garbage"]);
    expect(code).toBe(2);
    stderrSpy.mockRestore();
  });
});

interface InspectResultLike {
  providers: unknown[];
  embeddingAdapters: unknown[];
  gateways: unknown[];
  plugins: unknown[];
}

describe("listPlugins (T3.1)", () => {
  let workDir: string;
  let homeDir: string;
  const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "tk-plugins-"));
    homeDir = mkdtempSync(join(tmpdir(), "tk-home-"));
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(savedHome)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(workDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("returns empty when no plugins dir exists", async () => {
    expect(await listPlugins(workDir)).toEqual([]);
  });

  it("lists a project PLUGIN.md plugin", async () => {
    const pluginDir = join(workDir, ".theokit", "plugins", "my-plugin");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, "PLUGIN.md"),
      "---\r\nname: my-plugin\r\ndescription: Does cool things.\r\n---\r\n\r\nBody.",
      "utf8",
    );
    const plugins = await listPlugins(workDir);
    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.name).toBe("my-plugin");
    expect(plugins[0]?.source).toBe("project");
  });

  it("does not list ~/.theokit/plugins", async () => {
    const userPlugin = join(homeDir, ".theokit", "plugins", "a");
    mkdirSync(userPlugin, { recursive: true });
    writeFileSync(join(userPlugin, "PLUGIN.md"), "---\nname: a\ndescription: x\n---\n", "utf8");
    expect((await listPlugins(workDir)).map((p) => p.name)).not.toContain("a");
  });

  it("lists a project plugin that only has .claude-plugin/plugin.json", async () => {
    const dir = join(workDir, ".theokit", "plugins", "cc");
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(dir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "cc", version: "1.0.0", description: "d" }),
      "utf8",
    );
    const plugins = await listPlugins(workDir);
    expect(plugins.map((p) => p.name)).toEqual(["cc"]);
  });

  it("names equal those of listWorkspacePlugins for the same fixture", async () => {
    const a = join(workDir, ".theokit", "plugins", "a");
    mkdirSync(a, { recursive: true });
    writeFileSync(join(a, "PLUGIN.md"), "---\nname: a\ndescription: x\n---\n", "utf8");
    const b = join(workDir, ".theokit", "plugins", "b", ".claude-plugin");
    mkdirSync(b, { recursive: true });
    writeFileSync(join(b, "plugin.json"), JSON.stringify({ name: "b", version: "1.0.0" }), "utf8");
    const expected = (await listWorkspacePlugins(workDir)).map((p) => p.name).sort();
    expect((await listPlugins(workDir)).map((p) => p.name)).toEqual(expected);
    expect(expected).toEqual(["a", "b"]);
  });
});

describe("listGatewayAdapters (T3.1)", () => {
  it("returns known gateways with install status", () => {
    const gateways = listGatewayAdapters();
    const names = gateways.map((g) => g.name);
    expect(names).toContain("telegram");
    expect(names).toContain("discord");
    for (const g of gateways) {
      expect(typeof g.installed).toBe("boolean");
    }
  });
});
