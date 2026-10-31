/**
 * B-686 (FR-002, FR-005, NFR-001): which workspace manifest plugins are imported, and which are not.
 *
 * The manager-level cases pin what `PluginsManager` offers the import step: only plugins listed from
 * the native root `.theokit/plugins` that declare an `entry`, each with the FOLDER it lives in (the
 * name the trust gate checks), while `plugins.list()` keeps exactly today's keys.
 *
 * The `Agent.create` cases prove the trust half in both directions: each fixture entry appends one
 * byte to its own sentinel at evaluation, so "never imported" is a sentinel that does not exist,
 * not a tool that failed to register. Each test has its own workspace, so no module URL repeats.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Agent } from "../../../../src/agent.js";
import { setDiagnosticsSink } from "../../../../src/internal/diagnostics.js";
import { globalSingleton } from "../../../../src/internal/global-singleton.js";
import { _resetDiscovery } from "../../../../src/internal/providers/discovery.js";
import { PluginsManager } from "../../../../src/internal/runtime/plugin-loader/plugins-manager.js";
import type { CompatSource } from "../../../../src/types/agent.js";
import { removeTempDirRobustSync, useTempCwd } from "../../../helpers/temp-workspace.js";

useTempCwd("theokit-manifest-trust-");

const STUB_KEY = `sk-test-${"0".repeat(40)}`;

const dirs: string[] = [];
beforeEach(() => {
  vi.stubEnv("THEOKIT_TRUSTED_PROVIDERS", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  _resetDiscovery();
  // The manifest step keeps its once-per-folder diagnostic set under this key.
  globalSingleton("theokit-sdk.plugins.manifest-untrusted-warned", () => new Set<string>()).clear();
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

/** Write `<ws>/.theokit/plugins/<folder>/.claude-plugin/plugin.json` declaring `name` and `entry`. */
function cliManifest(ws: string, folder: string, name: string, entry: string): string {
  const dir = join(ws, ".theokit", "plugins", folder);
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(dir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name, version: "1.0.0", entry }),
  );
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

  it("a native CLI-form manifest declaring an entry yields one candidate in its folder", async () => {
    const ws = workspace();
    const dir = cliManifest(ws, "cli-echo", "echo", "index.mjs");
    const manager = await managerFor(ws, false);

    const candidates = manager.nativeEntryCandidates();
    expect(candidates.map((c) => c.folder)).toEqual(["cli-echo"]);
    expect(candidates[0]?.entryPath).toBe(join(dir, "index.mjs"));
  });

  it("an entry of ../../escape.mjs refuses with path_traversal", async () => {
    const ws = workspace();
    manifest(ws, ".theokit", "evil", "evil", "../../escape.mjs");
    const manager = new PluginsManager(ws, undefined, true, false, undefined, []);

    await expect(manager.initialize()).rejects.toMatchObject({ code: "path_traversal" });
  });
});

/** Replace `<dir>/index.mjs` with a general plugin whose evaluation appends to `<dir>/sentinel`. */
function sentinelEntry(dir: string, name: string): string {
  const sentinel = join(dir, "sentinel");
  writeFileSync(
    join(dir, "index.mjs"),
    `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(sentinel)}, "x");
export default { kind: "general", name: ${JSON.stringify(name)}, register() {} };
`,
  );
  return sentinel;
}

async function listedNames(
  ws: string,
  extra: { compatSources?: CompatSource[]; plugins?: { enabled: string[] } } = {},
): Promise<string[]> {
  const agent = await Agent.create({
    apiKey: STUB_KEY,
    model: { id: "o4-mini" },
    providers: { routes: [{ capability: "chat", provider: "openai" }] },
    local: {
      cwd: ws,
      settingSources: ["plugins"],
      ...(extra.compatSources === undefined ? {} : { compatSources: extra.compatSources }),
    },
    ...(extra.plugins === undefined ? {} : { plugins: extra.plugins }),
  });
  try {
    return ((await agent.plugins?.list()) ?? []).map((p) => p.name);
  } finally {
    await agent.dispose?.();
  }
}

