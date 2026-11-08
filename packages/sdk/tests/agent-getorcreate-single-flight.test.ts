import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import { useTempCwd } from "./helpers/temp-workspace.js";

useTempCwd();

const opts = (): never =>
  ({
    apiKey: "theo_test_fixture_key",
    model: { id: "openai/gpt-4o-mini" },
    local: { cwd: process.cwd() },
  }) as never;

describe("B-604 — concurrent getOrCreate", () => {
  it("two concurrent calls for one id resolve to one instance", async () => {
    const [a, b] = await Promise.all([
      Agent.getOrCreate("b604-conc", opts()),
      Agent.getOrCreate("b604-conc", opts()),
    ]);
    expect(b).toBe(a);
    await a.dispose();
  });

  it("holds with the live cache disabled (maxAgents 0)", async () => {
    Agent.registry.configure({ maxAgents: 0 });
    try {
      const [a, b] = await Promise.all([
        Agent.getOrCreate("b604-zero", opts()),
        Agent.getOrCreate("b604-zero", opts()),
      ]);
      expect(b).toBe(a);
      await a.dispose();
    } finally {
      Agent.registry.configure({ maxAgents: 100 });
    }
  });
});
