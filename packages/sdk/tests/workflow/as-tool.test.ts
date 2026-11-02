import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  __resetSnapshotStoresForTests,
  fn,
  Workflow,
  WorkflowToolError,
  workflowAsTool,
} from "../../src/workflow.js";

/**
 * SE19 — `workflowAsTool(workflow, spec)` exposes a `Workflow` as an agent
 * `CustomTool`, completing the a peer framework "X as tools" trio (tools; agents-as-tools
 * via `SubAgent`; workflows-as-tools). The caller supplies the tool
 * `inputSchema` (a `Workflow` carries no top-level schema); the handler validates
 * the input, runs the workflow, and returns its output. A failed run raises a
 * typed `WorkflowToolError`.
 */
describe("workflowAsTool (SE19)", () => {
  const completedRun = (output: unknown) => ({
    id: "r1",
    name: "wf",
    status: "completed" as const,
    output,
    startedAt: 0,
    stepResults: [],
  });

  it("runs the workflow with the parsed input and returns its output", async () => {
    const workflow = { run: vi.fn().mockResolvedValue(completedRun({ result: 42 })) };
    const tool = workflowAsTool(workflow, {
      name: "calc",
      description: "Runs a calculation workflow",
      inputSchema: z.object({ x: z.number() }),
    });

    const result = (await tool.handler({ x: 5 })) as string;

    expect(workflow.run).toHaveBeenCalledWith({ x: 5 }); // parsed input forwarded
    expect(JSON.parse(result)).toEqual({ result: 42 });
    expect(tool.name).toBe("calc");
    expect(tool.inputSchema).toBeDefined(); // derived from the caller's inputSchema
  });

  it("returns a string output as-is (not JSON-quoted)", async () => {
    const workflow = { run: vi.fn().mockResolvedValue(completedRun("plain answer")) };
    const tool = workflowAsTool(workflow, {
      name: "echo",
      description: "Echo workflow",
      inputSchema: z.object({ text: z.string() }),
    });
    expect(await tool.handler({ text: "hi" })).toBe("plain answer");
  });

  it("raises a typed WorkflowToolError when the run fails", async () => {
    const workflow = {
      run: vi.fn().mockResolvedValue({
        id: "r1",
        name: "wf",
        status: "failed" as const,
        error: { name: "StepError", message: "step 2 exploded" },
        startedAt: 0,
        stepResults: [],
      }),
    };
    const tool = workflowAsTool(workflow, {
      name: "calc",
      description: "Runs a calculation workflow",
      inputSchema: z.object({ x: z.number() }),
    });

    await expect(tool.handler({ x: 5 })).rejects.toBeInstanceOf(WorkflowToolError);
    await expect(tool.handler({ x: 5 })).rejects.toThrow(/step 2 exploded|failed/);
  });

  it("rejects an input that fails the inputSchema (typed ZodError before running)", async () => {
    const workflow = { run: vi.fn().mockResolvedValue(completedRun("x")) };
    const tool = workflowAsTool(workflow, {
      name: "calc",
      description: "Runs a calculation workflow",
      inputSchema: z.object({ x: z.number() }),
    });
    // Measured: ZodError from the tool's input schema.
    // biome-ignore lint/suspicious/noExplicitAny: intentionally invalid input for the negative case.
    await expect(tool.handler({ x: "not-a-number" } as any)).rejects.toThrow(
      /"expected": "number"/,
    );
    expect(workflow.run).not.toHaveBeenCalled(); // never ran with invalid input
  });
});

/**
 * B-677 — a suspended run is reported with its run id under the `reportSuspended` opt-in, so a model
 * can hand that id to `workflowResumeTool`. Without the opt-in the throw is exactly today's.
 */
describe("workflowAsTool on a suspended run (B-677)", () => {
  afterEach(() => __resetSnapshotStoresForTests());

  const approvalWorkflow = () =>
    Workflow.create({ name: "as-tool-approval" })
      .then(fn<{ amount: number }, number>("draft", async (input) => input.amount))
      .suspend({ id: "approve" })
      .then(fn<unknown, string>("pay", async (input) => `paid ${JSON.stringify(input)}`))
      .commit();

  it("reports_a_suspended_run_with_its_id_when_opted_in", async () => {
    const workflow = approvalWorkflow();
    const runSpy = vi.spyOn(workflow, "run");
    const tool = workflowAsTool(workflow, {
      name: "pay",
      description: "Pays after approval",
      inputSchema: z.object({ amount: z.number() }),
      reportSuspended: true,
    });

    const report = JSON.parse((await tool.handler({ amount: 10 })) as string);

    const run = await runSpy.mock.results[0]?.value;
    expect(Object.keys(report).sort()).toEqual(["runId", "status", "stepId"]);
    expect(report).toEqual({ status: "suspended", runId: run.id, stepId: "approve" });
  });

  it("still_throws_workflow_tool_error_when_not_opted_in", async () => {
    const tool = workflowAsTool(approvalWorkflow(), {
      name: "pay",
      description: "Pays after approval",
      inputSchema: z.object({ amount: z.number() }),
    });

    const error = await Promise.resolve(tool.handler({ amount: 10 })).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(WorkflowToolError);
    expect((error as WorkflowToolError).workflowStatus).toBe("suspended");
  });

  it("reports_exactly_three_keys_even_without_a_step_result", async () => {
    const workflow = {
      run: vi.fn().mockResolvedValue({
        id: "wfr-stub",
        name: "wf",
        status: "suspended" as const,
        startedAt: 0,
        stepResults: [],
      }),
    };
    const tool = workflowAsTool(workflow, {
      name: "stub",
      description: "Stub workflow",
      inputSchema: z.object({}),
      reportSuspended: true,
    });

    const report = JSON.parse((await tool.handler({})) as string);

    expect(Object.keys(report).sort()).toEqual(["runId", "status", "stepId"]);
    expect(report).toEqual({ status: "suspended", runId: "wfr-stub", stepId: null });
  });
});
