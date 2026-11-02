import { afterEach, describe, expect, it } from "vitest";
import { ZodError, z } from "zod";

import {
  __resetSnapshotStoresForTests,
  fn,
  Workflow,
  WorkflowResumeStepNotFoundError,
  WorkflowResumeWorkflowMismatchError,
  WorkflowSnapshotNotFoundError,
  WorkflowToolError,
  workflowAsTool,
  workflowResumeTool,
} from "../../src/workflow.js";

/**
 * B-677 — `workflowResumeTool(workflow, spec)` lets a model continue a run that a `workflowAsTool`
 * tool reported as suspended (`reportSuspended: true`). Every case runs offline on the default
 * in-memory snapshot store, which is process-local: a production host passes `{ backend: "json" }`.
 */
describe("workflowResumeTool (B-677)", () => {
  afterEach(() => __resetSnapshotStoresForTests());

  const approvalWorkflow = () =>
    Workflow.create({ name: "resume-tool-approval" })
      .then(fn<{ amount: number }, number>("draft", async (input) => input.amount))
      .suspend({ id: "approve", payloadSchema: z.object({ approved: z.boolean() }) })
      .then(fn<unknown, string>("pay", async (input) => `paid with ${JSON.stringify(input)}`))
      .commit();

  const twoApprovalWorkflow = () =>
    Workflow.create({ name: "resume-tool-two-approvals" })
      .then(fn<{ amount: number }, number>("draft", async (input) => input.amount))
      .suspend({ id: "first" })
      .suspend({ id: "second" })
      .then(fn<unknown, string>("pay", async (input) => `paid with ${JSON.stringify(input)}`))
      .commit();

  const startTool = (workflow: ReturnType<typeof approvalWorkflow>) =>
    workflowAsTool(workflow, {
      name: "pay",
      description: "Pays after approval",
      inputSchema: z.object({ amount: z.number() }),
      reportSuspended: true,
    });

  const suspendedRunId = async (workflow: ReturnType<typeof approvalWorkflow>) => {
    const report = JSON.parse((await startTool(workflow).handler({ amount: 10 })) as string);
    expect(report.status).toBe("suspended");
    return report.runId as string;
  };

  it("resumes_a_suspended_run_by_id_and_payload", async () => {
    const workflow = approvalWorkflow();
    const runId = await suspendedRunId(workflow);
    const resume = workflowResumeTool(workflow, {
      name: "approve_payment",
      description: "Approves a suspended payment",
    });

    const output = await resume.handler({ runId, payload: { approved: true } });

    expect(output).toBe('paid with {"approved":true}');
    expect(resume.name).toBe("approve_payment");
    expect(resume.inputSchema).toMatchObject({ required: ["runId"] });
  });

  it("reports_the_same_run_id_with_a_new_step_id_on_a_second_suspension", async () => {
    const workflow = twoApprovalWorkflow();
    const first = JSON.parse((await startTool(workflow).handler({ amount: 10 })) as string);
    const resume = workflowResumeTool(workflow, {
      name: "approve",
      description: "Approves one step",
      reportSuspended: true,
    });

    const second = JSON.parse((await resume.handler({ runId: first.runId })) as string);

    expect(first.stepId).toBe("first");
    expect(second).toEqual({ status: "suspended", runId: first.runId, stepId: "second" });
    expect(await resume.handler({ runId: first.runId, payload: "ok" })).toBe('paid with "ok"');
  });

  it("throws_on_a_second_suspension_without_the_opt_in", async () => {
    const workflow = twoApprovalWorkflow();
    const runId = await suspendedRunId(workflow);
    const resume = workflowResumeTool(workflow, { name: "approve", description: "Approves" });

    const error = await Promise.resolve(resume.handler({ runId })).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(WorkflowToolError);
    expect((error as WorkflowToolError).workflowStatus).toBe("suspended");
  });

  it("rejects_a_second_resume_of_the_same_id_with_snapshot_not_found", async () => {
    const workflow = approvalWorkflow();
    const runId = await suspendedRunId(workflow);
    const resume = workflowResumeTool(workflow, { name: "approve", description: "Approves" });
    await resume.handler({ runId, payload: { approved: true } });

    await expect(resume.handler({ runId, payload: { approved: true } })).rejects.toBeInstanceOf(
      WorkflowSnapshotNotFoundError,
    );
  });

  it("keeps_the_snapshot_when_the_payload_fails_the_schema", async () => {
    const workflow = approvalWorkflow();
    const runId = await suspendedRunId(workflow);
    const resume = workflowResumeTool(workflow, { name: "approve", description: "Approves" });

    await expect(resume.handler({ runId, payload: { approved: "yes" } })).rejects.toBeInstanceOf(
      ZodError,
    );
    expect(await resume.handler({ runId, payload: { approved: false } })).toBe(
      'paid with {"approved":false}',
    );
  });

  it("resumes_with_the_snapshot_input_when_no_payload_is_given", async () => {
    const workflow = Workflow.create({ name: "resume-tool-no-payload" })
      .then(fn<{ amount: number }, number>("draft", async (input) => input.amount))
      .suspend({ id: "approve" })
      .then(fn<unknown, string>("pay", async (input) => `paid with ${JSON.stringify(input)}`))
      .commit();
    const runId = await suspendedRunId(workflow);
    const resume = workflowResumeTool(workflow, { name: "approve", description: "Approves" });

    expect(await resume.handler({ runId })).toBe("paid with 10");
  });

  it("rejects_an_empty_run_id_before_touching_the_snapshot_store", async () => {
    const resume = workflowResumeTool(approvalWorkflow(), {
      name: "approve",
      description: "Approves",
    });

    const error = await Promise.resolve(resume.handler({ runId: "" })).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(ZodError);
    expect((error as ZodError).issues.map((issue) => issue.path)).toEqual([["runId"]]);
  });
  it("refuses_a_run_id_suspended_by_another_workflow_and_keeps_its_snapshot", async () => {
    const owner = approvalWorkflow();
    const runId = await suspendedRunId(owner);
    const other = Workflow.create({ name: "resume-tool-other" })
      .then(fn<{ amount: number }, number>("draft", async (input) => input.amount))
      .suspend({ id: "approve" })
      .then(fn<unknown, string>("refund", async () => "refunded"))
      .commit();
    const wrongResume = workflowResumeTool(other, { name: "refund", description: "Refunds" });

    const error = await Promise.resolve(
      wrongResume.handler({ runId, payload: { approved: true } }),
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(WorkflowResumeWorkflowMismatchError);
    expect(error).toMatchObject({
      runId,
      snapshotWorkflowName: "resume-tool-approval",
      workflowName: "resume-tool-other",
    });
    const ownResume = workflowResumeTool(owner, { name: "approve", description: "Approves" });
    expect(await ownResume.handler({ runId, payload: { approved: true } })).toBe(
      'paid with {"approved":true}',
    );
  });

  it("raises_step_not_found_when_the_workflow_lacks_the_suspended_step", async () => {
    const runId = await suspendedRunId(approvalWorkflow());
    const diverged = Workflow.create({ name: "resume-tool-approval" })
      .then(fn<{ amount: number }, number>("draft", async (input) => input.amount))
      .suspend({ id: "review" })
      .commit();
    const resume = workflowResumeTool(diverged, { name: "approve", description: "Approves" });

    await expect(resume.handler({ runId, payload: { approved: true } })).rejects.toBeInstanceOf(
      WorkflowResumeStepNotFoundError,
    );
  });

  it("raises_a_workflow_tool_error_with_the_step_error_when_the_resumed_run_fails", async () => {
    const workflow = Workflow.create({ name: "resume-tool-failing" })
      .then(fn<{ amount: number }, number>("draft", async (input) => input.amount))
      .suspend({ id: "approve" })
      .then(
        fn<unknown, string>("pay", async () => {
          throw new Error("card declined");
        }),
      )
      .commit();
    const runId = await suspendedRunId(workflow);
    const resume = workflowResumeTool(workflow, { name: "approve", description: "Approves" });

    const error = await Promise.resolve(resume.handler({ runId })).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(WorkflowToolError);
    expect((error as WorkflowToolError).workflowStatus).toBe("failed");
    expect((error as WorkflowToolError).workflowError?.message).toContain("card declined");
  });

  it("rejects_a_missing_payload_when_the_suspend_step_declares_a_schema", async () => {
    const workflow = approvalWorkflow();
    const runId = await suspendedRunId(workflow);
    const resume = workflowResumeTool(workflow, { name: "approve", description: "Approves" });

    await expect(resume.handler({ runId })).rejects.toBeInstanceOf(ZodError);
    expect(await resume.handler({ runId, payload: { approved: true } })).toBe(
      'paid with {"approved":true}',
    );
  });

  it("describes_the_run_id_and_payload_to_the_model", () => {
    const resume = workflowResumeTool(approvalWorkflow(), {
      name: "approve",
      description: "Approves",
    });
    const properties = (
      resume.inputSchema as { properties: Record<string, { description?: string }> }
    ).properties;

    expect(properties.runId?.description).toMatch(/runId/);
    expect(properties.payload?.description).toMatch(/payload/i);
  });
});
