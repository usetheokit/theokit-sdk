/**
 * #1042 — `close()` marks the handle closed; `dispose()` still runs the session teardown (once).
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/internal/agent-loop/loop.js", () => ({
  runAgentLoop: vi.fn(async () => ({
    events: [],
    finalStatus: "completed",
    result: "ok",
    conversation: [],
  })),
}));

import { Agent } from "../src/agent.js";
import { AgentDisposedError } from "../src/errors.js";
import * as lifecycle from "../src/internal/local-agent/local-agent-lifecycle.js";
import { clearAgentRegistry } from "../src/internal/runtime/registry/agent-registry.js";
import { clearAllSessions } from "../src/internal/session/agent-session.js";

/** A stdio MCP server that records its PID to a file and stays alive until killed. */
const serverFor = (pidFile: string) => `
  require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  let buf = "";
  process.stdin.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } }) + "\\n");
    }
  });
`;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitDead(pid: number): Promise<boolean> {
  for (let i = 0; i < 100; i += 1) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe("#1042 close() then dispose()", () => {
  let root: string;
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    clearAgentRegistry();
    clearAllSessions();
    root = await mkdtemp(join(tmpdir(), "theokit-close-dispose-"));
    spy = vi.spyOn(lifecycle, "disposeLocalAgentSession");
  });

  afterEach(async () => {
    spy.mockRestore();
    clearAgentRegistry();
    clearAllSessions();
    await rm(root, { recursive: true, force: true });
  });

  async function create() {
    const pidFile = join(root, "pid");
    const agent = await Agent.create({
      apiKey: "sk-test-close-dispose",
      model: { id: "openai/gpt-4o-mini" },
      local: { cwd: root },
      mcpLifecycle: "session",
      mcpServers: { fx: { command: "node", args: ["-e", serverFor(pidFile)] } },
    });
    await (await agent.send("hi")).wait();
    const pid = Number(await readFile(pidFile, "utf8"));
    return { agent, pid };
  }

  it("close() then dispose() tears the session down once", async () => {
    const { agent, pid } = await create();
    expect(alive(pid)).toBe(true);
    agent.close();
    await agent.dispose();
    expect(await waitDead(pid)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("await using after close() also tears down", async () => {
    const pidFile = join(root, "pid");
    {
      await using agent = await Agent.create({
        apiKey: "sk-test-close-dispose",
        model: { id: "openai/gpt-4o-mini" },
        local: { cwd: root },
        mcpLifecycle: "session",
        mcpServers: { fx: { command: "node", args: ["-e", serverFor(pidFile)] } },
      });
      await (await agent.send("hi")).wait();
      agent.close();
    }
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(await waitDead(pid)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("dispose() twice runs the teardown once", async () => {
    const { agent, pid } = await create();
    await agent.dispose();
    await agent.dispose();
    expect(await waitDead(pid)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("send() after close() still rejects with AgentDisposedError", async () => {
    const { agent } = await create();
    agent.close();
    await expect(agent.send("again")).rejects.toBeInstanceOf(AgentDisposedError);
    await expect(agent.send("again")).rejects.toThrow(/has been disposed/);
    await agent.dispose();
  }, 30_000);
});
