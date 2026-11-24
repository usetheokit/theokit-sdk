import { ConfigurationError } from "@theokit/sdk";
import { describe, expect, it } from "vitest";

import { memoryBackendFromEnv } from "../src/index.js";

const plugin = { kind: "memory", name: "fake" };

describe("memoryBackendFromEnv", () => {
  it("returns undefined for unset, empty and builtin", () => {
    expect(memoryBackendFromEnv({})).toBeUndefined();
    expect(memoryBackendFromEnv({ THEOKIT_MEMORY_BACKEND: "" })).toBeUndefined();
    expect(memoryBackendFromEnv({ THEOKIT_MEMORY_BACKEND: "builtin" })).toBeUndefined();
  });

  it("throws naming the key when a hosted key is missing", () => {
    expect(() =>
      memoryBackendFromEnv({ MEMORY_BACKEND: "mem0" }, { variable: "MEMORY_BACKEND" }),
    ).toThrow(/MEM0_API_KEY/);
    try {
      memoryBackendFromEnv({ MEMORY_BACKEND: "mem0" }, { variable: "MEMORY_BACKEND" });
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigurationError);
    }
  });

  it("lists accepted names for an unknown backend", () => {
    expect(() => memoryBackendFromEnv({ THEOKIT_MEMORY_BACKEND: "nope" })).toThrow(
      /builtin, mem0, honcho, supermemory, sdk-memory/,
    );
  });

  it("names the package and peer when the import fails", async () => {
    const choice = memoryBackendFromEnv(
      { THEOKIT_MEMORY_BACKEND: "mem0", MEM0_API_KEY: "k" },
      { importer: () => Promise.reject(new Error("nope")) },
    );
    expect(choice?.mirrored).toBe(true);
    await expect(choice?.agentOptions()).rejects.toThrow(/@theokit\/memory-mem0.*mem0ai/);
  });

  it.each([
    ["mem0", "MEM0_API_KEY", "@theokit/memory-mem0", "mem0Memory"],
    ["honcho", "HONCHO_API_KEY", "@theokit/memory-honcho", "honchoMemory"],
    ["supermemory", "SUPERMEMORY_API_KEY", "@theokit/memory-supermemory", "supermemoryMemory"],
  ])("wires %s as a plugin", async (name, key, pkg, factory) => {
    const seen: unknown[] = [];
    const choice = memoryBackendFromEnv(
      { THEOKIT_MEMORY_BACKEND: name, [key]: "secret" },
      {
        importer: async (s) => {
          expect(s).toBe(pkg);
          return {
            [factory]: (o: unknown) => {
              seen.push(o);
              return plugin;
            },
          };
        },
      },
    );
    expect((await choice?.agentOptions())?.plugins).toEqual([plugin]);
    expect(seen).toEqual([{ apiKey: "secret" }]);
  });

  it("rejects a factory that returns a non-memory plugin or is missing", async () => {
    const env = { THEOKIT_MEMORY_BACKEND: "mem0", MEM0_API_KEY: "k" };
    await expect(
      memoryBackendFromEnv(env, {
        importer: async () => ({ mem0Memory: () => ({ kind: "tool" }) }),
      })?.agentOptions(),
    ).rejects.toThrow(/kind "memory"/);
    await expect(
      memoryBackendFromEnv(env, { importer: async () => ({}) })?.agentOptions(),
    ).rejects.toThrow(/mem0Memory/);
  });

  it("wires sdk-memory as an unmirrored memoryProvider", async () => {
    const choice = memoryBackendFromEnv({ THEOKIT_MEMORY_BACKEND: "sdk-memory" });
    expect(choice?.mirrored).toBe(false);
    expect((await choice?.agentOptions())?.memoryProvider).toBeDefined();
  });
});
