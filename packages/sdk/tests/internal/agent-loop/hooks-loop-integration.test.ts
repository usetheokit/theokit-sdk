/**
 * #65 / #58 — INTEGRATION: prove the real agent loop invokes the wired hooks and
 * honors the between-iteration abort. The unit test (dead-hooks-wired) drives the
 * PluginManager directly; this drives `runAgentLoop` end-to-end so deleting a
 * loop-site invocation FAILS a test (the M0 F-H2 lesson).
 */
import { describe, expect, it } from "vitest";
import { runAgentLoop } from "../../../src/internal/agent-loop/loop.js";
import type { AgentLoopInputs } from "../../../src/internal/agent-loop/types.js";
import type {
  LlmClient,
  LlmEvent,
  LlmFinish,
  LlmToolCallPart,
} from "../../../src/internal/llm/types.js";
import { PluginManager } from "../../../src/internal/plugins/manager.js";
import type { Plugin } from "../../../src/internal/plugins/types.js";
import { PermissionEngine } from "../../../src/permission-engine.js";
import { PermissionPlugin } from "../../../src/permission-plugin.js";
import { makeLoopInputs } from "./_helpers/make-inputs.js";

/** LLM that emits one tool_use on the first turn, then ends. */
function toolThenEndLlm(): LlmClient {
  let turn = 0;
  return {
    name: "mock",
    async *stream(): AsyncGenerator<LlmEvent, LlmFinish, void> {
      yield { type: "text_delta", text: "" };
      turn += 1;
      if (turn === 1) {
        const call: LlmToolCallPart = { type: "tool_use", id: "c1", name: "probe", input: {} };
        return {
          stopReason: "tool_use",
          text: "thinking",
          toolCalls: [call],
          inputTokens: 1,
          outputTokens: 1,
        };
      }
      return {
        stopReason: "end_turn",
        text: "done",
        toolCalls: [],
        inputTokens: 1,
        outputTokens: 1,
      };
    },
  };
}

/** LLM that emits the same tool_use every turn (would loop forever without a stop). */
function repeatingToolLlm(onTurn: () => void): LlmClient {
  return {
    name: "mock",
    async *stream(): AsyncGenerator<LlmEvent, LlmFinish, void> {
      yield { type: "text_delta", text: "" };
      onTurn();
      const call: LlmToolCallPart = { type: "tool_use", id: "c1", name: "probe", input: {} };
      return {
        stopReason: "tool_use",
        text: "",
        toolCalls: [call],
        inputTokens: 1,
        outputTokens: 1,
      };
    },
  };
}

const baseInputs = (llm: LlmClient, extra: Partial<AgentLoopInputs>): AgentLoopInputs =>
  makeLoopInputs({
    agentId: "hooks-integration",
    userMessage: "go",
    llm,
    maxIterations: 8,
    customTools: [
      {
        name: "probe",
        description: "probe",
        inputSchema: { type: "object" },
        handler: () => "raw",
      },
    ],
    ...extra,
  });

function pluginOn(hook: string, fn: (...a: unknown[]) => unknown): Plugin {
  return {
    name: `p-${hook}`,
    version: "1.0",
    kind: "general",
    register: (ctx) => {
      // Braces on purpose: `on` returns a disposer now, and a concise arrow body would make
      // `register` return it — which the Plugin contract types as void | Promise<void>.
      ctx.on(hook as never, fn as never);
    },
  };
}