describe("Agent.create imports a workspace manifest entry only when its folder is trusted", () => {
  it("leaves an untrusted folder's sentinel absent and keeps it listed", async () => {
    const ws = workspace();
    const sentinel = sentinelEntry(manifest(ws, ".theokit", "echo", "echo", "index.mjs"), "echo");

    expect(await listedNames(ws)).toContain("echo");
    expect(existsSync(sentinel)).toBe(false);
  });

  it("fails Agent.create with plugin_entry_import_failed for a trusted CLI-form entry that is absent", async () => {
    const ws = workspace();
    cliManifest(ws, "cli-echo", "echo", "index.mjs");
    vi.stubEnv("THEOKIT_TRUSTED_PROVIDERS", "cli-echo");

    await expect(listedNames(ws)).rejects.toMatchObject({ code: "plugin_entry_import_failed" });
  });

  it("never imports a foreign-root plugin even when its folder name is trusted", async () => {
    const ws = workspace();
    const sentinel = sentinelEntry(manifest(ws, ".claude", "echo", "echo", "index.mjs"), "echo");
    vi.stubEnv("THEOKIT_TRUSTED_PROVIDERS", "echo");

    expect(await listedNames(ws, { compatSources: ["claude-code"] })).toContain("echo");
    expect(existsSync(sentinel)).toBe(false);
  });

  it("never imports a trusted folder the enabled list excludes, and keeps it unlisted", async () => {
    const ws = workspace();
    const sentinel = sentinelEntry(manifest(ws, ".theokit", "echo", "echo", "index.mjs"), "echo");
    vi.stubEnv("THEOKIT_TRUSTED_PROVIDERS", "echo");

    expect(await listedNames(ws, { plugins: { enabled: ["other"] } })).not.toContain("echo");
    expect(existsSync(sentinel)).toBe(false);
  });

  it("checks the folder name, not the declared name: folder pkg declaring echo stays unimported", async () => {
    const ws = workspace();
    const sentinel = sentinelEntry(manifest(ws, ".theokit", "pkg", "echo", "index.mjs"), "echo");
    vi.stubEnv("THEOKIT_TRUSTED_PROVIDERS", "echo");

    expect(await listedNames(ws)).toContain("echo");
    expect(existsSync(sentinel)).toBe(false);
  });

  it("imports a trusted folder echo declaring name other exactly once", async () => {
    const ws = workspace();
    const sentinel = sentinelEntry(manifest(ws, ".theokit", "echo", "other", "index.mjs"), "other");
    vi.stubEnv("THEOKIT_TRUSTED_PROVIDERS", "echo");

    expect(await listedNames(ws)).toContain("other");
    expect(readFileSync(sentinel, "utf8")).toHaveLength(1);
  });

  it("imports only the native copy of a folder present under both roots, and lists both", async () => {
    const ws = workspace();
    const nativeSentinel = sentinelEntry(
      manifest(ws, ".theokit", "echo", "echo", "index.mjs"),
      "echo",
    );
    const foreignSentinel = sentinelEntry(
      manifest(ws, ".claude", "echo", "echo", "index.mjs"),
      "echo",
    );
    vi.stubEnv("THEOKIT_TRUSTED_PROVIDERS", "echo");

    const names = await listedNames(ws, { compatSources: ["claude-code"] });

    expect(names.filter((n) => n === "echo")).toHaveLength(2);
    expect(readFileSync(nativeSentinel, "utf8")).toHaveLength(1);
    expect(existsSync(foreignSentinel)).toBe(false);
  });

  it("diagnoses an untrusted folder once across two creates, naming the folder and its declared name", async () => {
    const ws = workspace();
    sentinelEntry(manifest(ws, ".theokit", "pkg", "echo", "index.mjs"), "echo");
    const messages: string[] = [];
    setDiagnosticsSink((message) => {
      messages.push(message);
    });
    try {
      await listedNames(ws);
      await listedNames(ws);
    } finally {
      setDiagnosticsSink((message) => {
        process.stderr.write(message);
      });
    }

    const about = messages.filter((m) => m.includes('workspace plugin folder "pkg"'));
    expect(about).toHaveLength(1);
    expect(about[0]).toContain('"echo"');
  });
});
