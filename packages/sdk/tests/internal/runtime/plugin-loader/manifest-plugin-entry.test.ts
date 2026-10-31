/**
 * B-686 (FR-001, FR-003, NFR-001): a trusted workspace manifest plugin's `entry` reaches the run.
 *
 * A folder under `<cwd>/.theokit/plugins/<folder>/` whose `PLUGIN.md` names an `entry` used to be
 * listed and never imported, so the tools its `register` adds never reached the model (opportunity
 * Q1: 0 imports, 0 tools). Each fixture entry appends one byte to a sentinel at evaluation, and the
 * request the run sends is read from a stubbed `fetch`, so no request leaves the process. No
 * `plugins` option is passed: `echo_token` can only come from the manifest.
 *
 * Every test has its own cwd, so each entry has its own module URL and vitest's module cache never
 * answers for a fixture another test wrote. The fixtures are evaluated by vitest's module runner,
 * not by Node's loader; the `.cjs` case proves the runner's interop, not Node's.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Agent } from "../../../../src/agent.js";
import { globalSingleton } from "../../../../src/internal/global-singleton.js";
import { _resetDiscovery } from "../../../../src/internal/providers/discovery.js";
import { useTempCwd } from "../../../helpers/temp-workspace.js";

useTempCwd("theokit-manifest-entry-");

const STUB_KEY = `sk-test-${"0".repeat(40)}`;

const ECHO_PLUGIN = `{
  kind: "general",
  name: "echo",
  version: "1.0.0",
  register(ctx) {
    ctx.registerTool({
      name: "echo_token",
      description: "Echo a token",
      inputSchema: { type: "object", properties: {} },
      handler: () => "token",
    });
  },
}`;

let cwd: string;
let requests: Record<string, unknown>[];

function sentinelPath(): string {
  return join(cwd, "entry.sentinel");
}

/** Write a native manifest `echo` whose entry file has `body` after a sentinel append. */
function echoManifest(entry: string | undefined, body: string): void {
  const dir = join(cwd, ".theokit", "plugins", "echo");
  mkdirSync(dir, { recursive: true });
  const entryLine = entry === undefined ? "" : `entry: ${entry}\n`;
  writeFileSync(
    join(dir, "PLUGIN.md"),
    `---\nname: echo\nversion: 1.0.0\n${entryLine}---\n\nEcho.\n`,
  );
  if (entry === undefined) return;
  const append = entry.endsWith(".cjs")
    ? `require("node:fs").appendFileSync(${JSON.stringify(sentinelPath())}, "x");`
    : `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(sentinelPath())}, "x");`;
  writeFileSync(join(dir, entry), `${append}\n${body}\n`);
}

function sseResponse(): Response {
  const records = [
    { choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } },
  ];
  const text = `${records.map((r) => `data: ${JSON.stringify(r)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function createAgent() {
  return Agent.create({
    apiKey: STUB_KEY,
    model: { id: "o4-mini" },
    providers: { routes: [{ capability: "chat", provider: "openai" }] },
    local: { cwd, settingSources: ["plugins"] },
  });
}

/** Create an agent, run one turn, and return the tool names the request carried. */
async function sentToolNames(): Promise<string[]> {
  const agent = await createAgent();
  try {
    const before = requests.length;
    const run = await agent.send("hi");
    await run.wait();
    const body = requests.slice(before).at(-1);
    expect(body, "the stub never received the chat request").toBeDefined();
    const tools = (body?.tools ?? []) as { function?: { name?: string } }[];
    return tools.map((t) => t.function?.name ?? "");
  } finally {
    await agent.dispose?.();
  }
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "theokit-manifest-entry-ws-"));
  requests = [];
  vi.stubEnv("THEOKIT_TRUSTED_PROVIDERS", "echo");
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (typeof init?.body === "string" && url.endsWith("/chat/completions")) {
      requests.push(JSON.parse(init.body) as Record<string, unknown>);
      return sseResponse();
    }
    return new Response(JSON.stringify({ error: { message: "not stubbed" } }), { status: 404 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  _resetDiscovery();
  // The manifest step keeps its once-per-folder diagnostic set under this key.
  globalSingleton("theokit-sdk.plugins.manifest-untrusted-warned", () => new Set<string>()).clear();
  rmSync(cwd, { recursive: true, force: true });
});

describe("a trusted workspace manifest plugin's entry is imported", () => {
  it("puts a trusted manifest plugin's tool in the run's tool list", async () => {
    echoManifest("index.mjs", `export default ${ECHO_PLUGIN};`);

    const names = await sentToolNames();

    expect(readFileSync(sentinelPath(), "utf8")).toHaveLength(1);
    expect(names).toContain("echo_token");
  });

  it("gives a second agent in the same process the tool while evaluating the module once", async () => {
    echoManifest("index.mjs", `export default ${ECHO_PLUGIN};`);

    const first = await sentToolNames();
    const second = await sentToolNames();

    expect(readFileSync(sentinelPath(), "utf8")).toHaveLength(1);
    expect(first).toContain("echo_token");
    expect(second).toContain("echo_token");
  });

  it("imports a trusted index.cjs entry exporting a general plugin through module.exports", async () => {
    echoManifest("index.cjs", `module.exports = ${ECHO_PLUGIN};`);

    const names = await sentToolNames();

    expect(names).toContain("echo_token");
  });

  it("lists a trusted manifest with no entry, adds no tool, and lets the run proceed", async () => {
    echoManifest(undefined, "");

    const names = await sentToolNames();
    const agent = await createAgent();
    const listed = ((await agent.plugins?.list()) ?? []).map((p) => p.name);
    await agent.dispose?.();

    expect(names).not.toContain("echo_token");
    expect(listed).toContain("echo");
  });
});

describe("a broken trusted entry fails Agent.create with a typed error", () => {
  it("refuses a default export that is not a general plugin with plugin_entry_shape", async () => {
    echoManifest("index.mjs", `export default { kind: "memory", name: "echo" };`);

    const error = await createAgent().then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(error).toMatchObject({ code: "plugin_entry_shape" });
    expect((error as Error).message).toContain("echo");
  });

  it("refuses a module with only a named register export with plugin_entry_shape", async () => {
    echoManifest("index.mjs", "export function register() {}");

    await expect(createAgent()).rejects.toMatchObject({ code: "plugin_entry_shape" });
  });

  it("refuses an entry that throws on import with plugin_entry_import_failed and the cause", async () => {
    echoManifest("index.mjs", 'throw new Error("boom");');

    const error = await createAgent().then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(error).toMatchObject({ code: "plugin_entry_import_failed", cause: { message: "boom" } });
    expect((error as Error).message).toContain("echo");
  });

  it("fails Agent.create with the error a trusted entry's register throws", async () => {
    echoManifest(
      "index.mjs",
      'export default { kind: "general", name: "echo", register() { throw new Error("register boom"); } };',
    );

    await expect(createAgent()).rejects.toThrow("register boom");
  });
});
