/**
 * `agent.send(message, { toolDecisions })`: resume tool calls a permission gate deferred, including
 * after a restart (the pending calls come from the stored transcript).
 *
 * Hermetic: a local chat-completions endpoint asks for tools, then answers once results arrive.
 */

import { appendFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Agent,
  type AgentOptions,
  ConfigurationError,
  PermissionEngine,
  type PermissionGate,
  PermissionPlugin,
  type Run,
  type ToolCallDecision,
} from "../src/index.js";
import { invalidateSessionCache } from "../src/internal/session/session-cache.js";
import { useTempCwd } from "./helpers/temp-workspace.js";

useTempCwd("theokit-tool-resume-");

const KEY = "sk-or-stub-0000000000";
const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

interface Stub {
  server: Server;
  bodies: Array<{ messages: Array<{ role: string; content?: unknown; tool_call_id?: string }> }>;
}

/** First request of a turn asks for `risky` + `safe`; once a tool message is present it answers. */
async function startStub(): Promise<Stub> {
  const stub: Stub = { server: undefined as unknown as Server, bodies: [] };
  stub.server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += String(c);
    });
    req.on("end", () => {
      const body = JSON.parse(raw) as Stub["bodies"][number];
      stub.bodies.push(body);
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      const last = body.messages[body.messages.length - 1];
      if (last?.role === "tool") {
        res.write(
          sse({ choices: [{ index: 0, delta: { content: "all done" }, finish_reason: null }] }),
        );
        res.write(sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
      } else if (last?.role === "user" && String(JSON.stringify(last.content)).includes("go")) {
        const call = (index: number, id: string, name: string) => ({
          index,
          id,
          type: "function",
          function: { name, arguments: "{}" },
        });
        res.write(
          sse({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [call(0, "call_risky", "risky"), call(1, "call_safe", "safe")],
                },
                finish_reason: null,
              },
            ],
          }),
        );
        res.write(sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
      } else {
        res.write(sse({ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] }));
        res.write(sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
      }
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => stub.server.listen(0, "127.0.0.1", () => r()));
  return stub;
}

