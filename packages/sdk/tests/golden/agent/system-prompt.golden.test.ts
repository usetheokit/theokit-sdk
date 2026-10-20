import { mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { Agent } from "../../../src/index.js";
import { sseFrame } from "../../helpers/anthropic-sse.js";
import {
  removeTempDirRobust,
  removeTempDirRobustSync,
  useTempCwd,
} from "../../helpers/temp-workspace.js";

/**
 * B-412: a body for an Anthropic-family model carries `system` as text blocks, the configured
 * prompt first and cacheable, so an assertion about the prompt's text reads every block's text.
 * A string is returned as is.
 */
function systemText(system: unknown): string | undefined {
  if (system === undefined || typeof system === "string") return system;
  if (!Array.isArray(system)) throw new Error(`unexpected system shape: ${JSON.stringify(system)}`);
  return system.map((block: { text: string }) => block.text).join("\n\n");
}

/**
 * Behaviour gate for `AgentOptions.systemPrompt` and
 * `SendOptions.systemPrompt`. Stub provider endpoints capture the request
 * body so each priority path is asserted against the actual wire shape.
 */

interface Captured {
  body: Record<string, unknown> | undefined;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    req.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
    });
    req.on("end", () => resolve(buf));
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (typeof addr !== "object" || addr === null) throw new Error("bind failed");
  return `http://127.0.0.1:${addr.port}`;
}

async function startStubAnthropic(): Promise<{ server: Server; url: string; captured: Captured }> {
  const captured: Captured = { body: undefined };
  const server = createServer(async (req, res) => {
    if (req.url !== "/v1/messages") {
      res.statusCode = 404;
      res.end();
      return;
    }
    captured.body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream");
    const sse = (e: string, d: string): void => {
      res.write(sseFrame(e, d));
    };
    sse("message_start", "{}");
    sse(
      "content_block_delta",
      JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "ok" },
      }),
    );
    sse(
      "message_delta",
      JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    sse("message_stop", "{}");
    res.end();
  });
  return { server, url: await listen(server), captured };
}

async function startStubPaaS(): Promise<{ server: Server; url: string; captured: Captured }> {
  const captured: Captured = { body: undefined };
  const server = createServer(async (req, res) => {
    if (req.url === "/v1/agents" && req.method === "POST") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          agentId: "bc-stub-sp",
          model: { id: "google/gemini-2.0-flash-001" },
        }),
      );
      return;
    }
    if (!req.url?.startsWith("/v1/agents/")) {
      res.statusCode = 404;
      res.end();
      return;
    }
    captured.body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream");
    const send = (e: string, d: Record<string, unknown>): void => {
      res.write(sseFrame(e, JSON.stringify(d)));
    };
    send("status", { status: "CREATING" });
    send("assistant", { text: "ok" });
    send("result", { status: "finished", result: "ok" });
    res.end();
  });
  return { server, url: await listen(server), captured };
}

/**
 * A temp cwd, not `process.cwd()`.
 *
 * Two of the cases below pass `memory: { enabled: true }`, and with the process cwd that wrote five
 * real session files into `packages/sdk/.theokit/memory/sessions/` on every run. Nothing here reads
 * from the repository — the agent talks to a local http server started in this file — so the
 * process cwd bought nothing and cost residue that `.gitignore` kept out of every diff and every CI
 * log. Measured before the fix: 540 MB across the checkout. `vitest.global-setup.ts` now fails the
 * run if it comes back.
 */
const LOCAL_CWD = mkdtempSync(join(tmpdir(), "theokit-systemprompt-"));
afterAll(() => {
  removeTempDirRobustSync(LOCAL_CWD);
});

const localBase = {
  apiKey: "user-real-systemprompt",
  model: { id: "claude-sonnet-4-6" },
  local: { cwd: LOCAL_CWD },
} as const;

/**
 * A cloud agent has no local working directory, so these cases pass no `local.cwd` — but the agent
 * REGISTRY still lands under `process.cwd()`, which during a test run is `packages/sdk/` itself.
 * Measured 2026-09-01: this file wrote a real `.theokit/agents/registry.json` into the package tree
 * on every run, invisible to `git status` because `.gitignore` hides it.
 *
 * Passing a `local.cwd` to a cloud agent would be a lie about what the agent is; redirecting
 * `process.cwd()` for the file is the honest fix, and is why this helper exists.
 */
