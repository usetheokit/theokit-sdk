/**
 * MessageBus — in-process typed message router for A2A (T20.1, ADR D453).
 *
 * Routes messages between agents by ID. Supports fire-and-forget (send)
 * and request/response (request with timeout).
 *
 * @public
 */

import { TheokitAgentError } from "../errors.js";
import { diag } from "../internal/diagnostics.js";
import type { A2ATransport } from "./transport.js";
import type { A2AMessage, MessageHandler } from "./types.js";

/**
 * Thrown by {@link MessageBus.request} when `to` has no local handler and the bus has a transport.
 * `request` is local-only; a transport carries fire-and-forget messages, not replies.
 *
 * @public
 */
export class A2ARemoteRequestUnsupportedError extends TheokitAgentError {
  override readonly name = "A2ARemoteRequestUnsupportedError";
  override readonly code = "a2a_remote_request_unsupported" as const;

  constructor(
    /** The address with no local handler. */
    public readonly to: string,
  ) {
    super(`Agent "${to}" is not local: request is local-only, use send for remote peers`, {
      code: "a2a_remote_request_unsupported",
      isRetryable: false,
    });
  }
}

/**
 * Thrown by {@link MessageBus.send} and {@link MessageBus.request} when `to` has no registered
 * handler.
 *
 * The sibling below records why a typed error was introduced for the TIMEOUT, quoting
 * `docs/error-codes.md`: "Branch on `code`, never on the message: messages carry context (an id, a
 * path, a limit) and change with it, while a code is the contract." This failure had exactly the
 * shape that reasoning rejects — a bare `Error` whose message embeds the address — in the FIRST
 * branch of the same two methods whose second branch was fixed.
 *
 * @public
 */
export class A2APeerNotRegisteredError extends TheokitAgentError {
  override readonly name = "A2APeerNotRegisteredError";
  override readonly code = "a2a_peer_not_registered" as const;

  constructor(
    /** The address with no registered handler. */
    public readonly to: string,
  ) {
    // Not retryable: a peer registers or it does not, and re-sending does not register it. A caller
    // that expects it to appear should await registration, not retry the send.
    super(`Agent "${to}" not registered on MessageBus`, {
      code: "a2a_peer_not_registered",
      isRetryable: false,
    });
  }
}

/**
 * A peer did not answer a {@link MessageBus.request} within its timeout.
 *
 * Carries `code: "a2a_request_timeout"`, the peer's address and the limit as FIELDS, so a caller
 * branches on the contract rather than on prose — `docs/error-codes.md`: "Branch on `code`, never
 * on the message: messages carry context (an id, a path, a limit) and change with it, while a code
 * is the contract." Until #380 this rejection was a plain `Error` with neither, and the message it
 * carried embeds both the address and the limit, so matching on it changed with context exactly as
 * that document warns.
 *
 * The distinction it restores is what a retry policy is built on. A peer that did not answer in
 * time is transient and worth retrying; a peer whose handler threw is likely deterministic and
 * retrying repeats the failure. A handler's own error propagates unchanged and is NOT this type —
 * an unattended agent can therefore tell the two apart without reading English.
 *
 * @public
 */
export class A2ARequestTimeoutError extends TheokitAgentError {
  override readonly name = "A2ARequestTimeoutError";
  override readonly code = "a2a_request_timeout" as const;
  constructor(
    /** The peer that did not answer. */
    public readonly to: string,
    /** The limit it exceeded, in milliseconds. */
    public readonly timeoutMs: number,
  ) {
    // Retryable: a peer that missed one deadline may answer the next request.
    super(`A2A request timeout: ${to} did not respond within ${timeoutMs}ms`, {
      code: "a2a_request_timeout",
      isRetryable: true,
    });
  }
}

/**
 * Per-call knobs for {@link MessageBus.request} / `AgentMailbox.request`.
 */
export interface RequestOptions {
  /**
   * How long to wait for the peer handler to settle before rejecting.
   * Default `30_000` (30 s). The rejection is an {@link A2ARequestTimeoutError} carrying
   * `code: "a2a_request_timeout"`, `to` and `timeoutMs` (#380), so a caller distinguishes a
   * timeout from a handler failure by branching on the code — a handler's own error propagates
   * unchanged and is not that type.
   */
  timeoutMs?: number;
}

/**
 * In-process router that delivers A2A messages between agents keyed by string id.
 *
 * By default purely in-memory and single-process. With an {@link A2ATransport} (constructor
 * `transport` option), `send` to a peer with no local handler goes to `transport.send`, and
 * `pump()` polls it for every locally registered agent and delivers to their handlers; the bus
 * itself persists nothing. Register one handler per agent id, then `send`
 * (fire-and-forget) or `request` (await the handler's return value).
 *
 *   const bus = new MessageBus();
 *   bus.register("worker", (m) => `echo:${m.payload}`);
 *   const reply = await bus.request("boss", "worker", { type: "ping", payload: 1 });
 *
 * Callers supply only `{ type, payload }`; the bus stamps `from`, `to`,
 * `timestamp` and `origin` onto the delivered {@link A2AMessage}.
 *
 * How it fails: without a transport, `send` and `request` both reject with
 * {@link A2APeerNotRegisteredError} (code `a2a_peer_not_registered`, carrying `to`) when `to` has
 * no handler. With a transport, `send` forwards instead, and `request` (local-only) rejects with
 * {@link A2ARemoteRequestUnsupportedError} (code `a2a_remote_request_unsupported`). `request`
 * additionally rejects with {@link A2ARequestTimeoutError} on timeout.
 *
 * Traps:
 *  - `register` silently OVERWRITES an existing id; the previous handler simply
 *    stops receiving anything. Call `has(id)` first when that matters.
 *  - `send` is declared `async` but never awaits the handler. A handler that
 *    rejects produces an UNHANDLED rejection that `await bus.send(...)` does not
 *    observe — only the "not registered" failure reaches the caller. Use
 *    `request` when the handler's failure has to be visible.
 *  - `from` is whatever the caller passes; the bus never checks that the sender
 *    is registered. It is self-asserted provenance, not authentication.
 */
