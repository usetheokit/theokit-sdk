import type { A2AMessage } from "./types.js";

/**
 * A2ATransport — the seam that lets a {@link MessageBus} reach agents in other processes.
 *
 * `from` on every message is SELF-ASSERTED by the sender: a transport carries it as given and
 * neither this interface nor the in-memory implementation authenticates it. Authentication is the
 * job of a sealed transport (a later addition).
 *
 * @public
 */
export interface A2ATransport {
  /** Deliver one message to a peer outside this process. */
  send(message: A2AMessage): Promise<void>;
  /** Messages waiting for `agentId`, removed from the transport once returned. */
  poll(agentId: string): Promise<A2AMessage[]>;
}

/**
 * A transport backed by one shared in-memory queue per recipient. Share the returned object between
 * buses for tests and same-process use. Nothing is persisted.
 *
 * @public
 */
export function inMemoryTransport(): A2ATransport {
  const queues = new Map<string, A2AMessage[]>();
  return {
    async send(message) {
      const queue = queues.get(message.to);
      if (queue) queue.push(message);
      else queues.set(message.to, [message]);
    },
    async poll(agentId) {
      const waiting = queues.get(agentId) ?? [];
      queues.delete(agentId);
      return waiting;
    },
  };
}
