/**
 * Docker terminal transport: a TTY exec attached over the Docker Engine API.
 *
 * The Docker CLI cannot give a program a pseudo-terminal without a host TTY, so this talks to the
 * daemon directly (`DOCKER_HOST` `unix://` or `tcp://`, default `/var/run/docker.sock`). TLS and
 * ssh endpoints are not supported.
 */

import { type IncomingMessage, request } from "node:http";
import type { Duplex } from "node:stream";

import { createOutputHub } from "./terminal-output.js";
import type { SandboxTerminal } from "./types.js";

/** Where the Docker daemon listens, as `http.request` options. */
export type DockerEndpoint = { socketPath: string } | { host: string; port: number };

/** Reads `DOCKER_HOST`; unsupported schemes throw. */
export function dockerEndpoint(env: NodeJS.ProcessEnv = process.env): DockerEndpoint {
  const raw = env.DOCKER_HOST;
  if (!raw) return { socketPath: "/var/run/docker.sock" };
  if (raw.startsWith("unix://")) return { socketPath: raw.slice("unix://".length) };
  if (raw.startsWith("tcp://") || raw.startsWith("http://")) {
    const u = new URL(raw.replace(/^tcp:/, "http:"));
    return { host: u.hostname, port: Number(u.port || 2375) };
  }
  throw new Error(`unsupported DOCKER_HOST for a terminal: ${raw}`);
}

function api(
  ep: DockerEndpoint,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        ...ep,
        method,
        path,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : {},
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") }),
        );
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

function attach(ep: DockerEndpoint, execId: string): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ Detach: false, Tty: true });
    const req = request({
      ...ep,
      method: "POST",
      path: `/exec/${execId}/start`,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        Connection: "Upgrade",
        Upgrade: "tcp",
      },
    });
    req.on("upgrade", (_res, socket, head) => {
      if (head.length > 0) socket.unshift(head);
      resolve(socket);
    });
    req.on("response", (res) => {
      res.resume();
      reject(new Error(`docker exec start failed: HTTP ${String(res.statusCode)}`));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

export interface DockerTerminalOptions {
  endpoint: DockerEndpoint;
  container: string;
  command: string;
  cols: number;
  rows: number;
  cwd?: string;
  user?: string;
  /** Runs once when the terminal ends (any reason); removes the container. */
  onEnd: () => Promise<void>;
}

async function exitCodeOf(ep: DockerEndpoint, execId: string): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const r = await api(ep, "GET", `/exec/${execId}/json`).catch(() => undefined);
    if (!r || r.status !== 200) return 137; // container gone: it was killed
    const info = JSON.parse(r.body) as { Running?: boolean; ExitCode?: number };
    if (!info.Running) return info.ExitCode ?? 0;
    await new Promise((res) => setTimeout(res, 100));
  }
  return 137;
}

/** Opens a TTY exec in a running container and returns it as a {@link SandboxTerminal}. */
export async function openDockerTerminal(o: DockerTerminalOptions): Promise<SandboxTerminal> {
  const ep = o.endpoint;
  const created = await api(ep, "POST", `/containers/${o.container}/exec`, {
    Cmd: ["sh", "-c", o.command],
    Tty: true,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    ...(o.cwd ? { WorkingDir: o.cwd } : {}),
    ...(o.user ? { User: o.user } : {}),
  });
  if (created.status !== 201) {
    throw new Error(`docker exec create failed: HTTP ${created.status} ${created.body}`);
  }
  const execId = (JSON.parse(created.body) as { Id: string }).Id;
  const socket = await attach(ep, execId);
  const resize = async (cols: number, rows: number): Promise<void> => {
    const r = await api(ep, "POST", `/exec/${execId}/resize?h=${rows}&w=${cols}`);
    if (r.status >= 300) throw new Error(`docker exec resize failed: HTTP ${r.status}`);
  };
  await resize(o.cols, o.rows);

  const hub = createOutputHub();
  socket.on("data", (c: Buffer) => hub.emit(c));
  const closed = new Promise<void>((res) => {
    socket.once("close", () => res());
    socket.once("error", () => res());
  });
  const done = closed.then(async () => {
    const exitCode = await exitCodeOf(ep, execId);
    await o.onEnd().catch(() => undefined);
    return { exitCode };
  });

  return {
    async write(data) {
      await new Promise<void>((res, rej) => socket.write(data, (e) => (e ? rej(e) : res())));
    },
    resize,
    onData: hub.onData,
    wait: () => done,
    async kill() {
      await o.onEnd().catch(() => undefined);
      socket.destroy();
    },
  };
}
