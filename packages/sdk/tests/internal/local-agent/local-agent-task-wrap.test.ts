/**
 * B-625: `registerRunAsTask` — the Task a `send({ task })` run is registered as.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthenticationError } from "../../../src/errors.js";
import { registerRunAsTask } from "../../../src/internal/local-agent/local-agent-task-wrap.js";
import { wrapRunWithThrowOnError } from "../../../src/internal/runtime/lifecycle/throw-on-error-run.js";
import { __resetTaskRegistryForTests, get } from "../../../src/internal/task/registry.js";
import type { Run, RunResult } from "../../../src/types/run.js";
import { pollUntil } from "../../helpers/poll-until.js";

function fakeRun(
  id: string,
  wait: () => Promise<RunResult>,
): Run & { cancel: ReturnType<typeof vi.fn> } {
  return {
    id,
    agentId: "agent-1",
    status: "running",
    wait,
    cancel: vi.fn(async () => {}),
  } as unknown as Run & {
    cancel: ReturnType<typeof vi.fn>;
  };
}

describe("registerRunAsTask", () => {
  beforeEach(() => __resetTaskRegistryForTests());
  afterEach(() => __resetTaskRegistryForTests());

  it("resolves the task with status error when a throwOnError view of the run failed", async () => {
    const cause = new AuthenticationError("bad key", { code: "openrouter_auth_failed" });
    const failed = {
      id: "run-err",
      status: "error",
      error: { message: "bad key", cause },
    } as unknown as RunResult;
    const view = wrapRunWithThrowOnError(fakeRun("run-err", async () => failed));
    registerRunAsTask(view, "agent-1", { id: "task-err" }, "go");
    await pollUntil(async () => (await get("task-err"))?.state === "finished");
    const handle = await get("task-err");
    expect(handle?.result).toEqual({ status: "error", result: undefined });
  });

  it("cancels the run when the task's signal aborts", async () => {
    let release: (r: RunResult) => void = () => {};
    const run = fakeRun(
      "run-abort",
      () =>
        new Promise<RunResult>((r) => {
          release = r;
        }),
    );
    registerRunAsTask(run, "agent-1", { id: "task-abort" }, "go");
    await pollUntil(async () => (await get("task-abort"))?.state === "running");
    const { cancel } = await import("../../../src/internal/task/registry.js");
    await cancel("task-abort");
    await pollUntil(async () => run.cancel.mock.calls.length === 1);
    release({ id: "run-abort", status: "cancelled" } as RunResult);
  });

  it("previews 120 chars of the prompt and lets user meta override it", async () => {
    const done = { id: "r", status: "finished", result: "ok" } as unknown as RunResult;
    registerRunAsTask(
      fakeRun("r1", async () => done),
      "agent-1",
      true,
      "x".repeat(300),
    );
    registerRunAsTask(
      fakeRun("r2", async () => done),
      "agent-1",
      { id: "t2", meta: { promptPreview: "mine" } },
      "y".repeat(300),
    );
    const { list } = await import("../../../src/internal/task/registry.js");
    await pollUntil(async () => (await list()).length === 2);
    const all = await list();
    const auto = all.find((t) => t.id !== "t2");
    expect(auto?.meta?.promptPreview).toBe("x".repeat(120));
    expect(all.find((t) => t.id === "t2")?.meta?.promptPreview).toBe("mine");
  });
});
