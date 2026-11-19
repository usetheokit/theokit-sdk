import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent.js";
import { SessionPoolClosedError } from "../src/errors.js";
import type { SessionPool } from "../src/session-pool.js";
import { useTempCwd } from "./helpers/temp-workspace.js";

useTempCwd();

const opts = (): never =>
  ({
    apiKey: "theo_test_fixture_key",
    model: { id: "openai/gpt-4o-mini" },
    local: { cwd: process.cwd() },
  }) as never;
const tick = () => new Promise((r) => setTimeout(r, 5));

let n = 0;
function setup(extra: Record<string, unknown> = {}) {
  const prefix = `sp${String(++n)}`;
  const open = vi.fn(async () => opts());
  const pool = Agent.sessionPool({
    open,
    agentId: (k, g) => `${prefix}-${k}-g${String(g)}`,
    ...extra,
  });
  return { pool, open, id: (k: string, g: number) => `${prefix}-${k}-g${String(g)}` };
}
function spy(agent: { dispose: () => Promise<void> }) {
  return vi.spyOn(agent, "dispose");
}

describe("Agent.sessionPool", () => {
  let pool: SessionPool | undefined;
  afterEach(async () => {
    await pool?.disposeAll({ drainMs: 1 });
  });

  it("reset during a held turn keeps the old agent until release", async () => {
    const s = setup();
    pool = s.pool;
    const a = await pool.lease("c");
    const dispose = spy(a.agent as never);
    await pool.reset("c");
    expect(dispose).not.toHaveBeenCalled();
    const b = await pool.lease("c");
    expect(b.agentId).not.toBe(a.agentId);
    expect(b.agentId).toBe(s.id("c", 1));
    a.release();
    await tick();
    expect(dispose).toHaveBeenCalledTimes(1);
    b.release();
  });

  it("a lease started during a reset resolves to the new generation", async () => {
    const s = setup();
    pool = s.pool;
    const r = pool.reset("c");
    const l = await pool.lease("c");
    await r;
    expect(l.agentId).toBe(s.id("c", 1));
    l.release();
  });

  it("rebuild keeps the id, disposes the old instance and reopens", async () => {
    const s = setup();
    pool = s.pool;
    const a = await pool.lease("c");
    const dispose = spy(a.agent as never);
    pool.rebuild("c");
    expect(dispose).not.toHaveBeenCalled();
    a.release();
    await tick();
    expect(dispose).toHaveBeenCalledTimes(1);
    const b = await pool.lease("c");
    expect(b.agentId).toBe(a.agentId);
    expect(b.agent).not.toBe(a.agent);
    expect(s.open).toHaveBeenCalledTimes(2);
    b.release();
  });

  it("a second lease reuses the open agent without calling open again", async () => {
    const s = setup();
    pool = s.pool;
    const [a, b] = await Promise.all([pool.lease("c"), pool.lease("c")]);
    expect(a.agent).toBe(b.agent);
    expect(s.open).toHaveBeenCalledTimes(1);
    a.release();
    b.release();
  });

  it("maxOpen retires the least recently used unheld agent", async () => {
    const s = setup({ maxOpen: 1 });
    pool = s.pool;
    const a = await pool.lease("a");
    const dispose = spy(a.agent as never);
    a.release();
    const b = await pool.lease("b");
    await tick();
    expect(dispose).toHaveBeenCalled();
    b.release();
  });

  it("disposeAll drains for drainMs, reports the busy key and disposes everything", async () => {
    const s = setup();
    pool = s.pool;
    const held = await pool.lease("busy");
    const idle = await pool.lease("idle");
    idle.release();
    const d1 = spy(held.agent as never);
    const d2 = spy(idle.agent as never);
    const t0 = Date.now();
    const res = await pool.disposeAll({ drainMs: 50 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(40);
    expect(res.stillRunning).toEqual(["busy"]);
    expect(d1).toHaveBeenCalled();
    expect(d2).toHaveBeenCalled();
    held.release();
  });

  it("disposeAll returns early once leases are released", async () => {
    pool = setup().pool;
    const l = await pool.lease("c");
    setTimeout(() => l.release(), 10);
    const res = await pool.disposeAll({ drainMs: 5000 });
    expect(res.stillRunning).toEqual([]);
  });

  it("rejects a lease after disposeAll started", async () => {
    pool = setup().pool;
    void pool.disposeAll({ drainMs: 1 });
    const err = await pool.lease("k").catch((e) => e);
    expect(err).toBeInstanceOf(SessionPoolClosedError);
    expect(err.message).toBe("session pool is closed: no new lease for k");
  });
});
