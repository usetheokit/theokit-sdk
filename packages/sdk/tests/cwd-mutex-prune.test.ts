import { describe, expect, it } from "vitest";
import { pendingCwdMutexKeyCount, withCwdMutex } from "../src/internal/persistence/cwd-mutex.js";

describe("withCwdMutex key map pruning (B-605)", () => {
  it("holds no entry for keys with nothing pending after N sessions", async () => {
    const before = pendingCwdMutexKeyCount();
    for (let i = 0; i < 50; i++) {
      await withCwdMutex(`agent-send:s${i}`, async () => i);
      await withCwdMutex(`agent-send:s${i}`, async () => {
        throw new Error("x");
      }).catch(() => undefined);
    }
    await Promise.resolve();
    expect(pendingCwdMutexKeyCount()).toBe(before);
  });

  it("keeps the entry while a call is queued and still serializes", async () => {
    const order: number[] = [];
    const a = withCwdMutex("k", async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push(1);
    });
    const b = withCwdMutex("k", async () => {
      order.push(2);
    });
    expect(pendingCwdMutexKeyCount()).toBeGreaterThan(0);
    await Promise.all([a, b]);
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual([1, 2]);
    expect(pendingCwdMutexKeyCount()).toBe(0);
  });
});
