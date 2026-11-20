/**
 * `@theokit/acp/client` — drive another ACP agent from your own process.
 *
 * ```ts
 * import { connectAcpAgent } from "@theokit/acp/client";
 *
 * const agent = await connectAcpAgent({
 *   command: "/usr/local/bin/some-acp-agent",
 *   cwd: process.cwd(),
 *   env: { PATH: "/usr/bin:/bin" }, // nothing is inherited from process.env
 *   onPermission: async (req) => ({
 *     outcome: { outcome: "selected", optionId: req.options[0]?.optionId ?? "" },
 *   }),
 * });
 * for await (const update of agent.prompt("hi")) console.log(update.update);
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
  exitError,
  resolveCommand,
  spawnAgentChild,
} from "./client-spawn.js";

export { AcpAgentSpawnError };

const DEFAULT_INITIALIZE_TIMEOUT_MS = 10_000;

/** Options for {@link connectAcpAgent}. */
export interface ConnectAcpAgentOptions {
  /** Absolute path, or a bare name resolved on the absolute entries of `env.PATH` only. */
  command: string;
  args?: readonly string[];
  cwd: string;
  /** Passed to the child as is. Nothing is inherited from `process.env`. */
  env: Record<string, string>;
  onPermission(request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse>;
  /** Default 10_000. */
  initializeTimeoutMs?: number;
}

/** A live connection to a spawned ACP agent, with one session already created. */
export interface AcpAgentConnection {
  /**
   * Send one prompt and stream the agent's session updates until the turn ends. One prompt at a time
   * per connection. Aborting `signal` sends `session/cancel`. A child that exits mid-prompt ends the
   * iterator with `AcpAgentSpawnError`.
   */
  prompt(text: string, signal?: AbortSignal): AsyncIterable<acp.SessionNotification>;
  /** Cancels any running turn and kills the child (its process group on POSIX). Idempotent. */
  close(): Promise<void>;
}

type Sink = (notification: acp.SessionNotification) => void;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AcpAgentSpawnError(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Rejects when the child closes, with the exit code and the last stderr lines. */
function exitRejection(child: AgentChild, what: string): Promise<never> {
  return child.exited.then((exit) => {
    throw exitError(what, exit, child.stderrTail());
  });
}

const EXIT_GRACE_MS = 500;

/**
 * The connection usually reports a closed stream a moment before the child's `close` event. When a
 * request fails, give the child a short grace to be seen exiting, so the caller gets its exit code and
 * stderr rather than a bare "connection closed".
 */
async function explainFailure(child: AgentChild, what: string, err: unknown): Promise<never> {
  if (err instanceof AcpAgentSpawnError) throw err;
  let timer: NodeJS.Timeout | undefined;
  const grace = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), EXIT_GRACE_MS);
  });
  const exit = await Promise.race([child.exited, grace]);
  clearTimeout(timer);
  if (exit !== undefined) throw exitError(what, exit, child.stderrTail());
  throw err;
}

async function handshake(
  conn: acp.ClientSideConnection,
  child: AgentChild,
  options: ConnectAcpAgentOptions,
): Promise<string> {
  const setup = (async () => {
    await conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const session = await conn.newSession({ cwd: options.cwd, mcpServers: [] });
    return session.sessionId;
  })().catch((err: unknown) => explainFailure(child, "during initialize", err));
  const exit = exitRejection(child, "during initialize");
  exit.catch(() => undefined);
  setup.catch(() => undefined);
  return withTimeout(
    Promise.race([setup, exit]),
    options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS,
    `acp agent did not finish initialize within ${options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS}ms`,
  );
}

interface Turn {
  queue: acp.SessionNotification[];
  done: boolean;
  failure: unknown;
  wake: (() => void) | undefined;
}

async function* drain(turn: Turn): AsyncGenerator<acp.SessionNotification> {
  for (;;) {
    const next = turn.queue.shift();
    if (next !== undefined) {
      yield next;
    } else if (turn.done) {
      break;
    } else {
      await new Promise<void>((resolve) => {
        turn.wake = resolve;
      });
    }
  }
  if (turn.failure !== undefined) throw turn.failure;
}

/** Spawn an ACP agent, run `initialize` and `session/new`, and return a handle for prompting it. */
export async function connectAcpAgent(
  options: ConnectAcpAgentOptions,
): Promise<AcpAgentConnection> {
  const resolved = resolveCommand(options.command, options.env);
  const child = spawnAgentChild(resolved, {
    command: resolved,
    args: options.args ?? [],
    cwd: options.cwd,
    env: options.env,
  });
  let sink: Sink | undefined;
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.process.stdin as Writable) as WritableStream<Uint8Array>,
    Readable.toWeb(child.process.stdout as Readable) as ReadableStream<Uint8Array>,
  );
  const conn = new acp.ClientSideConnection(
    () => ({
      requestPermission: (request) => options.onPermission(request),
      sessionUpdate: async (notification) => {
        sink?.(notification);
      },
    }),
    stream,
  );

  let sessionId: string;
  try {
    sessionId = await handshake(conn, child, options);
  } catch (err) {
    await child.kill();
    throw err;
  }

  let closing = false;
  let active = false;

  const runTurn = (text: string, turn: Turn): void => {
    const finish = (failure?: unknown): void => {
      if (failure !== undefined) turn.failure = failure;
      turn.done = true;
      turn.wake?.();
    };
    sink = (n) => {
      if (n.sessionId !== sessionId) return;
      turn.queue.push(n);
      turn.wake?.();
    };
    const exit = exitRejection(child, "mid-prompt");
    exit.catch(() => undefined);
    const request = conn
      .prompt({ sessionId, prompt: [{ type: "text", text }] })
      .catch((err: unknown) => explainFailure(child, "mid-prompt", err));
    Promise.race([request, exit]).then(
      () => finish(),
      (err) => finish(closing ? undefined : err),
    );
  };

  const cancel = (): void => {
    conn.cancel({ sessionId }).catch(() => undefined);
  };

  async function* prompt(
    text: string,
    signal?: AbortSignal,
  ): AsyncGenerator<acp.SessionNotification> {
    if (closing) throw new AcpAgentSpawnError("acp agent connection is closed");
    if (active) throw new Error("a prompt is already running on this ACP connection");
    active = true;
    const turn: Turn = { queue: [], done: false, failure: undefined, wake: undefined };
    const onAbort = (): void => cancel();
    try {
      runTurn(text, turn);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) cancel();
      yield* drain(turn);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (!turn.done) cancel();
      sink = undefined;
      active = false;
    }
  }

  return {
    prompt,
    async close(): Promise<void> {
      closing = true;
      if (active) cancel();
      child.process.stdin?.end();
      await child.kill();
    },
  };
}
