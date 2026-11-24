/**
 * #338 item 4 — running out of iterations must not look like a provider failure.
 *
 * When the loop exhausts its iteration budget while the model still wants tools and no text was
 * produced, `finalStatus` becomes `"error"`. Until this file, it did so with no `error` detail at
 * all — the same shape a provider error produces (`status: "error"`, empty result, nothing else),
 * so a caller could not tell "the model ran out of turns" from "OpenRouter rejected the request".
 * The report describes hours spent separating exactly those two.
 *
 * `stoppedAtIterationLimit` already existed and is the structured signal, but it is a second field
 * a caller has to know to check; a run that reports an error owes an explanation in the place
 * errors are read.
 *
 * Drives the production `runAgentLoop` with a stub `LlmClient` — the harness in
 * `agent-loop/budget-tracker-wiring.test.ts`, for the reason that file records: a local mirror of
 * the rule passes for as long as someone remembers to edit it alongside the code.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { runAgentLoop } from "../../src/internal/agent-loop/loop.js";
import type { LlmClient, LlmEvent, LlmFinish } from "../../src/internal/llm/types.js";
import { HooksExecutor } from "../../src/internal/runtime/hooks/hooks-executor.js";
import { removeTempDirRobust } from "../helpers/temp-workspace.js";

/**
 * An LLM that never finishes: every turn asks for the same tool and emits no text. That is the
 * shape that exhausts the budget — `lastTurnDecision === "continue"` on the final turn.
 */
function clientAlwaysCallingTools(): LlmClient {
  return {
    name: "stub",
    async *stream(): AsyncGenerator<LlmEvent, LlmFinish, void> {
      // An empty delta, not none: the tool calls ride the RETURN value, so a turn like this emits
      // no stream events at all — and a generator with no `yield` is a lint error. Empty keeps the
      // accumulated text empty, which is the condition the branch under test fires on.
      yield { type: "text_delta", text: "" };
      return {
        stopReason: "tool_use",
        text: "",
        toolCalls: [{ type: "tool_use", id: "call-1", name: "shell", input: { command: "true" } }],
      };
    },
  };
}

describe("iteration-limit exhaustion explains itself (#338 item 4)", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "theokit-iter-limit-"));
    const dir = cwd;
    onTestFinished(async () => {
      await removeTempDirRobust(dir);
    });
  });

  async function driveUntilExhausted(): Promise<Awaited<ReturnType<typeof runAgentLoop>>> {
    const hooks = new HooksExecutor(cwd);
    await hooks.initialize(false);
    return runAgentLoop({
      agentId: "iter-limit",
      runId: "run-iter-limit",
      model: { id: "openai/gpt-4o-mini" },
      userMessage: "keep going",
      llm: clientAlwaysCallingTools(),
      mcp: new Map(),
      hooks,
      shellCwd: cwd,
      shellSandbox: false,
      maxIterations: 2,
    });
  }

  it("still reports the structured truncation signal", async () => {
    // The accepted case for the existing contract — this must not change while the error is added.
    const output = await driveUntilExhausted();

    expect(output.stoppedAtIterationLimit).toBe(true);
  });

  it("carries an error that says the run ran out of iterations, not that something failed", async () => {
    const output = await driveUntilExhausted();

    expect(output.finalStatus).toBe("error");
    expect(output.error).toBeDefined();
    // The distinguishing content: a caller reading only `error` must be able to tell this apart
    // from a provider rejection without also knowing to check a second boolean.
    expect(output.error?.code).toBe("iteration_limit_reached");
    expect(output.error?.message ?? "").toContain("2");
    expect(output.error?.message ?? "").toMatch(/iteration/i);
  });

  it("names the knob that raises the ceiling", async () => {
    // An error that states a limit without naming the way past it makes the reader search for it.
    const output = await driveUntilExhausted();

    expect(output.error?.message ?? "").toContain("maxIterations");
  });
});
