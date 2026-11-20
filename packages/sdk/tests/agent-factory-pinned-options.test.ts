import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentOptions } from "../src/index.js";
import { Agent, AgentFactory, ConfigurationError } from "../src/index.js";

function spyCreate(): { last: () => AgentOptions } {
  const spy = vi.spyOn(Agent, "create").mockResolvedValue({} as never);
  return { last: () => spy.mock.calls.at(-1)?.[0] as AgentOptions };
}

describe("AgentFactory pinned options", () => {
  afterEach(() => vi.restoreAllMocks());

  it("pinned memory holds against an override", async () => {
    const s = spyCreate();
    const f = AgentFactory.create({ pinned: { memory: { enabled: false } } });
    await f.forSession("a", { memory: { enabled: true } });
    expect(s.last().memory?.enabled).toBe(false);
  });

  it("pinned local.hooks holds and the override cwd is kept", async () => {
    const s = spyCreate();
    const gate = { PreToolUse: [] } as never;
    const other = { PostToolUse: [] } as never;
    const f = AgentFactory.create({ pinned: { local: { hooks: gate } } });
    await f.forSession("a", { local: { cwd: "/tmp/x", hooks: other } });
    expect(s.last().local?.hooks).toBe(gate);
    expect(s.last().local?.cwd).toBe("/tmp/x");
  });

  it("withheldBuiltinTools is a union", async () => {
    const s = spyCreate();
    const f = AgentFactory.create({ pinned: { withheldBuiltinTools: ["shell"] } });
    await f.forSession("a", { withheldBuiltinTools: ["memory_get"] });
    expect([...(s.last().withheldBuiltinTools ?? [])].sort()).toEqual(["memory_get", "shell"]);
    await f.forSession("a", { withheldBuiltinTools: [] });
    expect(s.last().withheldBuiltinTools).toEqual(["shell"]);
  });

  it("defaults lose to overrides, pinned sendDefaults merge per key, agentId wins", async () => {
    const s = spyCreate();
    const f = AgentFactory.create({
      defaults: { name: "base", sendDefaults: { toolResultGuard: undefined } },
      pinned: { sendDefaults: { perToolTimeoutMs: 5 } },
    });
    await f.getOrCreate("a", { name: "mine", agentId: "zzz" }).catch(() => undefined);
    await f.forSession("b", { name: "mine", sendDefaults: { perToolTimeoutMs: 9 } });
    expect(s.last().name).toBe("mine");
    expect(s.last().sendDefaults?.perToolTimeoutMs).toBe(5);
    expect(s.last().agentId).toBe("b");
  });

  it("throws on a mixed shape naming the key", () => {
    expect(() => AgentFactory.create({ defaults: {}, model: "x" } as never)).toThrow(
      ConfigurationError,
    );
    expect(() => AgentFactory.create({ defaults: {}, model: "x" } as never)).toThrow(/model/);
  });
});