describe("wired hooks fire through the real loop (#65 integration)", () => {
  it("the loop invokes on_session_start/end, post_tool_call, pre/post_llm_call and transform_tool_result", async () => {
    const fired = new Set<string>();
    let seenToolStdout: string | undefined;
    const mgr = new PluginManager();
    await mgr.initialize([
      pluginOn("on_session_start", () => fired.add("session_start")),
      pluginOn("on_session_end", () => fired.add("session_end")),
      pluginOn("pre_llm_call", () => fired.add("pre_llm")),
      pluginOn("post_llm_call", () => fired.add("post_llm")),
      pluginOn("post_tool_call", (c) => {
        fired.add("post_tool");
        // CAPTURED, not asserted. `PluginManager` runs fire-and-forget hooks inside
        // `try { await h(ctx); } catch (err) { diag(...) }` (manager.ts:215-225) — by design, since a
        // plugin must not break a run. A vitest assertion failure is an ordinary thrown Error, so an
        // `expect` here was caught, written to the diagnostics sink, and the run stayed green. This
        // was the only place in the suite where a failing assertion could not fail its test, and it
        // was verified: replacing the value with "WRONG" inside the hook left all 8 tests passing.
        //
        // The claim is real and worth keeping — the hook sees the tool's raw stdout — so it is
        // asserted after the loop returns, the shape this same file uses correctly three times below.
        seenToolStdout = (c as { result: { stdout: string } }).result.stdout;
      }),
      pluginOn("transform_tool_result", (results) => {
        fired.add("transform_result");
        return results; // fold identity — asserting invocation, not mutation
      }),
    ]);

    await runAgentLoop(baseInputs(toolThenEndLlm(), { pluginManager: mgr }));

    expect(seenToolStdout, "post_tool_call must see the tool's raw stdout").toBe("raw");

    // Every previously-dead hook fired through the REAL loop.
    expect([...fired].sort()).toEqual(
      [
        "post_llm",
        "post_tool",
        "pre_llm",
        "session_end",
        "session_start",
        "transform_result",
      ].sort(),
    );
  });

  it("loop_checks_abort_between_iterations — a cancel after a tool round stops the loop (#58)", async () => {
    let turns = 0;
    const controller = new AbortController();
    const mgr = new PluginManager();
    // Abort the run right after the first tool completes.
    await mgr.initialize([pluginOn("post_tool_call", () => controller.abort())]);

    const output = await runAgentLoop(
      baseInputs(
        repeatingToolLlm(() => (turns += 1)),
        {
          pluginManager: mgr,
          signal: controller.signal,
          maxIterations: 10,
        },
      ),
    );

    // Without the between-iteration abort break the LLM would run all 10 turns.
    // With it, the loop stops right after the first tool round.
    expect(turns).toBe(1);
    expect(output).toBeDefined();
  });

  it("transform_llm_output rewrites the FINAL user-visible text, not just tool-turn history (#65)", async () => {
    const textOnlyLlm: LlmClient = {
      name: "mock",
      async *stream() {
        yield { type: "text_delta", text: "SECRET DATA" };
        return {
          stopReason: "end_turn" as const,
          text: "SECRET DATA",
          toolCalls: [],
          inputTokens: 1,
          outputTokens: 1,
        };
      },
    };
    const mgr = new PluginManager();
    await mgr.initialize([pluginOn("transform_llm_output", () => "REDACTED")]);

    const output = await runAgentLoop(baseInputs(textOnlyLlm, { pluginManager: mgr }));

    // The hook must reach what the caller actually receives, on a text-only turn.
    expect(output.result).toBe("REDACTED");
  });

  it("a between-iteration cancel reports finalStatus 'cancelled', not 'finished' (#58)", async () => {
    const controller = new AbortController();
    const mgr = new PluginManager();
    await mgr.initialize([pluginOn("post_tool_call", () => controller.abort())]);

    const output = await runAgentLoop(
      baseInputs(
        repeatingToolLlm(() => {}),
        {
          pluginManager: mgr,
          signal: controller.signal,
          maxIterations: 10,
        },
      ),
    );

    // A cancelled run must be distinguishable from a clean completion.
    expect(output.finalStatus).toBe("cancelled");
  });
});

describe("SE1 — per-run permissionMode gates through the real loop", () => {
  const probeTool = (onRun: () => void) => ({
    name: "probe",
    description: "probe",
    inputSchema: { type: "object" },
    handler: () => {
      onRun();
      return "raw";
    },
  });

  const runWithMode = async (
    mode: "bypass" | "plan",
  ): Promise<{ toolRan: boolean; denied: boolean }> => {
    let toolRan = false;
    let denied = false;
    // Plugin constructed with `default`; the RUN supplies the mode.
    const engine = new PermissionEngine([{ tool: "probe", action: "ask" }]);
    const mgr = new PluginManager();
    await mgr.initialize([PermissionPlugin.create(engine, { mode: "default" }) as Plugin]);

    await runAgentLoop(
      baseInputs(toolThenEndLlm(), {
        pluginManager: mgr,
        permissionMode: mode,
        customTools: [probeTool(() => (toolRan = true))],
        runEventSink: (e) => {
          if (e.type === "permission_denied") denied = true;
        },
      }),
    );
    return { toolRan, denied };
  };

  it("bypass mode auto-allows the ask verdict → the tool runs", async () => {
    const { toolRan, denied } = await runWithMode("bypass");
    expect(toolRan).toBe(true);
    expect(denied).toBe(false);
  });

  it("plan mode denies the ask verdict → the tool is blocked (permission_denied)", async () => {
    const { toolRan, denied } = await runWithMode("plan");
    expect(toolRan).toBe(false);
    expect(denied).toBe(true);
  });
});

