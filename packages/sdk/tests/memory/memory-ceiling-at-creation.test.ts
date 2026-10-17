import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent, ConfigurationError } from "../../src/index.js";
import {
  clearAgentRegistry,
  invalidateRegistryHydration,
} from "../../src/internal/runtime/registry/agent-registry.js";
import type { AgentOptions } from "../../src/types/agent.js";
import { removeTempDirRobust } from "../helpers/temp-workspace.js";

/*
 * B-380 review fix (loop-code-review #21): `Agent.create` and `Agent.resume` used to accept an
 * invalid `memory.maxFacts`. Only the writer refused it, on the first write, and the prompt-driven
 * caller turns every write error into a diagnostic line, so a typo switched memory off for the
 * agent's whole life while nothing failed. The ceiling is now checked where the options come in,
 * before the agent exists.
 */

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "theokit-ceiling-create-"));
  clearAgentRegistry();
  invalidateRegistryHydration();
});

afterEach(async () => {
  clearAgentRegistry();
  invalidateRegistryHydration();
  await removeTempDirRobust(cwd);
});

const optionsWith = (maxFacts: unknown, enabled = true): AgentOptions => ({
  apiKey: "theo_test_fixture_key",
  model: { id: "google/gemini-2.0-flash-001" },
  local: { cwd },
  memory: { enabled, directory: join(cwd, "memory"), maxFacts: maxFacts as number },
});

async function refusalOf(act: () => Promise<unknown>): Promise<ConfigurationError> {
  try {
    await act();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigurationError);
    return e as ConfigurationError;
  }
  throw new Error("expected the call to be refused, and it was accepted");
}

describe("an invalid memory ceiling is refused before the agent exists", () => {
  const invalid: Array<[label: string, value: unknown]> = [
    ["zero", 0],
    ["a negative number", -1],
    ["a fraction", 1.5],
    ["NaN", Number.NaN],
    ["a numeric string", "3"],
    ["null", null],
  ];

  for (const [label, value] of invalid) {
    it(`refuses ${label} at Agent.create with invalid_memory_ceiling`, async () => {
      const err = await refusalOf(() => Agent.create(optionsWith(value)));
      expect(err.code, "the code a caller branches on").toBe("invalid_memory_ceiling");
      expect(err.message).toContain("memory.maxFacts");
    });
  }

  it("refuses an invalid ceiling at Agent.create while memory is disabled", async () => {
    // A typo here waits for the day someone turns memory on; refusing it now is cheaper.
    const err = await refusalOf(() => Agent.create(optionsWith(0, false)));
    expect(err.code).toBe("invalid_memory_ceiling");
  });

  it("accepts a positive integer ceiling at Agent.create", async () => {
    const agent = await Agent.create(optionsWith(1));
    await agent.dispose();
    expect(agent.agentId).not.toBe("");
  });

  it("resumes an agent whose persisted ceiling is valid", async () => {
    const agent = await Agent.create(optionsWith(3));
    await agent.dispose();
    const resumed = await Agent.resume(agent.agentId, {});
    await resumed.dispose();
    expect(resumed.agentId).toBe(agent.agentId);
  });

  it("refuses an invalid ceiling passed to Agent.resume with invalid_memory_ceiling", async () => {
    const agent = await Agent.create(optionsWith(3));
    await agent.dispose();
    const err = await refusalOf(() =>
      Agent.resume(agent.agentId, { memory: { enabled: true, maxFacts: 0 } }),
    );
    expect(err.code, "the code a caller branches on").toBe("invalid_memory_ceiling");
  });
});
