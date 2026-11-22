/**
 * `@theokit/acp/client` — drive another ACP agent over stdio.
 *
 * ```ts
 * import { connectAcpAgent } from "@theokit/acp/client";
 *
 * const agent = await connectAcpAgent({
 *   command: "/usr/local/bin/my-agent",
 *   cwd: process.cwd(),
 *   env: { PATH: "/usr/bin" },
 *   onPermission: async (req) => ({ outcome: { outcome: "cancelled" } }),
 * });
 * for await (const update of agent.prompt("hello")) console.log(update.update);
 * await agent.close();
 * ```
 *
 * @packageDocumentation
 */

import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import {
  AcpAgentSpawnError,
  type AgentChild,
  resolveCommand,
  spawnAgentChild,
} from "./client-spawn.js";

export { AcpAgentSpawnError } from "./client-spawn.js";

const DEFAULT_INITIALIZE_TIMEOUT_MS = 10_000;
/** How long to wait for the child's exit event after a broken pipe, to learn its exit code. */
const EXIT_SETTLE_MS = 1_000;

/** @public */
export interface ConnectAcpAgentOptions {
  /** Absolute path, or a bare name resolved on absolute `PATH` entries of `env` only. */
  command: string;
  args?: readonly string[];
  cwd: string;
  /** Passed to the child as is. Nothing is inherited from `process.env`. */
  env: Record<string, string>;
  /** Answers the agent's `session/request_permission`. */
  onPermission(request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse>;
  /** Budget for the `initialize` + `session/new` handshake. Default 10_000. */
  initializeTimeoutMs?: number;
}

/** @public */
export interface AcpAgentConnection {
  /**
   * Send one prompt and stream the session updates it produces. Only one prompt may be in flight.
   * Aborting `signal` sends `session/cancel`. A child exiting mid-prompt ends the iterator with
   * `AcpAgentSpawnError`.
   */
  prompt(text: string, signal?: AbortSignal): AsyncIterable<acp.SessionNotification>;
  /** Ends the session and kills the child (its process group on POSIX). Idempotent. */
  close(): Promise<void>;
}

class UpdateQueue {
  private items: acp.SessionNotification[] = [];
  private waiter: (() => void) | undefined;
  private done = false;
  private failure: unknown;

  push(item: acp.SessionNotification): void {
    this.items.push(item);
    this.wake();
  }

  end(failure?: unknown): void {
    if (this.done) return;
    this.done = true;
    this.failure = failure;
    this.wake();
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = undefined;
    w?.();
  }

  async *drain(): AsyncGenerator<acp.SessionNotification> {
    for (;;) {
      const next = this.items.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.done) {
        if (this.failure !== undefined) throw this.failure;
        return;
      }
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

async function exitError(child: AgentChild, phase: string, cause?: unknown): Promise<Error> {
  const result = await Promise.race([child.exited, delay(EXIT_SETTLE_MS)]);
  const tail = child.stderrTail();
  const stderrPart = tail.length > 0 ? `; stderr:\n${tail}` : "";
  if (result === undefined) {
    return new AcpAgentSpawnError(`ACP agent connection failed ${phase}${stderrPart}`, {
      stderrTail: tail,
      cause,
    });
  }
  const how = result.signal !== null ? `signal ${result.signal}` : `code ${result.code}`;
  return new AcpAgentSpawnError(`ACP agent exited ${phase} (${how})${stderrPart}`, {
    exitCode: result.code,
    exitSignal: result.signal,
    stderrTail: tail,
    cause,
  });
}

class Connection implements AcpAgentConnection {
  private active: UpdateQueue | undefined;
  private closing: Promise<void> | undefined;
  private closed = false;

  constructor(
    private readonly child: AgentChild,
    private readonly conn: acp.ClientSideConnection,
    private readonly sessionId: string,
  ) {}

  /** @internal */
  dispatch(update: acp.SessionNotification): void {
    if (update.sessionId === this.sessionId) this.active?.push(update);
  }

  prompt(text: string, signal?: AbortSignal): AsyncIterable<acp.SessionNotification> {
    return this.run(text, signal);
  }

  private async *run(text: string, signal?: AbortSignal): AsyncGenerator<acp.SessionNotification> {
    if (this.closed) throw new AcpAgentSpawnError("ACP agent connection is closed");
    if (this.active !== undefined)
      throw new Error("a prompt is already in flight on this connection");
    const queue = new UpdateQueue();
    this.active = queue;
    const onAbort = (): void => {
      this.conn.cancel({ sessionId: this.sessionId }).catch(() => {});
    };
    if (signal?.aborted) onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const exitWatch = this.child.exited.then(async () => {
      if (this.closed) return;
      queue.end(await exitError(this.child, "during prompt"));
    });
    void exitWatch;
    this.conn.prompt({ sessionId: this.sessionId, prompt: [{ type: "text", text }] }).then(
      // Let notifications already read from the pipe reach the queue first.
      () => new Promise<void>((resolve) => setImmediate(resolve)).then(() => queue.end()),
      async (err: unknown) => {
        queue.end(this.closed ? undefined : await exitError(this.child, "during prompt", err));
      },
    );
    try {
      yield* queue.drain();
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (this.active === queue) this.active = undefined;
    }
  }

  close(): Promise<void> {
    this.closed = true;
    this.closing ??= this.child.kill().then(() => this.active?.end());
    return this.closing;
  }
}

async function handshake(conn: acp.ClientSideConnection, cwd: string): Promise<string> {
  await conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
  const session = await conn.newSession({ cwd, mcpServers: [] });
  return session.sessionId;
}

async function initialize(
  child: AgentChild,
  conn: acp.ClientSideConnection,
  options: ConnectAcpAgentOptions,
): Promise<string> {
  const timeoutMs = options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new AcpAgentSpawnError(`ACP agent did not initialize within ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  const exit = child.exited.then(() =>
    exitError(child, "during initialize").then((e) => Promise.reject(e)),
  );
  try {
    return await Promise.race([handshake(conn, options.cwd), timeout, exit]);
  } catch (err) {
    if (err instanceof AcpAgentSpawnError) throw err;
    throw await exitError(child, "during initialize", err);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Spawn an ACP agent as a child process, complete the handshake and open one session.
 *
 * @throws AcpAgentSpawnError when the command is refused, cannot be started, or exits or stalls
 *   during initialize.
 * @public
 */
export async function connectAcpAgent(
  options: ConnectAcpAgentOptions,
): Promise<AcpAgentConnection> {
  const file = resolveCommand(options.command, options.env);
  const child = await spawnAgentChild(file, options.args ?? [], {
    cwd: options.cwd,
    env: options.env,
  });
  const stdin = child.process.stdin;
  const stdout = child.process.stdout;
  if (stdin === null || stdout === null) {
    await child.kill();
    throw new AcpAgentSpawnError("ACP agent child has no stdio pipes");
  }
  const stream = acp.ndJsonStream(
    Writable.toWeb(stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(stdout) as ReadableStream<Uint8Array>,
  );
  let connection: Connection | undefined;
  const conn = new acp.ClientSideConnection(
    () => ({
      requestPermission: (request) => options.onPermission(request),
      sessionUpdate: async (update) => {
        connection?.dispatch(update);
      },
    }),
    stream,
  );
  try {
    const sessionId = await initialize(child, conn, options);
    connection = new Connection(child, conn, sessionId);
    return connection;
  } catch (err) {
    await child.kill();
    throw err;
  }
}
