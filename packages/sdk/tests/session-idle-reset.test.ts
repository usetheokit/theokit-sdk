/**
 * `sessionIdleResetMinutes` — a fresh session after N idle minutes (B-599).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Agent } from "../src/agent.js";
import {
  clearAgentRegistry,
  invalidateRegistryHydration,
} from "../src/internal/runtime/registry/agent-registry.js";
import { clearAllSessions } from "../src/internal/session/agent-session.js";

const MODEL = { id: "openai/gpt-4o-mini" };

describe("AgentOptions.sessionIdleResetMinutes", () => {
  let root: string;

  beforeEach(async () => {
    clearAgentRegistry();
    clearAllSessions();
    invalidateRegistryHydration();
    await Agent.registry.evictAll();
    root = await mkdtemp(join(tmpdir(), "theokit-idle-reset-"));
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    clearAgentRegistry();
    clearAllSessions();
    invalidateRegistryHydration();
    await Agent.registry.evictAll();
    await rm(root, { recursive: true, force: true });
  });

  async function counts(minutes: number | undefined, gaps: number[]): Promise<number[]> {
    const seen: number[] = [];
    const agent = await Agent.create({
      apiKey: "theo_test_idle_reset",
      model: MODEL,
      local: { cwd: root },
      ...(minutes === undefined ? {} : { sessionIdleResetMinutes: minutes }),
      onBeforeSend: (e) => {
        seen.push(e.previousMessageCount);
      },
    });
    await agent.send("first");
    for (const gap of gaps) {
      vi.advanceTimersByTime(gap * 60_000);
      await agent.send("next");
    }
    await agent.dispose();
    return seen;
  }

  it("starts fresh once idle longer than N minutes", async () => {
    const seen = await counts(30, [31]);
    expect(seen[0]).toBe(0);
    expect(seen[1]).toBe(0);
  });

  it("keeps the session when the gap is within N minutes", async () => {
    const seen = await counts(30, [10]);
    expect(seen[1]).toBeGreaterThanOrEqual(1);
  });

  it("never resets when unset", async () => {
    const seen = await counts(undefined, [100000]);
    expect(seen[1]).toBeGreaterThanOrEqual(1);
  });
});
