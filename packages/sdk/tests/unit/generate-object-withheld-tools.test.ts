import { describe, expect, it } from "vitest";
import { z } from "zod";

import { generateObjectImpl } from "../../src/generate-object.js";
import { effectiveToolNames } from "../../src/internal/runtime/validation/effective-tools.js";
import type { AgentOptions, BuiltinToolName, SDKAgent } from "../../src/types/agent.js";

/**
 * B-678 — `generateObject` forwards `withheldBuiltinTools` and `memory` to every transient agent it
 * creates, so a caller can run the structured-output step with no `shell` and no transcript. The
 * injected `deps.create` records every `AgentOptions` it receives; no model is called.
 */

/** A fake `deps.create` that records options and, for the structuring agent, fires the output tool. */
function makeDeps(created: AgentOptions[]) {
  return {
    create: async (opts: AgentOptions): Promise<SDKAgent> => {
      created.push(opts);
      const outputTool = opts.tools?.find((t) => t.name === "output");
      const agent = {
        id: `fake-${created.length}`,
        send: async () => ({
          wait: async () => {
            if (outputTool) {
              try {
                await outputTool.handler({ answer: 42 } as never);
              } catch {
                /* CaptureSentinel: the closure already captured the input */
              }
            }
            return {
              status: "finished",
              result: "The answer is 42.",
              usage: { inputTokens: 3, outputTokens: 5 },
            };
          },
        }),
        dispose: async () => {},
      };
      return agent as unknown as SDKAgent;
    },
    delete: async () => {},
  };
}

const schema = z.object({ answer: z.number() });
const base = {
  schema,
  prompt: "What is the answer?",
  model: { id: "solo-model" },
  local: { cwd: "/tmp" },
};

describe("B-678 — generateObject forwards withheldBuiltinTools and memory", () => {
  it("forwards withheldBuiltinTools and memory to the transient agent", async () => {
    const created: AgentOptions[] = [];
    const result = await generateObjectImpl(
      { ...base, withheldBuiltinTools: ["shell"], memory: { enabled: false } },
      makeDeps(created),
    );

    expect(created).toHaveLength(1);
    expect(created[0]?.withheldBuiltinTools).toEqual(["shell"]);
    expect(created[0]?.memory).toEqual({ enabled: false });
    expect(result.object).toEqual({ answer: 42 });
  });

  it("with a structuringModel, forwards both options to the reasoning and the structuring agent", async () => {
    const created: AgentOptions[] = [];
    await generateObjectImpl(
      {
        ...base,
        model: { id: "big-reasoner" },
        structuringModel: { id: "cheap-structurer" },
        withheldBuiltinTools: ["shell"],
        memory: { enabled: false },
      },
      makeDeps(created),
    );

    expect(created).toHaveLength(2);
    for (const options of created) {
      expect(options.withheldBuiltinTools).toEqual(["shell"]);
      expect(options.memory).toEqual({ enabled: false });
    }
  });

  it("without the options, hands create no withheldBuiltinTools key and no memory key", async () => {
    const created: AgentOptions[] = [];
    await generateObjectImpl(
      { ...base, structuringModel: { id: "cheap-structurer" } },
      makeDeps(created),
    );

    expect(created).toHaveLength(2);
    for (const options of created) {
      expect("withheldBuiltinTools" in options).toBe(false);
      expect("memory" in options).toBe(false);
    }
  });

  it("with shell withheld, the transient agent holds only the output tool", async () => {
    const created: AgentOptions[] = [];
    await generateObjectImpl(
      { ...base, withheldBuiltinTools: ["shell"], memory: { enabled: false } },
      makeDeps(created),
    );

    const options = created[0];
    if (options === undefined) throw new Error("create was never called");
    expect(effectiveToolNames(options).names).toEqual(["output"]);
  });

  it("forwards a frozen withheld list without mutating it", async () => {
    const created: AgentOptions[] = [];
    const withheld: readonly BuiltinToolName[] = Object.freeze(["shell"] as BuiltinToolName[]);
    await generateObjectImpl({ ...base, withheldBuiltinTools: withheld }, makeDeps(created));

    expect(withheld).toEqual(["shell"]);
    expect(created[0]?.withheldBuiltinTools).toEqual(["shell"]);
  });
});
