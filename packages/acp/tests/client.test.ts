import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpAgentSpawnError, connectAcpAgent } from "../src/client.js";
import { resolveCommand } from "../src/client-spawn.js";

const FIXTURE = join(import.meta.dirname, "fixtures", "fixture-agent.mjs");

let dir: string;
let logFile: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "acp-client-"));
  logFile = join(dir, "fixture.log");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const allow = async (
  _req: acp.RequestPermissionRequest,
): Promise<acp.RequestPermissionResponse> => ({
  outcome: { outcome: "selected", optionId: "allow" },
});

function connect(
  mode: string,
  extra: Partial<Parameters<typeof connectAcpAgent>[0]> = {},
): ReturnType<typeof connectAcpAgent> {
  return connectAcpAgent({
    command: process.execPath,
    args: [FIXTURE],
    cwd: dir,
    env: { FIXTURE_MODE: mode, FIXTURE_LOG: logFile },
    onPermission: allow,
    ...extra,
  });
}

const logLines = (): string[] => {
  try {
    return readFileSync(logFile, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

async function collectText(it: AsyncIterable<acp.SessionNotification>): Promise<string[]> {
  const out: string[] = [];
  for await (const n of it) {
    const u = n.update;
    if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") {
      out.push(u.content.text);
    }
  }
  return out;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("connectAcpAgent", () => {
  it("streams the fixture's message chunks and ends", async () => {
    const conn = await connect("chat");
    try {
      expect(await collectText(conn.prompt("hi"))).toEqual(["hello ", "world"]);
    } finally {
      await conn.close();
    }
  });

  it("routes a permission request to onPermission and delivers a reject", async () => {
    const onPermission = vi.fn(
      async (_req: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> => ({
        outcome: { outcome: "selected", optionId: "deny" },
      }),
    );
    const conn = await connect("perm", { onPermission });
    try {
      expect(await collectText(conn.prompt("go"))).toEqual(["blocked"]);
    } finally {
      await conn.close();
    }
    expect(onPermission).toHaveBeenCalledTimes(1);
    expect(onPermission.mock.calls[0]?.[0]).toMatchObject({ toolCall: { title: "danger_tool" } });
    expect(logLines().some((l) => l.startsWith("permission blocked"))).toBe(true);
  });

  it("sends session/cancel when the signal aborts", async () => {
    const conn = await connect("cancel");
    try {
      const ac = new AbortController();
      const seen: string[] = [];
      for await (const n of conn.prompt("long", ac.signal)) {
        if (n.update.sessionUpdate === "agent_message_chunk") {
          seen.push("chunk");
          ac.abort();
        }
      }
      expect(seen).toEqual(["chunk"]);
      expect(logLines()).toContain("session/cancel observed");
    } finally {
      await conn.close();
    }
  });

  it("close() leaves no child running", async () => {
    const conn = await connect("chat");
    const pid = Number(logLines()[0]?.split(" ")[1]);
    expect(alive(pid)).toBe(true);
    await conn.close();
    expect(alive(pid)).toBe(false);
  });

  it("rejects an overlapping prompt", async () => {
    const conn = await connect("cancel");
    try {
      const ac = new AbortController();
      const first = conn.prompt("a", ac.signal);
      expect(() => conn.prompt("b")).toThrow(/already running/);
      ac.abort();
      await collectText(first);
    } finally {
      await conn.close();
    }
  });

  it("ends the iterator with AcpAgentSpawnError when the child exits mid-prompt", async () => {
    const conn = await connect("exit-prompt");
    try {
      const err = await collectText(conn.prompt("x")).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AcpAgentSpawnError);
      expect((err as AcpAgentSpawnError).exitCode).toBe(7);
      expect((err as AcpAgentSpawnError).stderrTail).toContain("crashing mid-prompt");
    } finally {
      await conn.close();
    }
  });
});

describe("connectAcpAgent spawn refusals", () => {
  it.each([
    [".", "dot"],
    ["", "empty"],
    ["/usr/bin::/bin", "empty middle"],
  ])("refuses a bare command when PATH has a %s entry", async (pathValue) => {
    const err = await connectAcpAgent({
      command: "fixture-agent",
      cwd: dir,
      env: { PATH: pathValue, FIXTURE_LOG: logFile },
      onPermission: allow,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AcpAgentSpawnError);
    expect(logLines()).toEqual([]); // nothing was spawned
  });

  it("resolves an absolute match found before a relative PATH entry", () => {
    const node = resolveCommand("node", { PATH: `${path.dirname(process.execPath)}:.` });
    expect(path.isAbsolute(node)).toBe(true);
  });

  it("rejects a bare command that is not on an absolute PATH", async () => {
    await expect(
      connectAcpAgent({
        command: "no-such-agent-xyz",
        cwd: dir,
        env: { PATH: "/usr/bin" },
        onPermission: allow,
      }),
    ).rejects.toBeInstanceOf(AcpAgentSpawnError);
  });

  it("does not inherit process.env", async () => {
    process.env.ACP_CLIENT_LEAK = "1";
    try {
      const err = await connectAcpAgent({
        command: "node",
        cwd: dir,
        env: {},
        onPermission: allow,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AcpAgentSpawnError); // empty PATH is not borrowed from process.env
    } finally {
      delete process.env.ACP_CLIENT_LEAK;
    }
  });

  it("rejects with the exit code when the child exits during initialize", async () => {
    const err = await connect("exit-init").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AcpAgentSpawnError);
    expect((err as AcpAgentSpawnError).exitCode).toBe(3);
    expect((err as AcpAgentSpawnError).stderrTail).toContain("boom during startup");
  });
});
