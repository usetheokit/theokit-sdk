/**
 * The `BudgetTracker.track()` wiring inside `runIteration` (SDK 2.0 Phase 2 / T2.1).
 *
 * ## B-095 — what this file used to be
 *
 * It declared, in its own docblock, that it could not drive the loop "without a stubbed LLM (would
 * pull a deep mock setup)", and tested a local copy of the wiring instead — `emitBudgetTrackEvents`,
 * annotated "Mirror of the wiring inside `runIteration` (loop.ts:365-386) ... MUST be byte-identical
 * in semantics". A mirror passes for exactly as long as someone remembers to edit it alongside the
 * code, which is the property it was supposed to VERIFY rather than assume. No mutation of the real
 * wiring could fail anything here.
 *
 * The premise was also false when it was written. `LlmClient` is a two-member interface
 * (`name` + `stream`), and eighteen test files in this package already drive the real `runAgentLoop`
 * with a stub that implements it in ten lines — `agent-loop/memory-provider-integration.test.ts`
 * among them. The harness the file said did not exist was already in the repo.
 *
 * So every case below drives the production `runAgentLoop` and observes the tracker it was handed.
 * Measured mutants, in `loop.ts` `runIteration`, each killed by the case named next to it.
 *
 * Every import resolves to `src/`, deliberately. The first version of this file took
 * `createCounterBudgetTracker` from the `@theokit/sdk` barrel — the BUILT bundle — while taking
 * `runAgentLoop` from `src/`, which measured a possibly stale artefact against fresh source inside
 * one unit, and failed to resolve at all in a tree with no `dist/`. The tracker has a direct source
 * path, so there is no reason to route it through the build.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { runAgentLoop } from "../../src/internal/agent-loop/loop.js";
import { createCounterBudgetTracker } from "../../src/internal/budget/tracker/budget-tracker-counter.js";
import type { LlmClient, LlmEvent, LlmFinish } from "../../src/internal/llm/types.js";
import { HooksExecutor } from "../../src/internal/runtime/hooks/hooks-executor.js";
import type { ModelSelection } from "../../src/types/agent.js";
import type { BudgetTracker } from "../../src/types/budget-tracker.js";
import { removeTempDirRobust } from "../helpers/temp-workspace.js";

/** A one-round LLM that reports the token counts the wiring is supposed to forward. */
function clientReporting(
  inputTokens?: number,
  outputTokens?: number,
  cache: { cacheReadTokens?: number; cacheWriteTokens?: number } = {},
): LlmClient {
  return {
    name: "stub",
    async *stream(): AsyncGenerator<LlmEvent, LlmFinish, void> {
      yield { type: "text_delta", text: "ok" };
      return {
        stopReason: "end_turn",
        text: "ok",
        toolCalls: [],
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...cache,
      };
    },
  };
}