useTempCwd();

describe("systemPrompt routing", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server !== undefined) {
      await new Promise<void>((r) => server?.close(() => r()));
      server = undefined;
    }
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_BASE_URL;
    delete process.env.THEOKIT_API_BASE_URL;
  });

  async function withAnthropic(): Promise<Captured> {
    const stub = await startStubAnthropic();
    server = stub.server;
    process.env.ANTHROPIC_API_KEY = "sk-stub";
    process.env.ANTHROPIC_API_BASE_URL = stub.url;
    return stub.captured;
  }

  it("threads AgentOptions.systemPrompt (string) into the Anthropic body", async () => {
    const captured = await withAnthropic();
    const agent = await Agent.create({ ...localBase, systemPrompt: "Be terse." });
    await (await agent.send("hi")).wait();
    expect(systemText(captured.body?.system)).toBe("Be terse.");
    expect(Array.isArray(captured.body?.system)).toBe(true);
    const blocks = captured.body?.system as Array<{ cache_control?: unknown }>;
    expect(blocks[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("threads AgentOptions.systemPrompt (resolver) into the Anthropic body", async () => {
    const captured = await withAnthropic();
    const agent = await Agent.create({
      ...localBase,
      systemPrompt: async (ctx) => `Agent ${ctx.agentId}`,
    });
    await (await agent.send("hi")).wait();
    expect(systemText(captured.body?.system)).toMatch(/^Agent agent-/);
  });

  it("SendOptions.systemPrompt overrides AgentOptions.systemPrompt", async () => {
    const captured = await withAnthropic();
    const agent = await Agent.create({ ...localBase, systemPrompt: "A" });
    await (await agent.send("hi", { systemPrompt: "B" })).wait();
    expect(systemText(captured.body?.system)).toBe("B");
  });

  it("omits `system` from the body when neither is set", async () => {
    const captured = await withAnthropic();
    const agent = await Agent.create({ ...localBase });
    await (await agent.send("hi")).wait();
    expect("system" in (captured.body ?? {})).toBe(false);
  });

  it("injects loaded context as a <context> block when context manager is active", async () => {
    const captured = await withAnthropic();
    const cwd = await mkdtemp(join(tmpdir(), "theokit-ctx-inj-"));
    const __cwdCleanup1 = cwd;
    onTestFinished(async () => {
      await removeTempDirRobust(__cwdCleanup1);
    });
    await mkdir(join(cwd, ".theokit"), { recursive: true });
    await writeFile(join(cwd, "facts.md"), "The magic-number is 8675309.\n");
    await writeFile(
      join(cwd, ".theokit", "context.json"),
      JSON.stringify({ sources: [{ name: "facts", path: "facts.md" }] }),
    );
    const agent = await Agent.create({
      apiKey: "user-real-ctx",
      model: { id: "claude-sonnet-4-6" },
      local: { cwd, settingSources: ["project"] },
      context: { manager: "file" },
    });
    await (await agent.send("hi")).wait();
    const system = systemText(captured.body?.system);
    expect(system).toBeDefined();
    expect(system).toContain("<context>");
    expect(system).toContain("8675309");
  });

  it("injects loaded skills as a <skills> block", async () => {
    const captured = await withAnthropic();
    const cwd = await mkdtemp(join(tmpdir(), "theokit-skills-inj-"));
    const __cwdCleanup2 = cwd;
    onTestFinished(async () => {
      await removeTempDirRobust(__cwdCleanup2);
    });
    await mkdir(join(cwd, ".theokit", "skills", "code-review"), { recursive: true });
    await mkdir(join(cwd, ".theokit", "skills", "doc-writer"), { recursive: true });
    await writeFile(
      join(cwd, ".theokit", "skills", "code-review", "SKILL.md"),
      `---\nname: code-review\ndescription: Review TS diffs for type safety\n---\n\nBody`,
    );
    await writeFile(
      join(cwd, ".theokit", "skills", "doc-writer", "SKILL.md"),
      `---\nname: doc-writer\ndescription: Produce concise developer docs\n---\n\nBody`,
    );
    const agent = await Agent.create({
      apiKey: "user-real-skills",
      model: { id: "claude-sonnet-4-6" },
      local: { cwd, settingSources: ["project"] },
    });
    await (await agent.send("hi")).wait();
    const system = systemText(captured.body?.system);
    expect(system).toContain("<skills>");
    expect(system).toContain("code-review:");
    expect(system).toContain("doc-writer:");
  });

  it("places <skills> before the resolver-produced base prompt", async () => {
    const captured = await withAnthropic();
    const cwd = await mkdtemp(join(tmpdir(), "theokit-skills-resolver-"));
    const __cwdCleanup3 = cwd;
    onTestFinished(async () => {
      await removeTempDirRobust(__cwdCleanup3);
    });
    await mkdir(join(cwd, ".theokit", "skills", "doc-writer"), { recursive: true });
    await writeFile(
      join(cwd, ".theokit", "skills", "doc-writer", "SKILL.md"),
      `---\nname: doc-writer\ndescription: docs\n---\n\nBody`,
    );
    const agent = await Agent.create({
      apiKey: "user-real-skills-resolver",
      model: { id: "claude-sonnet-4-6" },
      local: { cwd, settingSources: ["project"] },
      systemPrompt: "Be terse.",
    });
    await (await agent.send("hi")).wait();
    const system = systemText(captured.body?.system) ?? "";
    const skillsIdx = system.indexOf("<skills>");
    const baseIdx = system.indexOf("Be terse.");
    expect(skillsIdx).toBeGreaterThanOrEqual(0);
    expect(baseIdx).toBeGreaterThan(skillsIdx);
  });

  it("injects persisted memory facts as a <memory> block", async () => {
    const captured = await withAnthropic();
    const cwd = await mkdtemp(join(tmpdir(), "theokit-mem-inj-"));
    const __cwdCleanup4 = cwd;
    onTestFinished(async () => {
      await removeTempDirRobust(__cwdCleanup4);
    });
    await mkdir(join(cwd, ".theokit", "memory", "default"), { recursive: true });
    await writeFile(
      join(cwd, ".theokit", "memory", "default", "agent-default.json"),
      JSON.stringify({ facts: [{ text: "Magic-number is 8675309." }] }),
    );
    const agent = await Agent.create({
      apiKey: "user-real-memory",
      model: { id: "claude-sonnet-4-6" },
      local: { cwd, settingSources: ["project"] },
      memory: { enabled: true },
    });
    await (await agent.send("what's the number?")).wait();
    const system = systemText(captured.body?.system);
    expect(system).toContain("<memory>");
    expect(system).toContain("8675309");
  });

  it("recovers from a corrupt memory file with no memory block (EC-4)", async () => {
    const captured = await withAnthropic();
    const cwd = await mkdtemp(join(tmpdir(), "theokit-mem-corrupt-"));
    const __cwdCleanup5 = cwd;
    onTestFinished(async () => {
      await removeTempDirRobust(__cwdCleanup5);
    });
    await mkdir(join(cwd, ".theokit", "memory", "default"), { recursive: true });
    await writeFile(
      join(cwd, ".theokit", "memory", "default", "agent-default.json"),
      "{not valid json",
    );
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const agent = await Agent.create({
      apiKey: "user-real-memory-corrupt",
      model: { id: "claude-sonnet-4-6" },
      local: { cwd, settingSources: ["project"] },
      memory: { enabled: true },
    });
    const result = await (await agent.send("hi")).wait();
    expect(result.status).toBe("finished");
    const system = systemText(captured.body?.system);
    expect(system === undefined || !system.includes("<memory>")).toBe(true);
    stderr.mockRestore();
  });

  it("omits system when no context AND no resolved base prompt", async () => {
    const captured = await withAnthropic();
    const agent = await Agent.create({ ...localBase });
    await (await agent.send("hi")).wait();
    expect("system" in (captured.body ?? {})).toBe(false);
  });

  it("includes systemPrompt in the cloud Run POST body (EC-1 / ADR D7)", async () => {
    const stub = await startStubPaaS();
    server = stub.server;
    process.env.THEOKIT_API_BASE_URL = stub.url;
    const agent = await Agent.create({
      apiKey: "user-real-cloud-systemprompt",
      model: { id: "google/gemini-2.0-flash-001" },
      cloud: { repos: [{ url: "https://github.com/usetheo/example" }] },
      systemPrompt: "Cloud agent persona.",
    });
    await (await agent.send("hello cloud")).wait();
    expect(stub.captured.body?.systemPrompt).toBe("Cloud agent persona.");
  });
});