describe("SendOptions-mapped loop knobs are honored end-to-end (#58/#57)", () => {
  it("perToolTimeoutMs bounds a hung tool through the real loop (not just the leaf)", async () => {
    // A tool that never resolves — without the timeout the loop would hang.
    const hungTool = {
      name: "probe",
      description: "hangs",
      inputSchema: { type: "object" },
      handler: () => new Promise<string>(() => {}),
    };
    let captured = "";
    const mgr = new PluginManager();
    await mgr.initialize([
      pluginOn("post_tool_call", (c) => {
        captured = (c as { result: { stderr: string; exitCode?: number } }).result.stderr;
      }),
    ]);
    const output = await runAgentLoop(
      baseInputs(toolThenEndLlm(), {
        pluginManager: mgr,
        customTools: [hungTool],
        perToolTimeoutMs: 60,
      }),
    );
    // The loop applied inputs.perToolTimeoutMs → the hung tool timed out (exit 124), the run finished.
    expect(captured).toMatch(/timed out/);
    expect(output.finalStatus).toBe("finished");
  });

  it("toolResultGuard delimits tool output before it reaches the LLM (loop applies the guard)", async () => {
    let seen: unknown;
    const mgr = new PluginManager();
    // transform_tool_result runs AFTER the built-in guard → it observes the guarded content.
    await mgr.initialize([pluginOn("transform_tool_result", (r) => (seen = r))]);
    await runAgentLoop(
      baseInputs(toolThenEndLlm(), {
        pluginManager: mgr,
        customTools: [
          {
            name: "probe",
            description: "x",
            inputSchema: { type: "object" },
            handler: () => "SECRET plan",
          },
        ],
        toolResultGuard: { delimit: true },
      }),
    );
    const content = JSON.stringify(seen);
    // The loop applied inputs.toolResultGuard before the transform hook saw the results.
    expect(content).toContain("untrusted-tool-output");
    expect(content).toContain("SECRET plan");
  });

  /**
   * The CADENCE, which nothing asserted until now: `on_session_start` fires once per RUN, not once
   * per agent lifetime.
   *
   * The distinction is invisible while an application creates one agent and sends many messages —
   * and decisive for one that builds an agent per turn, where "once per run" means "on every
   * message". A consumer measured exactly that confusion in 2026-09: `on_session_start` reads as a
   * session-lifetime event, its context type is even called `SessionLifecycleContext`, and the only
   * statement of when it actually fires lived in an internal comment at the firing site, where no
   * consumer can see it. Hours went into it and a defect was filed against the wrong package.
   *
   * The sibling case above cannot catch this: it collects into a `Set`, so multiplicity is discarded
   * by construction — a hook firing twice, or never after the first run, reads identically there.
   * This one counts, across two runs, which is the smallest shape that can tell the three apart.
   *
   * Counting happens OUTSIDE the hook for the reason the `post_tool_call` note above records: a
   * failing `expect` inside a fire-and-forget handler is swallowed by the dispatcher.
   */
  it("test_on_session_start_fires_once_per_run_and_again_on_the_next_run", async () => {
    const starts: string[] = [];
    const mgr = new PluginManager();
    await mgr.initialize([pluginOn("on_session_start", () => starts.push("start"))]);

    await runAgentLoop(baseInputs(toolThenEndLlm(), { pluginManager: mgr }));
    expect(starts, "one run must fire it exactly once").toHaveLength(1);

    await runAgentLoop(baseInputs(toolThenEndLlm(), { pluginManager: mgr }));
    expect(starts, "a second run fires it again — this is per-run, not per-agent").toHaveLength(2);
  });
});