describe("BudgetTracker.track() wiring, against the production runIteration", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "theokit-budget-wiring-"));
    const __cwdCleanup1 = cwd;
    onTestFinished(async () => {
      await removeTempDirRobust(__cwdCleanup1);
    });
  });

  /** Runs one turn through the real loop with the given tracker and token report. */
  async function drive(options: {
    tracker?: BudgetTracker;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    model?: ModelSelection;
  }): Promise<Awaited<ReturnType<typeof runAgentLoop>>> {
    const hooks = new HooksExecutor(cwd);
    await hooks.initialize(false);
    return runAgentLoop({
      agentId: "budget-wiring",
      runId: "run-budget-wiring",
      model: options.model ?? { id: "openai/gpt-4o-mini" },
      userMessage: "hello",
      llm: clientReporting(options.inputTokens, options.outputTokens, {
        ...(options.cacheReadTokens !== undefined
          ? { cacheReadTokens: options.cacheReadTokens }
          : {}),
        ...(options.cacheWriteTokens !== undefined
          ? { cacheWriteTokens: options.cacheWriteTokens }
          : {}),
      }),
      mcp: new Map(),
      hooks,
      shellCwd: cwd,
      shellSandbox: false,
      ...(options.tracker !== undefined ? { budgetTracker: options.tracker } : {}),
    });
  }

  it("test_both_token_counts_fire_separate_events_in_input_then_output_order", async () => {
    // Kills: deleting either `track` call; swapping their order; forwarding `outputTokens` as the
    // input event; hardcoding the type strings.
    const tracker = createCounterBudgetTracker();
    const track = vi.spyOn(tracker, "track");

    const result = await drive({ tracker, inputTokens: 120, outputTokens: 40 });

    expect(result.finalStatus).toBe("finished");
    expect(track).toHaveBeenCalledTimes(2);
    expect(track).toHaveBeenNthCalledWith(1, {
      tokens: 120,
      model: "openai/gpt-4o-mini",
      type: "input",
    });
    expect(track).toHaveBeenNthCalledWith(2, {
      tokens: 40,
      model: "openai/gpt-4o-mini",
      type: "output",
    });
    // The production tracker's own accumulation, reached through the loop rather than by hand.
    expect(tracker.getTotal().tokens).toBe(160);
  });

  it("test_a_cached_turn_tracks_the_whole_prompt_as_input", async () => {
    // inputTokens is the uncached slice on every client, and BudgetUsageEvent has only "input" and
    // "output". Before the chat-completions client netted the cache out of inputTokens, a cached
    // OpenRouter turn (prompt_tokens 2100, 2048 of them cached) reached the tracker as 2100 input
    // tokens. Tracking only the uncached 52 let a maxTokens ceiling see 2.5% of the prompt.
    const tracker = createCounterBudgetTracker();
    const track = vi.spyOn(tracker, "track");

    await drive({
      tracker,
      inputTokens: 52,
      outputTokens: 8,
      cacheReadTokens: 2000,
      cacheWriteTokens: 48,
    });

    expect(track).toHaveBeenNthCalledWith(1, {
      tokens: 2100,
      model: "openai/gpt-4o-mini",
      type: "input",
    });
    expect(tracker.getTotal().tokens).toBe(2108);
  });

  it("test_a_fully_cached_prompt_still_fires_the_input_event", async () => {
    // The `inputT > 0` guard must read the whole prompt: an uncached slice of 0 with a cache read
    // is still a prompt the tracker has to see.
    const tracker = createCounterBudgetTracker();
    const track = vi.spyOn(tracker, "track");

    await drive({ tracker, inputTokens: 0, outputTokens: 5, cacheReadTokens: 4096 });

    expect(track.mock.calls[0]?.[0]).toMatchObject({ tokens: 4096, type: "input" });
  });

  it("test_zero_input_skips_the_input_event", async () => {
    // Kills: relaxing `if (inputT > 0)` to `>= 0` or dropping the guard — a zero-token event is
    // noise a tracker would have to filter itself.
    const tracker = createCounterBudgetTracker();
    const track = vi.spyOn(tracker, "track");

    await drive({ tracker, inputTokens: 0, outputTokens: 50 });

    expect(track).toHaveBeenCalledTimes(1);
    expect(track.mock.calls[0]?.[0].type).toBe("output");
  });

  it("test_zero_output_skips_the_output_event", async () => {
    const tracker = createCounterBudgetTracker();
    const track = vi.spyOn(tracker, "track");

    await drive({ tracker, inputTokens: 100, outputTokens: 0 });

    expect(track).toHaveBeenCalledTimes(1);
    expect(track.mock.calls[0]?.[0].type).toBe("input");
  });

  it("test_a_provider_that_reports_no_usage_fires_nothing", async () => {
    // The `?? 0` defaults. A provider omitting usage must not be billed as a zero-token turn, and
    // must not crash the round either.
    const tracker = createCounterBudgetTracker();
    const track = vi.spyOn(tracker, "track");

    const result = await drive({ tracker });

    expect(track).not.toHaveBeenCalled();
    expect(result.finalStatus).toBe("finished");
  });

  it("test_the_run_model_id_is_threaded_into_every_event", async () => {
    // Kills: stamping the provider name (`inputs.llm.name`, "stub" here) or a constant instead of
    // the run's model — which is what a cost report is keyed by.
    const tracker = createCounterBudgetTracker();
    const track = vi.spyOn(tracker, "track");

    await drive({
      tracker,
      inputTokens: 10,
      outputTokens: 5,
      model: { id: "anthropic/claude-3-5-sonnet" },
    });

    expect(track.mock.calls[0]?.[0].model).toBe("anthropic/claude-3-5-sonnet");
    expect(track.mock.calls[1]?.[0].model).toBe("anthropic/claude-3-5-sonnet");
  });

  it("test_a_run_with_no_declared_model_reports_auto_rather_than_undefined", async () => {
    // `inputs.model.id ?? "auto"`. A tracker keyed by model must never receive `undefined` as a key.
    const tracker = createCounterBudgetTracker();
    const track = vi.spyOn(tracker, "track");

    await drive({ tracker, inputTokens: 7, outputTokens: 3, model: {} as ModelSelection });

    expect(track.mock.calls[0]?.[0].model).toBe("auto");
  });

  it("test_a_tracker_that_throws_from_track_does_not_break_the_turn", async () => {
    // Hot-path protection: `track()` is contracted non-throwing, and a consumer that violates the
    // contract must not take the run down with it. Driven through the real loop, so this asserts the
    // `try`/`catch` that actually wraps the calls — the mirror could only assert its own copy.
    const throwing: BudgetTracker = {
      track: () => {
        throw new Error("contract violation: track() threw");
      },
      check: () => ({ allowed: true }),
      getTotal: () => ({ tokens: 0 }),
    };

    const result = await drive({ tracker: throwing, inputTokens: 10, outputTokens: 5 });

    expect(result.finalStatus).toBe("finished");
    expect(result.result).toBe("ok");
  });

  it("test_no_tracker_leaves_the_turn_unchanged", async () => {
    // § 4.2 — the accepted case. Without it, wiring that threw on every absent tracker would still
    // pass every case above.
    const result = await drive({ inputTokens: 120, outputTokens: 40 });

    expect(result.finalStatus).toBe("finished");
    expect(result.result).toBe("ok");
  });
});