export class MessageBus {
  private readonly _handlers = new Map<string, MessageHandler>();
  private readonly _transport: A2ATransport | undefined;

  constructor(options?: { transport?: A2ATransport }) {
    this._transport = options?.transport;
  }

  register(agentId: string, handler: MessageHandler): void {
    this._handlers.set(agentId, handler);
  }

  unregister(agentId: string): void {
    this._handlers.delete(agentId);
  }

  async send(from: string, to: string, partial: { type: string; payload: unknown }): Promise<void> {
    const handler = this._handlers.get(to);
    if (!handler && !this._transport) {
      throw new A2APeerNotRegisteredError(to);
    }
    const message: A2AMessage = {
      ...partial,
      from,
      to,
      timestamp: Date.now(),
      // SE3 — provenance projection of the sender address (thin view over `from`).
      origin: { kind: "peer", from },
    };
    if (!handler) {
      // Non-null: the guard above throws when there is neither a handler nor a transport.
      await (this._transport as A2ATransport).send(message);
      return;
    }
    // Fire-and-forget: the SENDER does not wait for the result, which is the whole point of
    // `send`. It does not mean nobody is told when delivery fails — that is the difference
    // between asynchronous and silent (#365).
    //
    // The returned promise used to be dropped on the floor. `MessageHandler` may return one, so a
    // rejecting handler became an unhandled rejection: fatal under Node's default
    // `--unhandled-rejections=throw`, and invisible to the caller, whose `await send(...)`
    // resolved cleanly either way. Attaching a catch keeps the call non-blocking and reports the
    // failure instead of discarding it (`error-handling.md` § 5).
    void Promise.resolve(handler(message)).catch((cause: unknown) => {
      const reason = cause instanceof Error ? cause.message : String(cause);
      diag(`[theokit-sdk] a2a: handler for "${to}" failed on a fire-and-forget send: ${reason}\n`);
    });
  }

  async request(
    from: string,
    to: string,
    partial: { type: string; payload: unknown },
    opts?: RequestOptions,
  ): Promise<unknown> {
    const handler = this._handlers.get(to);
    if (!handler) {
      throw this._transport
        ? new A2ARemoteRequestUnsupportedError(to)
        : new A2APeerNotRegisteredError(to);
    }
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    const message: A2AMessage = {
      ...partial,
      from,
      to,
      timestamp: Date.now(),
      // SE3 — provenance projection of the sender address (thin view over `from`).
      origin: { kind: "peer", from },
    };
    // Hold the timer so it can be cleared once the race settles — otherwise a
    // successful request leaks a live `setTimeout` that keeps the Node event loop
    // alive (the process hangs after the reply). Cleared in `finally`.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve(handler(message)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new A2ARequestTimeoutError(to, timeoutMs)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Fetch waiting messages from the transport for every locally registered agent and deliver them
   * to the handlers, in the order `poll` returns them. A handler failure is reported on diagnostics
   * and does not stop the other messages. Returns the count delivered to a handler (failed ones
   * included). Without a transport, returns 0.
   */
  async pump(): Promise<number> {
    const transport = this._transport;
    if (!transport) return 0;
    let delivered = 0;
    for (const agentId of this.listAgents()) {
      delivered += await this._pumpAgent(transport, agentId);
    }
    return delivered;
  }

  private async _pumpAgent(transport: A2ATransport, agentId: string): Promise<number> {
    const batch = await transport.poll(agentId);
    let delivered = 0;
    for (let i = 0; i < batch.length; i++) {
      const handler = this._handlers.get(agentId);
      if (!handler) {
        // `poll` already removed the whole batch: unregistered mid-pump, so hand the rest back
        // to the transport instead of losing it.
        for (const message of batch.slice(i)) await transport.send(message);
        break;
      }
      delivered++;
      await this._deliverPumped(agentId, handler, batch[i] as A2AMessage);
    }
    return delivered;
  }

  private async _deliverPumped(
    agentId: string,
    handler: MessageHandler,
    message: A2AMessage,
  ): Promise<void> {
    try {
      await handler(message);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      diag(`[theokit-sdk] a2a: handler for "${agentId}" failed on a pumped message: ${reason}\n`);
    }
  }

  has(agentId: string): boolean {
    return this._handlers.has(agentId);
  }

  listAgents(): string[] {
    return [...this._handlers.keys()];
  }
}
