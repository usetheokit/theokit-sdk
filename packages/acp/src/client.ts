/**
 * `connectAcpAgent` — drive another ACP agent over stdio with the ACP SDK's `ClientSideConnection`.
 *
 * Spawns the agent, initializes it, opens one session, and exposes `prompt()` as an async iterable
 * of the agent's `session/update` notifications. One prompt at a time per connection: notifications
 * carry no prompt id, so an overlapping `prompt()` is rejected.
 *
 * @packageDocumentation
 */

import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { AcpAgentSpawnError, type AgentChild, resolveCommand, spawnAgent } from "./client-spawn.js";

export { AcpAgentSpawnError } from "./client-spawn.js";

const DEFAULT_INITIALIZE_TIMEOUT_MS = 10_000;
const EXIT_GRACE_MS = 500;

/** Options for {@link connectAcpAgent}. */
export interface ConnectAcpAgentOptions {
  /** Absolute path, or a bare name resolved on the absolute entries of `env.PATH` only. */
  command: string;
  args?: readonly string[];
  cwd: string;
  /** Passed to the child as is; nothing is inherited from `process.env`. */
  env: Record<string, string>;
  /** Answers the agent's `session/request_permission`. */
  onPermission(request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse>;
  /** Bound on `initialize` + `session/new`. Default 10_000. */
  initializeTimeoutMs?: number;
}

/** A live session on a spawned ACP agent. */
export interface AcpAgentConnection {
  /** Send a prompt; yields the session's notifications until the turn ends. Abort sends `session/cancel`. */
  prompt(text: string, signal?: AbortSignal): AsyncIterable<acp.SessionNotification>;
  /** Cancel any running turn and kill the child (its process group on POSIX). */
  close(): Promise<void>;
}

/** Single-consumer async queue that can end normally or with an error. */
class UpdateQueue {
  private items: acp.SessionNotification[] = [];
  private waiter: (() => void) | undefined;
  private done = false;
  private error: unknown;

  push(item: acp.SessionNotification): void {
    if (this.done) return;
    this.items.push(item);
    this.wake();
  }

  end(error?: unknown): void {
    if (this.done) return;
    this.done = true;
    this.error = error;
    this.wake();
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = undefined;
    w?.();
  }

  async *iterate(): AsyncGenerator<acp.SessionNotification> {
    for (;;) {
      const next = this.items.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.done) {
        if (this.error !== undefined) throw this.error;
        return;
      }
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }
}

async function exitError(child: AgentChild, what: string): Promise<AcpAgentSpawnError> {
  const { code, signal } = await child.closed;
  const stderr = child.stderrTail();
  const how = code !== null ? `exit code ${code}` : `signal ${signal}`;
  return new AcpAgentSpawnError(`ACP agent exited ${what} (${how})${stderr ? `\n${stderr}` : ""}`, {
    exitCode: code,
    stderrTail: stderr,
  });
}

/** A broken pipe usually means the child died; give its `close` event a moment to arrive. */
async function childExitedSoon(child: AgentChild): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    child.closed,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, EXIT_GRACE_MS);
    }),
  ]);
  clearTimeout(timer);
  return child.hasExited();
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Spawn an ACP agent and open a session on it.
 *
 * Rejects with {@link AcpAgentSpawnError} when the command is refused or missing, when the child
 * exits before initializing, or when initialization times out.
 */
export async function connectAcpAgent(
  options: ConnectAcpAgentOptions,
): Promise<AcpAgentConnection> {
  const file = resolveCommand(options.command, options.env);
  const child = await spawnAgent(file, options.args ?? [], {
    cwd: options.cwd,
    env: options.env,
  });

  let active: UpdateQueue | undefined;
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.process.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.process.stdout) as ReadableStream<Uint8Array>,
  );
  const connection = new acp.ClientSideConnection(
    () => ({
      requestPermission: (params) => options.onPermission(params),
      sessionUpdate: async (params) => {
        active?.push(params);
      },
    }),
    stream,
  );
  // A write to a dead child must not become an unhandled rejection.
  child.process.stdin.on("error", () => undefined);

  const exitedDuring = (what: string): Promise<never> =>
    exitError(child, what).then((err) => {
      throw err;
    });

  let sessionId: string;
  try {
    const handshake = (async () => {
      await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      return connection.newSession({ cwd: options.cwd, mcpServers: [] });
    })();
    const session = await withTimeout(
      Promise.race([handshake, exitedDuring("during initialize")]),
      options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS,
      () => new AcpAgentSpawnError("ACP agent did not initialize in time"),
    );
    sessionId = session.sessionId;
  } catch (err) {
    if (err instanceof AcpAgentSpawnError) {
      await child.kill();
      throw err;
    }
    const exited = await childExitedSoon(child);
    await child.kill();
    if (exited) throw await exitError(child, "during initialize");
    throw new AcpAgentSpawnError(
      `ACP initialize failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  let closed = false;
  child.closed.then(() => {
    if (!closed && active !== undefined) {
      const q = active;
      exitError(child, "during prompt").then((e) => q.end(e));
    }
  });

  return {
    prompt(text, signal) {
      if (closed) throw new AcpAgentSpawnError("ACP connection is closed");
      if (active !== undefined) {
        throw new Error("a prompt is already running on this ACP connection");
      }
      const queue = new UpdateQueue();
      active = queue;
      const onAbort = (): void => {
        connection.cancel({ sessionId }).catch(() => undefined);
      };
      if (signal?.aborted === true) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      connection
        .prompt({ sessionId, prompt: [{ type: "text", text }] })
        .then(
          () => queue.end(),
          async (err: unknown) => {
            if (await childExitedSoon(child)) queue.end(await exitError(child, "during prompt"));
            else queue.end(err);
          },
        )
        .finally(() => {
          signal?.removeEventListener("abort", onAbort);
          if (active === queue) active = undefined;
        });
      return queue.iterate();
    },
    async close() {
      if (closed) return;
      closed = true;
      active?.end();
      await child.kill();
    },
  };
}
