import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AcpAgentConnection, AcpAgentSpawnError, connectAcpAgent } from "../src/client.js";

const FIXTURE = join(import.meta.dirname, "fixtures", "client-agent.mjs");
const reject: acp.RequestPermissionResponse = {
  outcome: { outcome: "selected", optionId: "deny" },
};

let dir: string;
let open: AcpAgentConnection[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "acp-client-"));
  open = [];
});
afterEach(async () => {
  await Promise.all(open.map((c) => c.close()));
  rmSync(dir, { recursive: true, force: true });
});

const logLines = (): string[] => {
  const file = join(dir, "log");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
};

async function connect(
  extraEnv: Record<string, string> = {},
  onPermission: (
    r: acp.RequestPermissionRequest,
  ) => Promise<acp.RequestPermissionResponse> = async () => reject,
): Promise<AcpAgentConnection> {
  const conn = await connectAcpAgent({
    command: process.execPath,
    args: [FIXTURE],
    cwd: dir,
    env: { FIXTURE_LOG: join(dir, "log"), ...extraEnv },
    onPermission,
  });
  open.push(conn);
  return conn;
}

async function collect(it: AsyncIterable<acp.SessionNotification>): Promise<string[]> {
  const out: string[] = [];
  for await (const n of it) {
    const u = n.update;
    if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text")
      out.push(u.content.text);
  }
  return out;
}

const pidOf = (): number =>
  Number(
    logLines()
      .find((l) => l.startsWith("pid "))
      ?.slice(4),
  );
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
    const conn = await connect();
    expect(await collect(conn.prompt("hi"))).toEqual(["hello", " world"]);
  });

  it("does not inherit process.env", async () => {
    vi.stubEnv("ACP_CLIENT_LEAK_CHECK", "1");
    await connect();
    vi.unstubAllEnvs();
    const envLine = logLines().find((l) => l.startsWith("env "));
    expect(envLine).not.toContain("ACP_CLIENT_LEAK_CHECK");
    expect(envLine).toContain("FIXTURE_LOG");
  });

  it("routes a permission request to onPermission and returns its answer", async () => {
    const onPermission = vi.fn(async () => reject);
    const conn = await connect({ FIXTURE_PERMISSION: "ask" }, onPermission);
    await collect(conn.prompt("ask"));
    expect(onPermission).toHaveBeenCalledTimes(1);
    const veto = logLines().find((l) => l.startsWith("veto "));
    expect(veto).toContain('"block":true');
    expect(veto).toContain("denied by user");
  });

  it("sends session/cancel when the signal aborts", async () => {
    const conn = await connect();
    const ac = new AbortController();
    const seen: string[] = [];
    for await (const n of conn.prompt("hang", ac.signal)) {
      seen.push(n.update.sessionUpdate);
      ac.abort();
    }
    expect(seen).toContain("agent_message_chunk");
    await vi.waitFor(() => expect(logLines()).toContain("cancel"));
  });

  it("close() leaves no child running", async () => {
    const conn = await connect();
    const pid = pidOf();
    expect(alive(pid)).toBe(true);
    await conn.close();
    expect(alive(pid)).toBe(false);
  });

  it("ends the iterator with AcpAgentSpawnError when the child dies mid-prompt", async () => {
    const conn = await connect();
    const err = await collect(conn.prompt("die")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AcpAgentSpawnError);
    expect((err as AcpAgentSpawnError).exitCode).toBe(9);
    expect((err as Error).message).toContain("fixture dying");
  });

  it("rejects overlapping prompts", async () => {
    const conn = await connect();
    const ac = new AbortController();
    const first = conn.prompt("hang", ac.signal)[Symbol.asyncIterator]();
    await first.next();
    await expect(conn.prompt("hi")[Symbol.asyncIterator]().next()).rejects.toThrow(
      /already running/,
    );
    ac.abort();
    await first.return?.();
  });
});

describe("connectAcpAgent refusals", () => {
  const base = { cwd: "/", onPermission: async () => reject };

  it.each([
    ".",
    "/usr/bin::/bin",
    "relative/dir",
  ])("refuses PATH %j before spawning", async (PATH) => {
    const err = await connectAcpAgent({
      ...base,
      command: "fixture-agent",
      env: { PATH },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AcpAgentSpawnError);
    expect((err as Error).message).toMatch(/empty or relative/);
  });

  it("refuses a relative command containing a separator", async () => {
    await expect(
      connectAcpAgent({ ...base, command: "./fixture-agent", env: { PATH: "/usr/bin" } }),
    ).rejects.toBeInstanceOf(AcpAgentSpawnError);
  });

  it("reports a command that is not on PATH", async () => {
    await expect(
      connectAcpAgent({ ...base, command: "no-such-agent-xyz", env: { PATH: "/usr/bin:/bin" } }),
    ).rejects.toThrow(/not found/);
  });

  it("rejects with the exit code when the child exits during initialize", async () => {
    const err = await connectAcpAgent({
      command: process.execPath,
      args: [FIXTURE],
      cwd: dir,
      env: { FIXTURE_EXIT_ON_INIT: "7" },
      onPermission: async () => reject,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AcpAgentSpawnError);
    expect((err as AcpAgentSpawnError).exitCode).toBe(7);
    expect((err as Error).message).toContain("fixture failed to boot");
  });
});
