import { describe, expect, it, vi } from "vitest";
import {
  type A2AMessage,
  A2APeerNotRegisteredError,
  A2ARemoteRequestUnsupportedError,
  inMemoryTransport,
  MessageBus,
} from "../../src/a2a/index.js";

describe("MessageBus transport", () => {
  it("delivers to a remote bus after pump", async () => {
    const transport = inMemoryTransport();
    const a = new MessageBus({ transport });
    const b = new MessageBus({ transport });
    const got: A2AMessage[] = [];
    b.register("worker", (m) => {
      got.push(m);
    });
    await a.send("boss", "worker", { type: "job", payload: { n: 1 } });
    expect(got).toHaveLength(0);
    expect(await b.pump()).toBe(1);
    expect(got[0]).toMatchObject({ from: "boss", to: "worker", type: "job", payload: { n: 1 } });
    expect(await b.pump()).toBe(0);
  });

  it("prefers a local handler over the transport", async () => {
    const transport = inMemoryTransport();
    const send = vi.spyOn(transport, "send");
    const a = new MessageBus({ transport });
    const handler = vi.fn();
    a.register("worker", handler);
    await a.send("boss", "worker", { type: "t", payload: 1 });
    expect(handler).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects request to a remote-only peer", async () => {
    const a = new MessageBus({ transport: inMemoryTransport() });
    await expect(a.request("boss", "worker", { type: "t", payload: 1 })).rejects.toBeInstanceOf(
      A2ARemoteRequestUnsupportedError,
    );
  });

  it("keeps A2APeerNotRegisteredError without a transport", async () => {
    const a = new MessageBus();
    await expect(a.send("boss", "worker", { type: "t", payload: 1 })).rejects.toBeInstanceOf(
      A2APeerNotRegisteredError,
    );
  });

  it("pumps in order and survives handler failures", async () => {
    const transport = inMemoryTransport();
    const a = new MessageBus({ transport });
    const b = new MessageBus({ transport });
    const seen: unknown[] = [];
    b.register("worker", (m) => {
      seen.push(m.payload);
      if (m.payload === 2) throw new Error("boom");
    });
    for (const n of [1, 2, 3]) await a.send("boss", "worker", { type: "t", payload: n });
    expect(await b.pump()).toBe(3);
    expect(seen).toEqual([1, 2, 3]);
  });

  it("requeues undelivered messages when the handler unregisters mid-batch", async () => {
    const transport = inMemoryTransport();
    const a = new MessageBus({ transport });
    const b = new MessageBus({ transport });
    const seen: unknown[] = [];
    b.register("worker", (m) => {
      seen.push(m.payload);
      b.unregister("worker");
    });
    for (const n of [1, 2, 3]) await a.send("boss", "worker", { type: "t", payload: n });
    expect(await b.pump()).toBe(1);
    const later: unknown[] = [];
    b.register("worker", (m) => {
      later.push(m.payload);
    });
    expect(await b.pump()).toBe(2);
    expect(seen).toEqual([1]);
    expect(later).toEqual([2, 3]);
  });

  it("requeues the batch when the handler unregisters while poll is pending", async () => {
    const inner = inMemoryTransport();
    const b: MessageBus = new MessageBus({
      transport: {
        send: (m) => inner.send(m),
        poll: async (id) => {
          const got = await inner.poll(id);
          b.unregister("worker");
          return got;
        },
      },
    });
    const handler = vi.fn();
    b.register("worker", handler);
    await inner.send({
      type: "t",
      payload: 1,
      from: "x",
      to: "worker",
      timestamp: 0,
    } as A2AMessage);
    expect(await b.pump()).toBe(0);
    expect(handler).not.toHaveBeenCalled();
    expect(await inner.poll("worker")).toHaveLength(1);
  });
  it("keeps every pending message when requeue send rejects, and retries on the next pump", async () => {
    const inner = inMemoryTransport();
    let failSends = false;
    const b: MessageBus = new MessageBus({
      transport: {
        send: async (m) => {
          if (failSends) throw new Error("down");
          await inner.send(m);
        },
        poll: (id) => inner.poll(id),
      },
    });
    const seen: unknown[] = [];
    b.register("worker", (m) => {
      seen.push(m.payload);
      b.unregister("worker");
      failSends = true;
    });
    for (const n of [1, 2, 3, 4]) {
      await inner.send({
        type: "t",
        payload: n,
        from: "x",
        to: "worker",
        timestamp: 0,
      } as A2AMessage);
    }
    expect(await b.pump()).toBe(1);
    expect(await inner.poll("worker")).toHaveLength(0);
    failSends = false;
    const later: unknown[] = [];
    b.register("worker", (m) => {
      later.push(m.payload);
    });
    expect(await b.pump()).toBe(3);
    expect(seen).toEqual([1]);
    expect(later).toEqual([2, 3, 4]);
  });
});
