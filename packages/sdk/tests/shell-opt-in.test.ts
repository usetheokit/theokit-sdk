/**
 * usetheokit/theokit-sdk#1117 — the builtin `shell` tool is opt-in.
 *
 * Observed on the Anthropic wire stub: what the provider receives is what the model is offered.
 */
import { mkdtemp } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { Agent } from "../src/index.js";
import type { AgentOptions } from "../src/types/agent.js";
import {
  blockStop,
  messageDelta,
  sseFrame,
  textBlockStart,
  textDelta,
  toolBlockStart,
  toolInputDelta,
} from "./helpers/anthropic-sse.js";
import { removeTempDirRobust } from "./helpers/temp-workspace.js";

type Body = { tools?: Array<{ name: string }>; messages?: unknown[] };

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    req.on("data", (c: Buffer) => {
      buf += c.toString("utf8");
    });
    req.on("end", () => resolve(buf));
  });
}

/** Round 1 calls `shell` with `command` when given; every other round says "done". */
async function startStub(
  command?: string,
): Promise<{ server: Server; url: string; bodies: Body[] }> {
  const bodies: Body[] = [];
  const server = createServer(async (req, res) => {
    bodies.push(JSON.parse(await readBody(req)));
    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream");
    res.write(sseFrame("message_start", "{}"));
    if (command !== undefined && bodies.length === 1) {
      res.write(toolBlockStart("tu-1", "shell"));
      res.write(toolInputDelta(JSON.stringify({ command })));
      res.write(blockStop());
      res.write(messageDelta("tool_use", { input_tokens: 1, output_tokens: 1 }));
    } else {
      res.write(textBlockStart());
      res.write(textDelta("done"));
      res.write(blockStop());
      res.write(messageDelta("end_turn", { input_tokens: 1, output_tokens: 1 }));
    }
    res.write(sseFrame("message_stop", "{}"));
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (typeof addr !== "object" || addr === null) throw new Error("bind failed");
  return { server, url: `http://127.0.0.1:${addr.port}`, bodies };
}

describe("builtin shell is opt-in (#1117)", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server !== undefined) await new Promise<void>((r) => server?.close(() => r()));
    server = undefined;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_BASE_URL;
  });

  async function run(extra: Partial<AgentOptions>, command?: string): Promise<Body[]> {
    const cwd = await mkdtemp(join(tmpdir(), "theokit-shell-opt-in-"));
    onTestFinished(async () => {
      await removeTempDirRobust(cwd);
    });
    const stub = await startStub(command);
    server = stub.server;
    process.env.ANTHROPIC_API_KEY = "sk-stub";
    process.env.ANTHROPIC_API_BASE_URL = stub.url;
    const agent = await Agent.create({
      apiKey: "user-shell-opt-in",
      model: { id: "claude-sonnet-4-6" },
      local: { cwd, settingSources: [], ...(extra.local ?? {}) },
      ...extra,
    } as AgentOptions);
    await (await agent.send("go")).wait();
    return stub.bodies;
  }

  const names = (b: Body | undefined): string[] => (b?.tools ?? []).map((t) => t.name);

  it("offers no shell to a local agent with no tool options", async () => {
    const bodies = await run({});
    expect(names(bodies[0])).not.toContain("shell");
  });

  it("offers and runs shell when the app opts in", async () => {
    const bodies = await run({ builtinTools: ["shell"] }, "echo opted-in-marker");
    expect(names(bodies[0])).toContain("shell");
    expect(JSON.stringify(bodies[1]?.messages)).toContain("opted-in-marker");
  });

  it("honours local.sandboxOptions on the opt-in path", async () => {
    const bodies = await run(
      { builtinTools: ["shell"], local: { sandboxOptions: { enabled: true } } },
      "rm -rf /etc/passwd",
    );
    expect(names(bodies[0])).toContain("shell");
    expect(JSON.stringify(bodies[1]?.messages)).toContain("Sandbox refused");
  });

  it("keeps withholding ahead of the opt-in", async () => {
    const bodies = await run({ builtinTools: ["shell"], withheldBuiltinTools: ["shell"] });
    expect(names(bodies[0])).not.toContain("shell");
  });
});
