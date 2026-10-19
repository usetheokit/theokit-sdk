import { describe, expect, it } from "vitest";
import {
  fromSerialized,
  stripSecretsFromOptions,
} from "../../src/internal/runtime/registry/agent-registry-store.js";

/*
 * B-380: `Agent.resume` rehydrates an agent from what `stripSecretsFromOptions` persisted, and
 * `serializeMemory` copies an allowlist of fields. Without `maxFacts` on that list a resumed agent
 * came back with no ceiling and said nothing about it, which is the silent loss the ceiling exists
 * to prevent.
 */
describe("a resumed agent and its memory ceiling", () => {
  it("serialises maxFacts so a resumed agent keeps its ceiling", () => {
    const serialized = stripSecretsFromOptions({
      model: "m",
      memory: { enabled: true, maxFacts: 3 },
    });
    expect(serialized.memory).toEqual({ enabled: true, maxFacts: 3 });
    const restored = fromSerialized({
      agentId: "a",
      runtime: "local",
      createdAt: 0,
      lastModified: 0,
      archived: false,
      options: serialized,
    } as Parameters<typeof fromSerialized>[0]);
    expect(restored.options.memory?.maxFacts).toBe(3);
  });

  it("omits maxFacts from the serialised memory when none was declared", () => {
    const serialized = stripSecretsFromOptions({ model: "m", memory: { enabled: true } });
    expect(serialized.memory).toEqual({ enabled: true });
  });
});