describe("agent.send with toolDecisions", () => {
  let stub: Stub;
  let home: string;
  let ran: string[];
  let counter = 0;
  const previousHome = process.env.THEOKIT_HOME;

  beforeEach(async () => {
    stub = await startStub();
    const addr = stub.server.address();
    if (typeof addr !== "object" || addr === null) throw new Error("bind failed");
    process.env.OPENROUTER_API_KEY = KEY;
    process.env.OPENROUTER_API_BASE_URL = `http://127.0.0.1:${String(addr.port)}`;
    home = await mkdtemp(join(tmpdir(), "theokit-resume-home-"));
    process.env.THEOKIT_HOME = home;
    ran = [];
  });
  afterEach(async () => {
    await new Promise<void>((r) => stub.server.close(() => r()));
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_BASE_URL;
    if (previousHome === undefined) delete process.env.THEOKIT_HOME;
    else process.env.THEOKIT_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });

  function create(
    agentId: string,
    opts: {
      rules?: ConstructorParameters<typeof PermissionEngine>[0];
      gate?: PermissionGate;
      resume?: boolean;
    } = {},
  ) {
    const engine = new PermissionEngine(
      opts.rules ?? [
        { tool: "risky", action: "ask" },
        { tool: "safe", action: "allow" },
      ],
    );
    const tool = (name: string) => ({
      name,
      description: name,
      inputSchema: { type: "object" },
      handler: () => {
        ran.push(name);
        return `result-of-${name}`;
      },
    });
    const options: Partial<AgentOptions> = {
      apiKey: KEY,
      model: { id: "stub/model" },
      providers: { routes: [{ capability: "chat", provider: "openrouter" }] },
      local: { cwd: process.cwd() },
      tools: [tool("risky"), tool("safe")],
      plugins: [
        PermissionPlugin.create(engine, {
          canUseTool: opts.gate ?? (() => ({ behavior: "defer", reason: "ask a person" })),
        }),
      ],
    };
    return opts.resume === true
      ? Agent.resume(agentId, options)
      : Agent.create({ agentId, ...options } as AgentOptions);
  }

  const newId = (): string =>
    `resume-${String(++counter)}-${Math.random().toString(36).slice(2, 8)}`;

  async function pauseAndRestart(id: string) {
    const first = await create(id);
    const paused = await (await first.send("go")).wait();
    await first.dispose();
    invalidateSessionCache(process.cwd(), id);
    return { paused, restarted: await create(id, { resume: true }) };
  }

  const decide = (...d: Array<[string, "allow" | "deny", string?]>): ToolCallDecision[] =>
    d.map(([toolUseId, behavior, message]) => ({
      toolUseId,
      behavior,
      ...(message !== undefined ? { message } : {}),
    }));

  const waitOf = async (run: Run) => run.wait();

  it("resumes an allowed call after a restart and the session continues", async () => {
    const id = newId();
    const { paused, restarted } = await pauseAndRestart(id);
    expect(paused.status).toBe("deferred");
    expect(paused.deferredToolCalls?.map((c) => c.toolUseId)).toEqual(["call_risky"]);
    expect(ran).toEqual(["safe"]);
    try {
      const result = await waitOf(
        await restarted.send("", { toolDecisions: decide(["call_risky", "allow"]) }),
      );
      expect(result.status).toBe("finished");
      expect(result.result).toContain("all done");
      expect(ran).toEqual(["safe", "risky"]);
      const toolMessages = stub.bodies.at(-1)?.messages.filter((m) => m.role === "tool") ?? [];
      expect(toolMessages.map((m) => m.tool_call_id).sort()).toEqual(["call_risky", "call_safe"]);
      // The lock is free and the session is not blocked: a later send runs normally.
      const next = await waitOf(await restarted.send("hello again"));
      expect(next.status).toBe("finished");
    } finally {
      await restarted.dispose();
    }
  });

  it("writes an error result for a denied call without running it", async () => {
    const id = newId();
    const { restarted } = await pauseAndRestart(id);
    try {
      const result = await waitOf(
        await restarted.send("", { toolDecisions: decide(["call_risky", "deny", "not today"]) }),
      );
      expect(result.status).toBe("finished");
      expect(ran).toEqual(["safe"]);
      const denied = stub.bodies.at(-1)?.messages.find((m) => m.tool_call_id === "call_risky");
      expect(JSON.stringify(denied?.content)).toContain("not today");
    } finally {
      await restarted.dispose();
    }
  });

  it("does not let an approval override a rule that now denies the call", async () => {
    const id = newId();
    const first = await create(id);
    await (await first.send("go")).wait();
    await first.dispose();
    invalidateSessionCache(process.cwd(), id);
    const restarted = await create(id, {
      rules: [{ tool: "risky", action: "deny" }],
      resume: true,
    });
    try {
      const result = await waitOf(
        await restarted.send("", { toolDecisions: decide(["call_risky", "allow"]) }),
      );
      expect(result.status).toBe("finished");
      expect(ran).toEqual(["safe"]);
      const blocked = stub.bodies.at(-1)?.messages.find((m) => m.tool_call_id === "call_risky");
      expect(JSON.stringify(blocked?.content)).toContain("denied by permission engine");
    } finally {
      await restarted.dispose();
    }
  });

  it("rejects unknown, duplicate and missing decisions and leaves the session unchanged", async () => {
    const id = newId();
    const { restarted } = await pauseAndRestart(id);
    try {
      const requests = stub.bodies.length;
      const codeOf = async (decisions: ToolCallDecision[]) => {
        const err = await restarted.send("", { toolDecisions: decisions }).catch((e) => e);
        expect(err).toBeInstanceOf(ConfigurationError);
        return (err as ConfigurationError).code;
      };
      expect(await codeOf(decide(["call_risky", "allow"], ["nope", "allow"]))).toBe(
        "tool_decision_unknown",
      );
      expect(await codeOf(decide(["call_risky", "allow"], ["call_risky", "deny"]))).toBe(
        "tool_decision_duplicate",
      );
      expect(await codeOf([])).toBe("tool_decision_missing");
      expect(stub.bodies.length).toBe(requests);
      // The pending call is still there to be answered.
      const result = await waitOf(
        await restarted.send("", { toolDecisions: decide(["call_risky", "allow"]) }),
      );
      expect(result.status).toBe("finished");
    } finally {
      await restarted.dispose();
    }
  });

  it("rejects a stored call with an unsupported schema version and a send with nothing pending", async () => {
    const id = newId();
    const fresh = await create(id);
    const err = await fresh.send("", { toolDecisions: decide(["x", "allow"]) }).catch((e) => e);
    expect((err as ConfigurationError).code).toBe("no_deferred_tool_calls");
    await fresh.dispose();

    const other = newId();
    const { restarted } = await pauseAndRestart(other);
    try {
      const file = await findTranscript(home);
      await appendFile(
        file,
        `${JSON.stringify({
          type: "system",
          subtype: "deferred_tool_calls",
          uuid: "11111111-1111-4111-8111-111111111111",
          parentUuid: await lastUuid(file, "11111111-1111-4111-8111-111111111111"),
          sessionId: "s",
          timestamp: new Date().toISOString(),
          deferredToolCalls: [{ toolUseId: "call_risky", schemaVersion: 2 }],
        })}\n`,
      );
      const bad = await restarted
        .send("", { toolDecisions: decide(["call_risky", "allow"]) })
        .catch((e) => e);
      expect((bad as ConfigurationError).code).toBe("deferred_schema_unsupported");
    } finally {
      await restarted.dispose();
    }
  });

  it("does not block the session when a deferred call is never resumed", async () => {
    const id = newId();
    const { restarted } = await pauseAndRestart(id);
    try {
      const requests = stub.bodies.length;
      const result = await waitOf(await restarted.send("hello"));
      expect(result.status).toBe("finished");
      // The history sent to the provider holds no unanswered tool call.
      const sent = JSON.stringify(stub.bodies.slice(requests).map((b) => b.messages));
      expect(sent).not.toContain("call_risky");
    } finally {
      await restarted.dispose();
    }
  });
});

async function findTranscript(root: string): Promise<string> {
  const files = (await readdir(root, { recursive: true })).filter((f) => f.endsWith(".jsonl"));
  for (const f of files) {
    if ((await readFile(join(root, f), "utf8")).includes("call_risky")) return join(root, f);
  }
  throw new Error("transcript not found");
}

async function lastUuid(file: string, exclude: string): Promise<string> {
  const lines = (await readFile(file, "utf8")).trim().split("\n");
  const uuids = lines
    .map((l) => (JSON.parse(l) as { uuid: string }).uuid)
    .filter((u) => u !== exclude);
  return uuids[uuids.length - 1] as string;
}
