/**
 * Muse Code (`meta/<model>`, #976) against the real service (#1000).
 *
 * Opt-in: needs the `muse` CLI on PATH, signed in, on a Meta team with active billing,
 * plus THEOKIT_REAL_MUSE=1 and THEOCLAW_MODEL=meta/<model>.
 */

import { describe, expect, it } from "vitest";

import { Agent } from "../../../src/index.js";
import { useTempCwd } from "../../helpers/temp-workspace.js";

useTempCwd();

const modelId = process.env.THEOCLAW_MODEL ?? "";
const enabled = process.env.THEOKIT_REAL_MUSE === "1" && modelId.startsWith("meta/");

describe.skipIf(!enabled)("real-llm: meta/ (Muse Code)", () => {
  it("answers the pong prompt", async () => {
    const agent = await Agent.create({ model: { id: modelId } });
    try {
      const run = await agent.send("Reply only: pong");
      const result = await run.wait();
      expect(result.status).toBe("finished");
      expect(result.result?.trim().toLowerCase()).toContain("pong");
    } finally {
      await agent.dispose();
    }
  }, 120_000);
});
