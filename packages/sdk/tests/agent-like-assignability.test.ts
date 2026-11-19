import { describe, expect, it } from "vitest";
import type { AgentLike, Run, RunLike, SDKAgent } from "../src/index.js";

declare const sdkAgent: SDKAgent;
declare const run: Run;

// Compile-time: the full types satisfy the narrow ones with no cast.
export const agentFromSdk = (): AgentLike => sdkAgent;
export const runFromSdk = (): RunLike => run;

// Compile-time: a minimal fake (agentId + send only) is an AgentLike.
const fakeRun: RunLike = {
  status: "finished",
  stream: async function* () {},
  wait: async () => ({ id: "r1", status: "finished" }),
  cancel: async () => {},
};
const fakeAgent: AgentLike = {
  agentId: "a1",
  send: async () => fakeRun,
};

// Compile-time: a "completed" status is not a RunStatus.
export const badRun: RunLike = {
  status: "finished",
  stream: async function* () {},
  // @ts-expect-error "completed" is not a RunResult status
  wait: async () => ({ id: "r2", status: "completed" }),
  cancel: async () => {},
};

describe("AgentLike / RunLike", () => {
  it("a minimal fake agent works through the narrow port", async () => {
    const r = await fakeAgent.send("hi");
    expect((await r.wait()).status).toBe("finished");
  });
});
