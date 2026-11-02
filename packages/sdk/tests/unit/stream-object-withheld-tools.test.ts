import { describe, expect, it } from "vitest";
import { z } from "zod";

import { streamObjectImpl } from "../../src/stream-object.js";
import type { AgentOptions, BuiltinToolName, SDKAgent } from "../../src/types/agent.js";

// B-678 — `streamObject` forwards `withheldBuiltinTools` and `memory` to its transient agent. The
// injected `deps.create` records every `AgentOptions` it receives; no model is called.

/** A fake `deps.create` whose run streams nothing and fires the output tool before it settles. */
function makeDeps(created: AgentOptions[]) {
  return {
    create: async (opts: AgentOptions): Promise<SDKAgent> => {
      created.push(opts);
      const outputTool = opts.tools?.find((t) => t.name === "output");
      const agent = {
        id: `fake-${created.length}`,
        send: async () => ({
          stream: async function* () {},
          wait: async () => {
            await outputTool?.handler({ answer: 42 } as never);
            return { status: "finished", usage: { inputTokens: 3, outputTokens: 5 } };
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

async function drain<T>(iterator: AsyncGenerator<T, void, void>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of iterator) events.push(event);
  return events;
}

describe("B-678 — streamObject forwards withheldBuiltinTools and memory", () => {
  it("forwards withheldBuiltinTools and memory to the transient agent", async () => {
    const created: AgentOptions[] = [];
    const events = await drain(
      streamObjectImpl(
        { ...base, withheldBuiltinTools: ["shell"], memory: { enabled: false } },
        makeDeps(created),
      ),
    );

    expect(created).toHaveLength(1);
    expect(created[0]?.withheldBuiltinTools).toEqual(["shell"]);
    expect(created[0]?.memory).toEqual({ enabled: false });
    expect(events.at(-1)).toMatchObject({ type: "complete", object: { answer: 42 } });
  });

  it("without the options, hands create no withheldBuiltinTools key and no memory key", async () => {
    const created: AgentOptions[] = [];
    await drain(streamObjectImpl(base, makeDeps(created)));

    expect(created).toHaveLength(1);
    const options = created[0];
    if (options === undefined) throw new Error("create was never called");
    expect("withheldBuiltinTools" in options).toBe(false);
    expect("memory" in options).toBe(false);
  });

  it("forwards a frozen withheld list without mutating it", async () => {
    const created: AgentOptions[] = [];
    const withheld: readonly BuiltinToolName[] = Object.freeze(["shell"] as BuiltinToolName[]);
    await drain(streamObjectImpl({ ...base, withheldBuiltinTools: withheld }, makeDeps(created)));

    expect(withheld).toEqual(["shell"]);
    expect(created[0]?.withheldBuiltinTools).toEqual(["shell"]);
  });
});
