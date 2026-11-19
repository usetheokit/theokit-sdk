/**
 * `MemorySettings.mirror` — write-through of built-in facts to memory adapters, and
 * adapters-first recall into the `<memory>` block. Uses a stub Anthropic server that captures the
 * system prompt, and a fake `kind: "memory"` plugin.
 */
import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "../../src/index.js";
import { setDiagnosticsSink } from "../../src/internal/diagnostics.js";
import { Plugin } from "../../src/internal/plugins/types.js";
import { mkMemoryId } from "../../src/memory-adapter-helpers.js";
import type { AgentOptions } from "../../src/types/agent.js";
import type { MemoryAdapter, MemoryContext } from "../../src/types/memory-adapter.js";
import { messageDelta, sseFrame } from "../helpers/anthropic-sse.js";
import { useTempCwd } from "../helpers/temp-workspace.js";

useTempCwd();

interface Stub {
  server: Server;
  systems: string[];
}

function startStub(): Promise<Stub> {
  const systems: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body) as { system?: unknown };
        systems.push(JSON.stringify(parsed.system ?? ""));
      } catch {
        systems.push("");
      }
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      res.write(sseFrame("message_start", "{}"));
      res.write(
        sseFrame(
          "content_block_delta",
          JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "ok" },
          }),
        ),
      );
      res.write(messageDelta("end_turn", { input_tokens: 5, output_tokens: 1 }));
      res.write(sseFrame("message_stop", "{}"));
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      if (typeof a !== "object" || a === null) throw new Error("bind failed");
      process.env.ANTHROPIC_API_KEY = "sk-stub";
      process.env.ANTHROPIC_API_BASE_URL = `http://127.0.0.1:${a.port}`;
      resolve({ server, systems });
    });
  });
}

interface Fake {
  adapter: MemoryAdapter;
  writes: Array<{ content: unknown; ctx: MemoryContext }>;
}

function fakeAdapter(
  opts: { id?: string; facts?: string[]; writeFails?: boolean; recallFails?: boolean } = {},
): Fake {
  const id = opts.id ?? "fake";
  const writes: Fake["writes"] = [];
  const adapter: MemoryAdapter = {
    id,
    capabilities: {
      history: false,
      sessions: false,
      tenancy: false,
      reasoning: false,
      toolSchemas: false,
      prefetch: false,
    },
    isAvailable: () => true,
    write: async (content, ctx) => {
      if (opts.writeFails) throw new Error("remote down");
      writes.push({ content, ctx });
      return mkMemoryId(id, String(writes.length));
    },
    recall: async () => {
      if (opts.recallFails) throw new Error("recall down");
      return (opts.facts ?? []).map((content, i) => ({ id: mkMemoryId(id, String(i)), content }));
    },
    delete: async () => {},
  };
  return { adapter, writes };
}

function plugins(f: Fake): AgentOptions["plugins"] {
  return [
    Plugin.create({
      name: "fake-mem",
      version: "1.0.0",
      kind: "memory",
      createProvider: () => f.adapter,
    }),
  ] as unknown as AgentOptions["plugins"];
}

describe("memory.mirror", () => {
  let stub: Stub | undefined;
  afterEach(async () => {
    setDiagnosticsSink(undefined);
    if (stub !== undefined) await new Promise<void>((r) => stub?.server.close(() => r()));
    stub = undefined;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_BASE_URL;
  });

  async function make(f: Fake, mirror: object, extra: Partial<AgentOptions> = {}) {
    stub = await startStub();
    return Agent.create({
      apiKey: "real-not-fixture",
      model: { id: "claude-sonnet-4-6" },
      memory: { enabled: true, userId: "alice", mirror } as AgentOptions["memory"],
      plugins: plugins(f),
      ...extra,
    });
  }

  it("writes a saved fact once to the adapter with memory.userId", async () => {
    const f = fakeAdapter();
    const agent = await make(f, {});
    const run = await agent.send("Remember: likes tea");
    await run.wait();
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]?.content).toBe("likes tea");
    expect(f.writes[0]?.ctx.userId).toBe("alice");
    await agent.dispose();
  });

  it("does not write when write is false", async () => {
    const f = fakeAdapter();
    const agent = await make(f, { write: false });
    await (await agent.send("Remember: likes tea")).wait();
    expect(f.writes).toHaveLength(0);
    await agent.dispose();
  });

  it("adapters-first shows adapter facts in the <memory> block", async () => {
    const f = fakeAdapter({ facts: ["remote fact zebra"] });
    const agent = await make(f, { recall: "adapters-first" });
    await (await agent.send("what do you know?")).wait();
    expect(stub?.systems.join("\n")).toContain("remote fact zebra");
    await agent.dispose();
  });

  it("adapters-first falls back to local facts when the adapter throws", async () => {
    const f = fakeAdapter({ recallFails: true });
    const agent = await make(f, { recall: "adapters-first", write: false });
    await (await agent.send("Remember: local fact giraffe")).wait();
    await (await agent.send("what do you know?")).wait();
    expect(stub?.systems.at(-1)).toContain("local fact giraffe");
    await agent.dispose();
  });

  it("a rejecting adapter write keeps the local fact, finishes the run and names the adapter", async () => {
    const lines: string[] = [];
    setDiagnosticsSink((m: string) => {
      lines.push(m);
    });
    const f = fakeAdapter({ id: "flaky", writeFails: true });
    const agent = await make(f, {});
    const result = await (await agent.send("Remember: local fact okapi")).wait();
    expect(result.status).toBe("finished");
    expect(lines.join("\n")).toContain('"flaky"');
    await (await agent.send("again")).wait();
    expect(stub?.systems.at(-1)).toContain("local fact okapi");
    await agent.dispose();
  });
});
