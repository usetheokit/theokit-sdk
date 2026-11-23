import { describe, expect, it, vi } from "vitest";
import type { AgentLease } from "../src/agent.js";
import { Agent } from "../src/agent.js";
import { SessionPoolClosedError } from "../src/errors.js";
import { createSessionPool } from "../src/session-pool.js";
import type { AgentOptions, SDKAgent } from "../src/types/agent.js";

function harness(extra: Record<string, unknown> = {}) {
  const agents = new Map<string, SDKAgent>();
  const open = vi.fn((_key: string) => ({ model: { id: "m" } }) as never as AgentOptions);
  const lease = async (agentId: string, _o: AgentOptions): Promise<AgentLease> => {
    let agent = agents.get(agentId);
    if (agent === undefined) {
      agent = { agentId, dispose: vi.fn(async () => {}) } as never as SDKAgent;
      agents.set(agentId, agent);
    }
    return { agent, agentId, release: () => {} };
  };
  const pool = createSessionPool({ open, ...extra }, lease);
  return { pool, open, agents };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("session pool", () => {
  it("exposes Agent.sessionPool", () => {
    expect(typeof Agent.sessionPool).toBe("function");
  });

  it("reset during a held turn: turn finishes on old agent, next lease gets a new one", async () => {
    const { pool, agents } = harness();
    const a = await pool.lease("chat");
    expect(a.agentId).toBe("chat-g0");
    await pool.reset("chat");
    await tick();
    expect(a.agent.dispose).not.toHaveBeenCalled();
    const b = await pool.lease("chat");
    expect(b.agentId).toBe("chat-g1");
    a.release();
    await tick();
    expect(agents.get("chat-g0")?.dispose).toHaveBeenCalledTimes(1);
    expect(b.agent.dispose).not.toHaveBeenCalled();
  });

  it("a lease started during reset resolves to the new generation", async () => {
    let finish: (n: number) => void = () => {};
    let n = 0;
    const generations = {
      current: () => n,
      next: () => new Promise<number>((r) => (finish = r)),
    };
    const { pool } = harness({ generations });
    const reset = pool.reset("k");
    await tick();
    const pending = pool.lease("k");
    await tick();
    n = 1;
    finish(1);
    await reset;
    expect((await pending).agentId).toBe("k-g1");
  });

  it("rebuild keeps the id, disposes after release, and reopens", async () => {
    const { pool, open } = harness();
    const a = await pool.lease("k");
    pool.rebuild("k");
    const next = pool.lease("k");
    await tick();
    expect(a.agent.dispose).not.toHaveBeenCalled();
    a.release();
    const b = await next;
    expect(a.agent.dispose).toHaveBeenCalledTimes(1);
    expect(b.agentId).toBe(a.agentId);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("disposeAll drains up to drainMs, reports busy keys and disposes everything", async () => {
    const { pool, agents } = harness();
    const held = await pool.lease("busy");
    (await pool.lease("idle")).release();
    const t0 = Date.now();
    const res = await pool.disposeAll({ drainMs: 50 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45);
    expect(res.stillRunning).toEqual(["busy"]);
    for (const a of agents.values()) expect(a.dispose).toHaveBeenCalledTimes(1);
    held.release();
  });

  it("rejects a lease after disposeAll started", async () => {
    const { pool } = harness();
    await pool.disposeAll();
    const err = await pool.lease("k").catch((e) => e);
    expect(err).toBeInstanceOf(SessionPoolClosedError);
    expect(err.message).toBe("session pool is closed: no new lease for k");
  });

  it("concurrent first leases open once", async () => {
    const { pool, open } = harness();
    const [a, b] = await Promise.all([pool.lease("k"), pool.lease("k")]);
    expect(a.agent).toBe(b.agent);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("maxOpen retires only unheld agents", async () => {
    const { pool, agents } = harness({ maxOpen: 1 });
    const a = await pool.lease("a");
    const b = await pool.lease("b");
    await tick();
    expect(agents.get("a-g0")?.dispose).not.toHaveBeenCalled();
    a.release();
    const c = await pool.lease("c");
    await tick();
    expect(agents.get("a-g0")?.dispose).toHaveBeenCalledTimes(1);
    expect(agents.get("b-g0")?.dispose).not.toHaveBeenCalled();
    b.release();
    c.release();
  });

  it("idleMs retires unheld agents", async () => {
    const { pool, agents } = harness({ idleMs: 20 });
    (await pool.lease("a")).release();
    await new Promise((r) => setTimeout(r, 80));
    expect(agents.get("a-g0")?.dispose).toHaveBeenCalledTimes(1);
    await pool.disposeAll();
  });

  it("reset and disposeAll during a pending inner lease still dispose the agent", async () => {
    for (const how of ["reset", "disposeAll"] as const) {
      const agent = { agentId: "k-g0", dispose: vi.fn(async () => {}) } as never as SDKAgent;
      let grant: () => void = () => {};
      let calls = 0;
      const lease = (agentId: string): Promise<AgentLease> =>
        ++calls > 1
          ? Promise.resolve({
              agent: { agentId, dispose: async () => {} } as never as SDKAgent,
              agentId,
              release: () => {},
            })
          : new Promise((r) => {
              grant = () => r({ agent, agentId, release: () => {} });
            });
      const pool = createSessionPool({ open: () => ({ model: { id: "m" } }) as never }, lease);
      const pending = pool.lease("k").catch((e: unknown) => e);
      await tick();
      const done = how === "reset" ? pool.reset("k") : pool.disposeAll({ drainMs: 20 });
      await tick();
      grant();
      await done.catch(() => undefined);
      const got = await pending;
      await tick();
      if (how === "disposeAll") expect(got).toBeInstanceOf(SessionPoolClosedError);
      else expect((got as AgentLease).agentId).toBe("k-g1");
      await tick();
      expect(agent.dispose).toHaveBeenCalledTimes(1);
    }
  });
});
