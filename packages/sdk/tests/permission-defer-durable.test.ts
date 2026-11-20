import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent, ConfigurationError } from "../src/index.js";
import { flushSessionWrites } from "../src/internal/session/index.js";
import { PermissionEngine } from "../src/permission-engine.js";
import { type PermissionGate, PermissionPlugin } from "../src/permission-plugin.js";
import { useTempCwd } from "./helpers/temp-workspace.js";

useTempCwd("theokit-defer-durable-");

const STUB_KEY = `sk-test-${"0".repeat(40)}`;

function sse(records: unknown[]): Response {
  const frames = records.map((r) => `data: ${JSON.stringify(r)}\n\n`);
  return new Response(`${frames.join("")}data: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** First chat call asks for the `risky` tool; every later call answers in text. */
function stubModel(): { bodies: Array<{ messages: Array<Record<string, unknown>> }> } {
  const seen: Array<{ messages: Array<Record<string, unknown>> }> = [];
  let calls = 0;
  vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
    seen.push(JSON.parse(String(init?.body)));
    calls += 1;
    if (calls === 1) {
      return sse([
        {
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: { name: "risky", arguments: '{"path":"a.txt"}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } },
      ]);
    }
    return sse([
      {
        choices: [
          { index: 0, delta: { role: "assistant", content: "all done" }, finish_reason: null },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } },
    ]);
  });
  return { bodies: seen };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const defer: PermissionGate = () => ({ behavior: "defer", reason: "ask a person" });

function build(
  sessionDir: string,
  ran: string[],
  rules: ConstructorParameters<typeof PermissionEngine>[0],
  sessionStore?: import("../src/types/session-store.js").SessionStore,
) {
  return {
    apiKey: STUB_KEY,
    model: { id: "gpt-4o-mini" },
    providers: { routes: [{ capability: "chat" as const, provider: "openai" as const }] },
    local: {
      cwd: process.cwd(),
      sessionDir,
      ...(sessionStore !== undefined ? { sessionStore } : {}),
    },
    plugins: [PermissionPlugin.create(new PermissionEngine(rules), { canUseTool: defer })],
    tools: [
      {
        name: "risky",
        description: "risky tool",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
        handler: () => {
          ran.push("risky");
          return "risky-done";
        },
      },
    ],
  };
}

async function deferRun(sessionDir: string, ran: string[]) {
  const agent = await Agent.create(build(sessionDir, ran, [{ tool: "risky", action: "ask" }]));
  const result = await (await agent.send("do it")).wait();
  return { agent, result };
}

async function findTranscript(root: string, agentId: string): Promise<string> {
  const walk = async (d: string): Promise<string[]> => {
    const out: string[] = [];
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) out.push(...(await walk(p)));
      else if (e.name.endsWith(".jsonl")) out.push(p);
    }
    return out;
  };
  for (const f of await walk(root)) {
    if ((await readFile(f, "utf8")).includes(`"sessionId":"${agentId}"`)) return f;
  }
  throw new Error("no transcript");
}

describe("a deferred run leaves the unanswered call in the transcript", () => {
  it("has the unanswered tool_use on disk when the run is deferred", async () => {
    stubModel();
    const dir = join(process.cwd(), "sessions");
    const ran: string[] = [];
    const { agent, result } = await deferRun(dir, ran);
    expect(result.status).toBe("deferred");
    expect(ran).toEqual([]);
    await agent.dispose();
    await flushSessionWrites();
    const text = await readFile(await findTranscript(dir, agent.agentId), "utf8");
    expect(text).toContain('"id":"call_1"');
    expect(text).toContain('"deferred_tool_calls"');
  });
});

describe("a session that ends on deferred calls", () => {
  it("refuses a plain send, on the same agent and after a restart", async () => {
    stubModel();
    const dir = join(process.cwd(), "sessions");
    const ran: string[] = [];
    const { agent } = await deferRun(dir, ran);
    await expect(agent.send("hello")).rejects.toMatchObject({ code: "tool_decision_mismatch" });
    const agentId = agent.agentId;
    await agent.dispose();
    const resumed = await Agent.resume(
      agentId,
      build(dir, ran, [{ tool: "risky", action: "ask" }]),
    );
    await expect(resumed.send("hello")).rejects.toMatchObject({
      code: "tool_decision_mismatch",
      message: expect.stringContaining("call_1"),
    });
    expect(ran).toEqual([]);
    await resumed.dispose();
  });

  it("unknown_deferred_schema_version_is_refused", async () => {
    stubModel();
    const dir = join(process.cwd(), "sessions");
    const ran: string[] = [];
    const { agent } = await deferRun(dir, ran);
    const agentId = agent.agentId;
    await agent.dispose();
    const file = await findTranscript(dir, agentId);
    const text = await readFile(file, "utf8");
    expect(text).toContain('"schemaVersion":1');
    await writeFile(file, text.replace('"schemaVersion":1', '"schemaVersion":99'));
    const resumed = await Agent.resume(
      agentId,
      build(dir, ran, [{ tool: "risky", action: "ask" }]),
    );
    await expect(resumed.send("hello")).rejects.toBeInstanceOf(ConfigurationError);
    await expect(resumed.send("hello")).rejects.toMatchObject({
      code: "deferred_schema_unsupported",
    });
    expect(ran).toEqual([]);
    await resumed.dispose();
  });
});
