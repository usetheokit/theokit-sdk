/**
 * Queue modes for a send that arrives while the agent's turn is still running
 * (`SendOptions.queueMode`). `followup` needs nothing here: the per-agent send lock already
 * runs it after the turn. This holds the two modes that do:
 *
 * - `steer`: the message waits in the running turn's inbox; the agent loop takes it before its
 *   next model call (or instead of finishing).
 * - `collect`: the message is held until the turn ends, then everything held goes out as ONE send.
 *
 * @internal
 */
import type { Run, SDKUserMessage, SendOptions } from "../../types/run.js";

/** One send in flight; `run` is the promise `agent.send` handed its caller. */
export interface SendTicket {
  readonly run: Promise<Run>;
  readonly inbox: string[];
}

interface Collected {
  message: string | SDKUserMessage;
  options: SendOptions;
  resolve: (run: Run) => void;
  reject: (err: unknown) => void;
}

const textOf = (m: string | SDKUserMessage): string => (typeof m === "string" ? m : m.text);

export class SendQueue {
  #inflight = 0;
  #current: SendTicket | undefined;
  #collected: Collected[] = [];

  /** Registers a send that is about to queue on the lock. */
  enter(run: Promise<Run>): SendTicket {
    this.#inflight += 1;
    return { run, inbox: [] };
  }

  /** The send holding the lock starts its turn. */
  start(ticket: SendTicket): void {
    this.#current = ticket;
  }

  /** Takes (and empties) the running turn's steering inbox. */
  drain(): string[] {
    return this.#current?.inbox.splice(0) ?? [];
  }

  /**
   * Handles a steer or collect send that arrived mid-turn. Returns the promise to hand the
   * caller, or `undefined` when the send should proceed as an ordinary one.
   */
  intercept(message: string | SDKUserMessage, options: SendOptions): Promise<Run> | undefined {
    if (options.queueMode === "steer" && this.#current !== undefined) {
      this.#current.inbox.push(textOf(message));
      return this.#current.run;
    }
    if (options.queueMode === "collect" && this.#inflight > 0) {
      return new Promise<Run>((resolve, reject) => {
        this.#collected.push({ message, options, resolve, reject });
      });
    }
    return undefined;
  }

  /** The turn is over: send what was collected (and any steer it never took) as one turn. */
  finish(send: (message: string | SDKUserMessage, options: SendOptions) => Promise<Run>): void {
    this.#inflight -= 1;
    const leftover = this.#current?.inbox.splice(0) ?? [];
    this.#current = undefined;
    const batch = this.#collected.splice(0);
    const first = batch[0];
    const texts = [...leftover, ...batch.map((c) => textOf(c.message))];
    if (texts.length === 0) return;
    const images = batch.flatMap((c) =>
      typeof c.message === "string" ? [] : (c.message.images ?? []),
    );
    const message: string | SDKUserMessage =
      images.length > 0 ? { text: texts.join("\n\n"), images } : texts.join("\n\n");
    const sent = send(message, { ...first?.options, queueMode: "followup" });
    sent.then(
      (run) => {
        for (const c of batch) c.resolve(run);
      },
      (err: unknown) => {
        for (const c of batch) c.reject(err);
      },
    );
  }
}
