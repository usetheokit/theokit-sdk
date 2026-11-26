import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dockerEndpoint, openDockerTerminal } from "../../src/sandbox/docker-terminal.js";

describe("dockerEndpoint", () => {
  it("defaults to the unix socket", () => {
    expect(dockerEndpoint({})).toEqual({ socketPath: "/var/run/docker.sock" });
  });
  it("reads unix:// and tcp://", () => {
    expect(dockerEndpoint({ DOCKER_HOST: "unix:///x.sock" })).toEqual({ socketPath: "/x.sock" });
    expect(dockerEndpoint({ DOCKER_HOST: "tcp://h:2376" })).toEqual({ host: "h", port: 2376 });
  });
  it("rejects ssh", () => {
    expect(() => dockerEndpoint({ DOCKER_HOST: "ssh://h" })).toThrow(/unsupported/);
  });
});

describe("openDockerTerminal", () => {
  it("rejects when the daemon is unreachable", async () => {
    await expect(
      openDockerTerminal({
        endpoint: { socketPath: "/nonexistent/docker.sock" },
        container: "c",
        command: "sh",
        cols: 80,
        rows: 24,
        onEnd: async () => undefined,
      }),
    ).rejects.toThrow(/ENOENT/);
  });
});

type DaemonOpts = { createStatus?: number; execGone?: boolean };

function daemonHandler(opts: DaemonOpts) {
  const routes: [RegExp, number, unknown][] = [
    [/\/exec$/, opts.createStatus ?? 201, { Id: "e1" }],
    [/^\/exec\/e1\/resize/, 200, undefined],
    [/^\/exec\/e1\/json/, opts.execGone ? 404 : 200, { Running: false, ExitCode: 5 }],
  ];
  return (req: IncomingMessage, res: ServerResponse) => {
    const hit = routes.find(([re]) => re.test(req.url ?? ""));
    res.statusCode = hit?.[1] ?? 500;
    res.end(hit?.[2] === undefined ? undefined : JSON.stringify(hit[2]));
  };
}

describe("openDockerTerminal against a fake daemon", () => {
  async function fakeDaemon(opts: DaemonOpts) {
    const dir = mkdtempSync(join(tmpdir(), "fake-docker-"));
    const socketPath = join(dir, "d.sock");
    const server = createServer(daemonHandler(opts));
    server.on("upgrade", (_req, socket) => {
      socket.write("HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
      socket.on("data", (d) => socket.write(d));
    });
    await new Promise<void>((r) => server.listen(socketPath, r));
    return {
      socketPath,
      close: () => {
        server.closeAllConnections();
        server.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }
  const base = (socketPath: string, onEnd: () => Promise<void>) => ({
    endpoint: { socketPath },
    container: "c",
    command: "sh",
    cols: 80,
    rows: 24,
    onEnd,
  });

  it("fails on a non-201 exec create, without leaving a terminal", async () => {
    const d = await fakeDaemon({ createStatus: 404 });
    try {
      await expect(openDockerTerminal(base(d.socketPath, async () => undefined))).rejects.toThrow(
        /exec create failed: HTTP 404/,
      );
    } finally {
      d.close();
    }
  });

  it("echoes, then kill() runs onEnd once and wait() falls back to 137 when the exec is gone", async () => {
    const d = await fakeDaemon({ execGone: true });
    try {
      let ends = 0;
      const term = await openDockerTerminal(
        base(d.socketPath, async () => {
          ends++;
        }),
      );
      const got: string[] = [];
      term.onData((b) => got.push(Buffer.from(b).toString()));
      await term.write("hi");
      for (let i = 0; i < 50 && got.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
      expect(got.join("")).toBe("hi");
      await term.kill();
      expect(await term.wait()).toEqual({ exitCode: 137 });
      expect(ends).toBe(1);
    } finally {
      d.close();
    }
  });

  it("reports the exec's exit code when inspect answers", async () => {
    const d = await fakeDaemon({});
    try {
      const term = await openDockerTerminal(base(d.socketPath, async () => undefined));
      await term.kill();
      expect(await term.wait()).toEqual({ exitCode: 5 });
    } finally {
      d.close();
    }
  });
});
