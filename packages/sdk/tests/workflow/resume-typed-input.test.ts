import { describe, expect, it } from "vitest";
import { z } from "zod";

import { fn, Workflow, workflowResumeTool } from "../../src/workflow.js";

const build = () =>
  Workflow.create<{ a: string }>({ name: "typed-resume", inputSchema: z.object({ a: z.string() }) })
    .then(fn<{ a: string }, string>("draft", async (input) => input.a))
    .suspend({ id: "approve" })
    .commit();

describe("typed workflow resume (#1029)", () => {
  it("accepts a typed committed workflow without a cast", () => {
    // Compile-time only: the functions are never called.
    const typeChecks = async () => {
      const workflow = build();
      await Workflow.resume({ workflow, runId: "r", payload: { approved: true } });
      await Workflow.resume<string>({ workflow, runId: "r" });
      workflowResumeTool(workflow, { name: "resume", description: "resume" });
      // @ts-expect-error misspelled key
      await Workflow.resume({ workflow, runID: "x" });
    };
    expect(typeof typeChecks).toBe("function");
  });
});
