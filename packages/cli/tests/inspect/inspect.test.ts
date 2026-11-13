/**
 * T3.1 inspect tests + EC-E proof (Theokit.inspect against dist).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
  let prevHome: string | undefined;
  let prevProfile: string | undefined;
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "tk-plugins-"));
    homeDir = mkdtempSync(join(tmpdir(), "tk-home-"));
    prevHome = process.env.HOME;
    prevProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
    rmSync(workDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  function write(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  }

  it("returns empty when no plugins dir exists", async () => {
    expect(await listPlugins(workDir)).toEqual([]);
  });

  it("lists a project PLUGIN.md plugin", async () => {
    write(
      join(workDir, ".theokit", "plugins", "my-plugin", "PLUGIN.md"),
      "---\nname: my-plugin\n---\n\nBody.",
    );
    const plugins = await listPlugins(workDir);
    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.name).toBe("my-plugin");
    expect(plugins[0]?.source).toBe("project");
  });

  it("does not list plugins in ~/.theokit/plugins", async () => {
    write(join(homeDir, ".theokit", "plugins", "a", "PLUGIN.md"), "---\nname: a\n---\n");
    expect((await listPlugins(workDir)).map((p) => p.name)).not.toContain("a");
  });

  it("lists a project plugin that only has .claude-plugin/plugin.json", async () => {
    write(
      join(workDir, ".theokit", "plugins", "cj", ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "cj-plugin" }),
    );
    expect((await listPlugins(workDir)).map((p) => p.name)).toEqual(["cj-plugin"]);
  });

  it("names equal those of listWorkspacePlugins for the same fixture", async () => {
    write(join(workDir, ".theokit", "plugins", "x", "PLUGIN.md"), "---\nname: x\n---\n");
    write(
      join(workDir, ".theokit", "plugins", "y", ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "y" }),
    );
    write(join(homeDir, ".theokit", "plugins", "h", "PLUGIN.md"), "---\nname: h\n---\n");
    const expected = (await listWorkspacePlugins(workDir)).map((p) => p.name).sort();
    const out = captureStdout();
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(workDir);
    await main(["node", "theokit", "inspect", "--filter", "plugins", "--json"]);
    cwd.mockRestore();
    const text = out.lines.join("");
    out.restore();
    const parsed = JSON.parse(text) as { plugins: Array<{ name: string }> };
    expect(parsed.plugins.map((p) => p.name).sort()).toEqual(expected);
    expect(expected).toEqual(["x", "y"]);
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
