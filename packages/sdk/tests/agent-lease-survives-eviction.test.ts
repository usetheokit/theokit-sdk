import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent.js";
import { LiveAgentRegistry } from "../src/internal/runtime/registry/live-agent-registry.js";
import { useTempCwd } from "./helpers/temp-workspace.js";

useTempCwd();

const fake = () =>
  ({ dispose: vi.fn(async () => {}) }) as never as import("../src/types/agent.js").SDKAgent;
const opts = (): never =>
  ({
    apiKey: "theo_test_fixture_key",
    model: { id: "openai/gpt-4o-mini" },
    local: { cwd: process.cwd() },
  }) as never;
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("registry leases", () => {
  afterEach(() => {
    vi.useRealTimers();
    Agent.registry.configure({ maxAgents: 100, idleTimeoutMs: 0 });
  });

  it("LRU skips a held entry; release re-checks the bound", async () => {
    const r = new LiveAgentRegistry();
    r.configure({ maxAgents: 1, idleTimeoutMs: 0 });
    const a = fake();
    const b = fake();
    r.set("a", a);
    const release = r.hold("a", a);
    r.set("b", b);
    await tick();
    expect(a.dispose).not.toHaveBeenCalled();
    expect(b.dispose).toHaveBeenCalled();
    release();
    await tick();
    expect(a.dispose).not.toHaveBeenCalled(); // bound satisfied: only A remains

    const c = fake();
    const d = fake();
    const rc = r.hold("c", c);
    const rd = r.hold("d", d);
    r.set("c", c);
    r.set("d", d);
    await tick();
    expect(c.dispose).not.toHaveBeenCalled();
    expect(d.dispose).not.toHaveBeenCalled();
    rc();
    await tick();
    expect(a.dispose).toHaveBeenCalled(); // oldest unheld
    rd();
  });

  it("idle sweep skips held entries until released", async () => {
    vi.useFakeTimers();
    const r = new LiveAgentRegistry();
    r.configure({ idleTimeoutMs: 5_000, sweepIntervalMs: 1_000 });
    const a = fake();
    r.set("a", a);
    const release = r.hold("a", a);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(a.dispose).not.toHaveBeenCalled();
    release();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(a.dispose).toHaveBeenCalled();
    r.configure({ idleTimeoutMs: 0 });
  });

  it("evict on a held entry removes it now and disposes after release", async () => {
    const r = new LiveAgentRegistry();
    const onEvict = vi.fn();
    r.configure({ onEvict });
    const a = fake();
    r.set("a", a);
    const release = r.hold("a", a);
    expect(r.leaseCount("a")).toBe(1);
    expect(await r.evict("a")).toBe(true);
    expect(r.get("a")).toBeUndefined();
    expect(a.dispose).not.toHaveBeenCalled();
    release();
    await tick();
    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(onEvict).toHaveBeenCalledWith("a", "explicit");
    expect(r.leaseCount("a")).toBe(0);
  });

  it("evictAll defers held entries and disposes the rest", async () => {
    const r = new LiveAgentRegistry();
    const a = fake();
    const b = fake();
    r.set("a", a);
    r.set("b", b);
    const release = r.hold("a", a);
    await r.evictAll();
    expect(b.dispose).toHaveBeenCalled();
    expect(a.dispose).not.toHaveBeenCalled();
    release();
    await tick();
    expect(a.dispose).toHaveBeenCalled();
  });

  it("release twice decrements once", () => {
    const r = new LiveAgentRegistry();
    const a = fake();
    r.set("a", a);
    const r1 = r.hold("a", a);
    r.hold("a", a);
    r1();
    r1();
    expect(r.leaseCount("a")).toBe(1);
  });

  it("an overwritten held agent is disposed after release", async () => {
    const r = new LiveAgentRegistry();
    const a = fake();
    const b = fake();
    r.set("a", a);
    const release = r.hold("a", a);
    r.set("a", b);
    await tick();
    expect(a.dispose).not.toHaveBeenCalled();
    expect(r.get("a")).toBe(b);
    release();
    await tick();
    expect(a.dispose).toHaveBeenCalled();
    expect(r.get("a")).toBe(b);
  });
});

describe("Agent.lease", () => {
  afterEach(() => Agent.registry.configure({ maxAgents: 100, idleTimeoutMs: 0 }));

  it("holds a real agent through evict and disposes it on release", async () => {
    const lease = await Agent.lease("lease-real", opts());
    expect(lease.agentId).toBe("lease-real");
    expect(Agent.registry.leaseCount("lease-real")).toBe(1);
    expect(await Agent.registry.evict("lease-real")).toBe(true);
    expect(Agent.registry.get("lease-real")).toBeUndefined();
    lease.release();
    lease.release();
    expect(Agent.registry.leaseCount("lease-real")).toBe(0);
    await tick();
  });

  it("works with the cache disabled", async () => {
    Agent.registry.configure({ maxAgents: 0 });
    const lease = await Agent.lease("lease-zero", opts());
    expect(Agent.registry.leaseCount("lease-zero")).toBe(1);
    expect(await Agent.registry.evict("lease-zero")).toBe(false);
    lease.release();
    expect(Agent.registry.leaseCount("lease-zero")).toBe(0);
    await lease.agent.dispose();
  });

  it("a failed build rejects and leaves no hold", async () => {
    const bad = { ...(opts() as object), local: { cwd: "/nonexistent/\0bad" }, model: undefined };
    await expect(Agent.lease("lease-bad", bad as never)).rejects.toBeInstanceOf(Error);
    expect(Agent.registry.leaseCount("lease-bad")).toBe(0);
  });
});

describe("lease edge cases", () => {
  afterEach(() => Agent.registry.configure({ maxAgents: 100, idleTimeoutMs: 0 }));

  it("evict/evictAll during lease acquisition do not dispose the cached agent", async () => {
    const cached = await Agent.getOrCreate("lease-race", opts());
    const pending = Agent.lease("lease-race", opts());
    await Agent.registry.evict("lease-race");
    const lease = await pending;
    expect(lease.agent).toBe(cached);
    const spy = vi.spyOn(cached, "dispose");
    expect(spy).not.toHaveBeenCalled();
    lease.release();
    await tick();
    expect(spy).toHaveBeenCalledTimes(1);

    const c2 = await Agent.getOrCreate("lease-race2", opts());
    const p2 = Agent.lease("lease-race2", opts());
    await Agent.registry.evictAll();
    const l2 = await p2;
    expect(l2.agent).toBe(c2);
    const spy2 = vi.spyOn(c2, "dispose");
    expect(spy2).not.toHaveBeenCalled();
    l2.release();
    await tick();
    expect(spy2).toHaveBeenCalledTimes(1);
  });

  it("disposing an old evicted instance keeps a newer cached agent", async () => {
    const lease = await Agent.lease("lease-replace", opts());
    await Agent.registry.evict("lease-replace");
    const newer = await Agent.getOrCreate("lease-replace", opts());
    expect(newer).not.toBe(lease.agent);
    lease.release();
    await tick();
    await tick();
    expect(Agent.registry.get("lease-replace")).toBe(newer);
    await newer.dispose();
  });
});
