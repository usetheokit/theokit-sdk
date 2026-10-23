/**
 * B-498: the caller's `throwOnError` view of a run, and the SDK's resolving reader.
 */
import { describe, expect, it, vi } from "vitest";

import { AuthenticationError } from "../../../src/errors.js";
import {
  readRunResolving,
  wrapRunWithThrowOnError,
} from "../../../src/internal/runtime/lifecycle/throw-on-error-run.js";
import type { Run, RunResult } from "../../../src/types/run.js";

function fakeRun(result: RunResult): Run & { waitCalls: () => number } {
  let calls = 0;
  const run = {
    id: result.id,
    agentId: "agent-1",
    status: result.status,
    wait: async () => {
      calls += 1;
      return result;
    },
    stream: async function* () {
      yield { type: "status", status: result.status } as never;
    },
    events: async function* () {},
    cancel: vi.fn(async () => {}),
    conversation: async function (this: { id: string }) {
      return [{ id: this.id }] as never;
    },
    supports: () => true,
    unsupportedReason: () => undefined,
    onDidChangeStatus: () => () => {},
    waitCalls: () => calls,
  };
  return run as unknown as Run & { waitCalls: () => number };
}

const authError = new AuthenticationError("bad key", { code: "openrouter_auth_failed" });
const errorResult: RunResult = {
  id: "run-1",
  status: "error",
  error: {
    message: "openrouter API error: auth_failed (HTTP 401)",
    code: "auth_failed",
    cause: authError,
  },
};

describe("wrapRunWithThrowOnError", () => {
  it("rejects_with_the_same_object_as_the_typed_cause", async () => {
    const view = wrapRunWithThrowOnError(fakeRun(errorResult));

    await expect(view.wait()).rejects.toBe(authError);
    expect((await readRunResolving(view)).error?.cause).toBe(authError);
  });

  it("memoises_wait", async () => {
    const inner = fakeRun({ id: "run-2", status: "finished", result: "ok" });
    const view = wrapRunWithThrowOnError(inner);

    const first = view.wait();
    const second = view.wait();

    expect(first).toBe(second);
    await first;
    expect(inner.waitCalls()).toBe(1);
  });

  it.each([
    ["finished", { id: "run-3", status: "finished", result: "ok" }],
    ["cancelled", { id: "run-4", status: "cancelled" }],
    ["error without a detail", { id: "run-5", status: "error" }],
  ] as const)("resolves_a_%s_run", async (_label, result) => {
    const view = wrapRunWithThrowOnError(fakeRun(result as RunResult));

    await expect(view.wait()).resolves.toEqual(result);
  });

  it("resolves_a_tripwire_run_under_throwOnError", async () => {
    const result: RunResult = {
      id: "run-6",
      status: "cancelled",
      tripwire: { reason: "blocked", processorId: "guard" },
    };
    const view = wrapRunWithThrowOnError(fakeRun(result));

    await expect(view.wait()).resolves.toBe(result);
  });

  it("forwards_conversation_and_stream_on_an_error_run", async () => {
    const view = wrapRunWithThrowOnError(fakeRun(errorResult));

    await expect(view.conversation()).resolves.toEqual([{ id: "run-1" }]);
    const streamed: unknown[] = [];
    for await (const event of view.stream()) streamed.push(event);
    expect(streamed).toHaveLength(1);
    expect(view.id).toBe("run-1");
    expect(view.status).toBe("error");
  });

  it("forwards_cancel", async () => {
    const inner = fakeRun({ id: "run-7", status: "running" } as unknown as RunResult);
    const view = wrapRunWithThrowOnError(inner);

    await view.cancel();

    expect(inner.cancel).toHaveBeenCalledTimes(1);
  });

  it("creates_no_rejection_until_wait_is_called", () => {
    const inner = fakeRun(errorResult);

    wrapRunWithThrowOnError(inner);

    expect(inner.waitCalls()).toBe(0);
  });
});

describe("readRunResolving", () => {
  it("resolves_a_view_over_a_failed_run", async () => {
    const view = wrapRunWithThrowOnError(fakeRun(errorResult));

    await expect(readRunResolving(view)).resolves.toBe(errorResult);
  });

  it("reads_a_plain_run_through_its_own_wait", async () => {
    const inner = fakeRun(errorResult);

    await expect(readRunResolving(inner)).resolves.toBe(errorResult);
    expect(inner.waitCalls()).toBe(1);
  });
});
