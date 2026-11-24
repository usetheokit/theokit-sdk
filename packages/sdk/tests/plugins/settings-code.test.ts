/** `PluginsSettings.code` is read by every consumer that reads the array form. */
import { describe, expect, it } from "vitest";
import { resolveInheritedCredentials } from "../../src/internal/local-agent/real-local-run-tools.js";
import { filterMemoryPlugins } from "../../src/internal/runtime/lifecycle/fork-agent.js";
import { effectiveToolNames } from "../../src/internal/runtime/validation/effective-tools.js";
import type { AgentOptions } from "../../src/types/agent.js";
import type { Plugin } from "../../src/types/plugin.js";

const general = {
  name: "g",
  version: "1",
  kind: "general",
  register: () => undefined,
} as unknown as Plugin;
const memory = {
  name: "m",
  version: "1",
  kind: "memory",
  createProvider: () => ({}),
} as unknown as Plugin;

describe("filterMemoryPlugins", () => {
  it("keeps a memory plugin carried in settings.code", () => {
    expect(filterMemoryPlugins({ enabled: ["x"], code: [general, memory] })).toEqual([memory]);
  });
  it("is undefined for settings without code", () => {
    expect(filterMemoryPlugins({ enabled: ["x"] })).toBeUndefined();
  });
});

describe("resolveInheritedCredentials plugins", () => {
  const inherit = (plugins: unknown) =>
    resolveInheritedCredentials({ plugins } as unknown as AgentOptions).plugins;
  it("hands settings.code to the child", () => {
    expect(inherit({ code: [general] })).toEqual([general]);
  });
  it("hands down nothing for settings without code", () => {
    expect(inherit({ enabled: ["x"] })).toBeUndefined();
    expect(inherit({ code: [] })).toBeUndefined();
  });
  it("passes the array form through", () => {
    expect(inherit([general])).toEqual([general]);
  });
});

describe("effectiveToolNames plugins source", () => {
  const unresolved = (plugins: unknown) =>
    effectiveToolNames({ tools: [], plugins } as unknown as AgentOptions).unresolved;
  it("reports plugins for settings carrying code with an empty enabled list", () => {
    expect(unresolved({ enabled: [], code: [general] })).toContain("plugins");
  });
  it("reports nothing for empty enabled and empty code", () => {
    expect(unresolved({ enabled: [], code: [] })).not.toContain("plugins");
  });
});
