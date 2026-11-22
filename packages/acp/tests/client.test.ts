import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AcpAgentConnection, AcpAgentSpawnError, connectAcpAgent } from "../src/client.js";

const FIXTURE = join(import.meta.dirname, "fixtures", "client-agent.mjs");
const reject: (r: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse> =
  async () => ({ outcome: { outcome: "selected", optionId: "deny" } });

let dir: string;
let logFile: string;
const open: AcpAgentConnection[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "acp-client-"));
  logFile = join(dir, "fixture.log");
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()));
  rmSync(dir, { recursive: true, force: true });
});

async function connect(
  onPermission = reject,
  extra: { args?: string[] } = {},
): Promise<AcpAgentConnection> {
  const c = await connectAcpAgent({
    command: process.execPath,
    args: extra.args ?? [FIXTURE],
    cwd: dir,
    env: { FIXTURE_LOG: logFile },
    onPermission,
  });
  open.push(c);
  return c;
}

const texts = async (it: AsyncIterable<acp.SessionNotification>): Promise<string[]> => {
  const out: string[] = [];
  for await (const n of it) {
    const u = n.update;
    if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text")
      out.push(u.content.text);
  }
  return out;
};

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
    const c = await connect();
    expect(await texts(c.prompt("hi"))).toEqual(["hello ", "world"]);
  });

  it("routes a permission request to onPermission and returns the answer", async () => {
    const seen: acp.RequestPermissionRequest[] = [];
    const c = await connect(async (r) => {
      seen.push(r);
      return reject(r);
    });
    expect(await texts(c.prompt("tool"))).toEqual(["blocked: denied by user"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.toolCall.title).toBe("danger");
    expect(readFileSync(logFile, "utf8")).toContain("denied by user");
  });

  it("sends session/cancel when the signal aborts", async () => {
    const c = await connect();
    const ac = new AbortController();
    const got: string[] = [];
    for await (const n of c.prompt("wait", ac.signal)) {
      if (n.update.sessionUpdate === "agent_message_chunk") got.push("chunk");
      ac.abort();
    }
    expect(got).toEqual(["chunk"]);
    expect(readFileSync(logFile, "utf8")).toContain("cancelled");
  });

  it("close() leaves no child running", async () => {
    const c = await connect();
    let pid = 0;
    for await (const n of c.prompt("pid")) {
      if (n.update.sessionUpdate === "agent_message_chunk" && n.update.content.type === "text") {
        pid = Number(n.update.content.text);
        break;
      }
    }
    expect(pid).toBeGreaterThan(0);
    expect(alive(pid)).toBe(true);
    await c.close();
    await c.close();
    expect(alive(pid)).toBe(false);
  });

  it("ends the iterator with AcpAgentSpawnError carrying exit code and bounded stderr", async () => {
    const c = await connect();
    const err = await texts(c.prompt("die")).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AcpAgentSpawnError);
    const e = err as AcpAgentSpawnError;
    expect(e.exitCode).toBe(3);
    expect(e.message).toContain("code 3");
    expect(e.message).toContain("fatal: boom");
    expect(e.message).not.toContain("noise 0\n");
    expect(e.stderrTail?.split("\n").length).toBeLessThanOrEqual(20);
  });

  it("refuses a bare command when PATH has a relative or empty entry", async () => {
    for (const PATH of [".", "/usr/bin::/bin", `/usr/bin:${dir.slice(1)}`]) {
      await expect(
        connectAcpAgent({
          command: "fixture-agent",
          cwd: dir,
          env: { PATH },
          onPermission: reject,
        }),
      ).rejects.toThrow(/relative or empty/);
    }
    await expect(
      connectAcpAgent({
        command: "fixture-agent",
        cwd: dir,
        env: { PATH: "." },
        onPermission: reject,
      }),
    ).rejects.toBeInstanceOf(AcpAgentSpawnError);
  });

  it("refuses a relative path and reports a missing command", async () => {
    await expect(
      connectAcpAgent({ command: "./agent", cwd: dir, env: {}, onPermission: reject }),
    ).rejects.toBeInstanceOf(AcpAgentSpawnError);
    await expect(
      connectAcpAgent({
        command: "nope-agent",
        cwd: dir,
        env: { PATH: dir },
        onPermission: reject,
      }),
    ).rejects.toThrow(/not found/);
    expect(existsSync(dir)).toBe(true);
  });

  it("rejects with the exit code when the child exits during initialize", async () => {
    const err = await connectAcpAgent({
      command: process.execPath,
      args: ["-e", "console.error('bad start'); process.exit(7)"],
      cwd: dir,
      env: {},
      onPermission: reject,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AcpAgentSpawnError);
    expect((err as AcpAgentSpawnError).exitCode).toBe(7);
    expect((err as AcpAgentSpawnError).message).toContain("bad start");
  });

  it("does not inherit process.env", async () => {
    process.env.ACP_CLIENT_TEST_LEAK = "1";
    try {
      const err = await connectAcpAgent({
        command: process.execPath,
        args: ["-e", "process.exit(process.env.ACP_CLIENT_TEST_LEAK === undefined ? 11 : 12)"],
        cwd: dir,
        env: {},
        onPermission: reject,
      }).catch((e: unknown) => e);
      expect((err as AcpAgentSpawnError).exitCode).toBe(11);
    } finally {
      delete process.env.ACP_CLIENT_TEST_LEAK;
    }
  });
});
