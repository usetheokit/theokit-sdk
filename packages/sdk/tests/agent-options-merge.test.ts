import { describe, expect, it } from "vitest";
import { AgentFactory, mergeAgentOptions } from "../src/index.js";
import { extractCodePlugins } from "../src/internal/plugins/plugin-guards.js";
import type { Plugin } from "../src/types/plugin.js";

const plug = (name: string) =>
  ({ name, version: "1.0.0", kind: "general", register: () => undefined }) as unknown as Plugin;
const tool = (name: string, d = "") =>
  ({ name, description: d, inputSchema: {}, handler: () => "" }) as never;

describe("mergeAgentOptions", () => {
  it("is exported from the root", () => {
    expect(typeof mergeAgentOptions).toBe("function");
    expect(typeof AgentFactory.create).toBe("function");
  });

  it("concatenates plugin arrays in order", () => {
    const [a, b] = [plug("a"), plug("b")];
    expect(mergeAgentOptions({ plugins: [a] }, { plugins: [b] }).plugins).toEqual([a, b]);
  });

  it("combines a settings layer with an array layer", () => {
    const [a, b] = [plug("a"), plug("b")];
    const out = mergeAgentOptions(
      { plugins: { enabled: ["x"] } },
      { plugins: [a, b] },
      {
        plugins: { enabled: ["y"] },
      },
    );
    expect(out.plugins).toEqual({ enabled: ["x", "y"], code: [a, b] });
    expect(extractCodePlugins(out.plugins)).toEqual([a, b]);
  });

  it("keeps enabled absent when no layer sets it", () => {
    const a = plug("a");
    expect(mergeAgentOptions({ plugins: {} }, { plugins: [a] }).plugins).toEqual({ code: [a] });
  });

  it("concatenates tools by name, later wins in the first position", () => {
    const out = mergeAgentOptions(
      { tools: [tool("a", "1"), tool("b")] },
      { tools: [tool("a", "2"), tool("c")] },
    );
    expect(out.tools?.map((t) => `${t.name}:${t.description}`)).toEqual(["a:2", "b:", "c:"]);
  });

  it("merges local/memory/cloud by key and later layers win elsewhere", () => {
    const out = mergeAgentOptions(
      { local: { cwd: "/a" }, systemPrompt: "one", model: "m1" as never },
      undefined,
      { local: { settingSources: [] }, systemPrompt: "two" },
    );
    expect(out.local).toEqual({ cwd: "/a", settingSources: [] });
    expect(out.systemPrompt).toBe("two");
    expect(out.model).toBe("m1");
  });

  it("does not mutate its inputs", () => {
    const l1 = { plugins: [plug("a")], tools: [tool("a")] };
    const snap = JSON.stringify(l1);
    mergeAgentOptions(l1, { plugins: [plug("b")] });
    expect(JSON.stringify(l1)).toBe(snap);
  });
});
