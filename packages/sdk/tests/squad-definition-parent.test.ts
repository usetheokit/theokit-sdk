import { describe, expect, it, vi } from "vitest";
import { agentOptionsFromDefinition } from "../src/a2a/index.js";
import { ConfigurationError } from "../src/errors.js";
import { Squad } from "../src/squad.js";
import type { AgentDefinition, CustomTool } from "../src/types/agent.js";

const tool = (name: string): CustomTool =>
  ({ name, description: name, parameters: {}, handler: async () => "" }) as unknown as CustomTool;
const def: AgentDefinition = { description: "d", prompt: "p", tools: ["read"] };
const parentTools = [tool("read"), tool("write")];

describe("agentOptionsFromDefinition", () => {
  it("narrows tools to the whitelist and withholds unlisted builtins", () => {
    const o = agentOptionsFromDefinition(def, {
      apiKey: "k",
      tools: parentTools,
      withheldBuiltinTools: ["shell"],
      builtinTools: ["shell"],
      local: { cwd: "/w" },
    });
    expect(o.tools?.map((t) => t.name)).toEqual(["read"]);
    expect(o.withheldBuiltinTools).toContain("shell");
    expect(o.apiKey).toBe("k");
    expect(o.local?.cwd).toBe("/w");
  });

  it("inherit takes the parent's ModelSelection with params", () => {
    const model = { id: "m", params: [{ id: "thinking", value: "low" }] };
    const o = agentOptionsFromDefinition({ ...def, model: "inherit" }, { model });
    expect(o.model).toEqual(model);
  });

  it("an empty definition withheld list does not release the parent's", () => {
    const o = agentOptionsFromDefinition(
      { description: "d", prompt: "p", withheldBuiltinTools: [] },
      { withheldBuiltinTools: ["shell"] },
    );
    expect(o.withheldBuiltinTools).toEqual(["shell"]);
  });
});

describe("Squad parent", () => {
  it("refuses a definition with tools and no parent", () => {
    expect(() => Squad.create({ agents: [def] })).toThrow(ConfigurationError);
  });

  it("builds a member from the inherited options: read, no write, shell withheld", async () => {
    const { Agent } = await import("../src/agent.js");
    const create = vi.spyOn(Agent, "create").mockRejectedValue(new Error("stop"));
    const squad = Squad.create({
      agents: [def],
      parent: {
        apiKey: "k",
        tools: parentTools,
        withheldBuiltinTools: ["shell"],
        builtinTools: ["shell"],
      },
    });
    await squad.run("hi").catch(() => undefined);
    const opts = create.mock.calls[0]?.[0];
    expect(opts?.tools?.map((t) => t.name)).toEqual(["read"]);
    expect(opts?.withheldBuiltinTools).toContain("shell");
    expect(opts?.apiKey).toBe("k");
    create.mockRestore();
  });
});
