import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent, ConfigurationError, ToolDecisionMismatchError } from "../src/index.js";
import { PermissionEngine } from "../src/permission-engine.js";
import { type PermissionGate, PermissionPlugin } from "../src/permission-plugin.js";
import { useTempCwd } from "./helpers/temp-workspace.js";

useTempCwd("theokit-defer-resume-");

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
) {
  return {
    apiKey: STUB_KEY,
    model: { id: "gpt-4o-mini" },
    providers: { routes: [{ capability: "chat" as const, provider: "openai" as const }] },
    local: { cwd: process.cwd(), sessionDir },
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

describe("resuming deferred tool calls", () => {
  it("resumes_a_deferred_call_after_a_restart", async () => {
    const { bodies } = stubModel();
    const dir = join(process.cwd(), "sessions");
    const ran: string[] = [];
    const { agent, result } = await deferRun(dir, ran);
    expect(result.status).toBe("deferred");
    expect(result.deferredToolCalls).toHaveLength(1);
    expect(result.deferredToolCalls?.[0]).toMatchObject({
      toolName: "risky",
      toolUseId: "call_1",
      input: { path: "a.txt" },
    });
    expect(ran).toEqual([]);
    const agentId = agent.agentId;
    await agent.dispose();

    const resumed = await Agent.resume(
      agentId,
      build(dir, ran, [{ tool: "risky", action: "ask" }]),
    );
    const out = await (
      await resumed.send(undefined, { toolDecisions: [{ toolUseId: "call_1", behavior: "allow" }] })
    ).wait();
    expect(out.status).toBe("finished");
    expect(ran).toEqual(["risky"]);
    const last = bodies.at(-1)?.messages ?? [];
    expect(JSON.stringify(last)).toContain("risky-done");
    // The pending call is answered: a plain send no longer throws.
    const next = await (await resumed.send("thanks")).wait();
    expect(next.status).toBe("finished");
    await resumed.dispose();
  });

  it("a_deny_rule_added_after_the_pause_wins_over_allow", async () => {
    const { bodies } = stubModel();
    const dir = join(process.cwd(), "sessions");
    const ran: string[] = [];
    const { agent } = await deferRun(dir, ran);
    const agentId = agent.agentId;
    await agent.dispose();

    const resumed = await Agent.resume(
      agentId,
      build(dir, ran, [{ tool: "risky", action: "deny" }]),
    );
    const out = await (
      await resumed.send(undefined, { toolDecisions: [{ toolUseId: "call_1", behavior: "allow" }] })
    ).wait();
    expect(out.status).toBe("finished");
    expect(ran).toEqual([]);
    expect(JSON.stringify(bodies.at(-1))).toContain("denied by permission engine");
    await resumed.dispose();
  });

  it("writes the host's message for a denied call", async () => {
    const { bodies } = stubModel();
    const dir = join(process.cwd(), "sessions");
    const ran: string[] = [];
    const { agent } = await deferRun(dir, ran);
    const out = await (
      await agent.send(undefined, {
        toolDecisions: [{ toolUseId: "call_1", behavior: "deny", message: "not today" }],
      })
    ).wait();
    expect(out.status).toBe("finished");
    expect(ran).toEqual([]);
    expect(JSON.stringify(bodies.at(-1))).toContain("not today");
    await agent.dispose();
  });

  it("decision_for_unknown_tool_use_is_refused", async () => {
    stubModel();
    const dir = join(process.cwd(), "sessions");
    const { agent } = await deferRun(dir, []);
    const attempt = agent.send(undefined, {
      toolDecisions: [{ toolUseId: "nope-9", behavior: "allow" }],
    });
    await expect(attempt).rejects.toBeInstanceOf(ToolDecisionMismatchError);
    await expect(
      agent.send(undefined, { toolDecisions: [{ toolUseId: "nope-9", behavior: "allow" }] }),
    ).rejects.toMatchObject({
      code: "tool_decision_mismatch",
      message: expect.stringContaining("nope-9"),
    });
    await agent.dispose();
  });

  it("a plain send on a deferred session is refused, not dropped", async () => {
    stubModel();
    const dir = join(process.cwd(), "sessions");
    const { agent } = await deferRun(dir, []);
    await expect(agent.send("hello")).rejects.toMatchObject({ code: "tool_decision_mismatch" });
    await agent.dispose();
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
    const decisions = [{ toolUseId: "call_1", behavior: "allow" as const }];
    await expect(resumed.send(undefined, { toolDecisions: decisions })).rejects.toBeInstanceOf(
      ConfigurationError,
    );
    await expect(resumed.send(undefined, { toolDecisions: decisions })).rejects.toMatchObject({
      code: "deferred_schema_unsupported",
    });
    expect(ran).toEqual([]);
    await resumed.dispose();
  });
});

async function findTranscript(root: string, agentId: string): Promise<string> {
  const { readdir } = await import("node:fs/promises");
  const walk = async (d: string): Promise<string[]> => {
    const out: string[] = [];
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) out.push(...(await walk(p)));
      else if (e.name.endsWith(".jsonl")) out.push(p);
    }
    return out;
  };
  const all = await walk(root);
  let hit: string | undefined;
  for (const f of all) {
    if ((await readFile(f, "utf8")).includes(`"sessionId":"${agentId}"`)) hit = f;
  }
  if (hit === undefined) throw new Error("no transcript");
  return hit;
}
