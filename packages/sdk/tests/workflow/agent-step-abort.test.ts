import { describe, expect, it, vi } from "vitest";
import type { SDKAgent } from "../../src/types/agent.js";
import { agentStep, Workflow } from "../../src/workflow.js";

describe("agentStep — abort cancels the in-flight run", () => {
  it("calls run.cancel() when the signal aborts mid-run", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const cancel = vi.fn(async () => release?.());
    const agent = {
      agentId: "a",
      async send() {
        return {
          cancel,
          wait: async () => {
            await gate;
            return { id: "r", status: "cancelled" as const };
          },
        };
      },
    } as unknown as SDKAgent;
    const wf = Workflow.create({ name: "w" })
      .then(agentStep("s", agent, () => "go"))
      .commit();
    const ctrl = new AbortController();
    const p = wf.run("in", { signal: ctrl.signal });
    await new Promise((r) => setTimeout(r, 20));
    ctrl.abort();
    const run = await p;
    expect(run.status).toBe("cancelled");
    expect(run.stepResults[0]?.status).toBe("cancelled");
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
