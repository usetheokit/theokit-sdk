/**
 * B-498, D3: under `AgentOptions.throwOnError`, each helper that sends on the caller's agent and
 * then waits lets the typed error through its own failure surface. One test per helper, so a
 * helper that starts swallowing the rejection fails here.
 *
 * The transport is a stubbed `fetch` answering 401, so no request leaves the process.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { Agent } from "../../src/agent.js";
import { AuthenticationError } from "../../src/errors.js";
import { Eval } from "../../src/eval.js";
import { fireCronJobAsTask } from "../../src/internal/cron/fire-handler.js";
import type { JudgeResult } from "../../src/internal/judge/types.js";
import { runUntilImpl } from "../../src/internal/runtime/lifecycle/run-until.js";
import { readRunResolving } from "../../src/internal/runtime/lifecycle/throw-on-error-run.js";
import {
  clearAgentRegistry,
  invalidateRegistryHydration,
} from "../../src/internal/runtime/registry/agent-registry.js";
import { clearAllSessions } from "../../src/internal/session/agent-session.js";
import {
  __resetTaskRegistryForTests,
  list as listTasks,
} from "../../src/internal/task/registry.js";
import type { AgentOptions } from "../../src/types/agent.js";
import type { CronJob } from "../../src/types/cron.js";
import type { Run } from "../../src/types/run.js";
import { agentStep, Workflow } from "../../src/workflow.js";

const BAD_KEY = `sk-or-v1-${"0".repeat(64)}`;
const PROVIDER_CODE = "openrouter_auth_failed";

function stubFetch401(): ReturnType<typeof vi.fn> {
  return vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
    return new Response(JSON.stringify({ error: { message: "User not found.", code: 401 } }), {
      status: 401,
      statusText: "Unauthorized",
      headers: { "content-type": "application/json" },
    });
  });
}

describe("helpers on a throwOnError agent whose provider answers 401", () => {
  let root: string;
  let options: AgentOptions;

  beforeEach(async () => {
    clearAgentRegistry();
    clearAllSessions();
    invalidateRegistryHydration();
    await Agent.registry.evictAll();
    root = await mkdtemp(join(tmpdir(), "theokit-throw-on-error-helpers-"));
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubGlobal("fetch", stubFetch401());
    options = {
      apiKey: BAD_KEY,
      throwOnError: true,
      model: { id: "deepseek/deepseek-r1-0528" },
      local: { cwd: root },
      providers: { routes: [{ capability: "chat", provider: "openrouter" }] },
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    clearAgentRegistry();
    clearAllSessions();
    invalidateRegistryHydration();
    await Agent.registry.evictAll();
    await rm(root, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("generate_rejects_with_the_AuthenticationError", async () => {
    const agent = await Agent.create(options);
    try {
      const rejected = await agent.generate("hi", { output: z.object({ a: z.string() }) }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(rejected).toBeInstanceOf(AuthenticationError);
      expect((rejected as AuthenticationError).code).toBe(PROVIDER_CODE);
    } finally {
      await agent.dispose();
    }
  });

  it("batch_reports_the_AuthenticationError_as_the_failed_item", async () => {
    const captured: Run[] = [];
    const create = Agent.create.bind(Agent);
    vi.spyOn(Agent, "create").mockImplementation(async (opts) => {
      const agent = await create(opts);
      const send = agent.send.bind(agent);
      agent.send = async (...args: Parameters<typeof send>) => {
        const run = await send(...args);
        captured.push(run);
        return run;
      };
      return agent;
    });

    const results = await Agent.batch(["hi"], options);

    expect(results).toHaveLength(1);
    const [item] = results;
    expect(item?.ok).toBe(false);
    expect(captured).toHaveLength(1);
    const run = captured[0] as Run;
    const cause = (await readRunResolving(run)).error?.cause;
    expect(cause).toBeInstanceOf(AuthenticationError);
    expect(item !== undefined && !item.ok ? item.error : undefined).toBe(cause);
  });

  it("fork_rejects_with_the_AuthenticationError", async () => {
    const agent = await Agent.create(options);
    try {
      const rejected = await agent.fork?.({ allowedTools: new Set<string>(), prompt: "hi" }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(rejected).toBeInstanceOf(AuthenticationError);
      expect((rejected as AuthenticationError).code).toBe(PROVIDER_CODE);
    } finally {
      await agent.dispose();
    }
  });

  it("runToCompletion_rejects_with_the_AuthenticationError", async () => {
    const agent = await Agent.create(options);
    try {
      const rejected = await agent.runToCompletion?.("hi").then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(rejected).toBeInstanceOf(AuthenticationError);
      expect((rejected as AuthenticationError).code).toBe(PROVIDER_CODE);
    } finally {
      await agent.dispose();
    }
  });

  it("runUntil_throws_the_AuthenticationError_from_its_iterator", async () => {
    const agent = await Agent.create(options);
    const judge = vi.fn(
      async (): Promise<JudgeResult> => ({
        verdict: "done",
        reason: "n/a",
        parseFailed: false,
      }),
    );
    const controller = new AbortController();
    const sent: Run[] = [];
    const send = agent.send.bind(agent);
    agent.send = async (...args: Parameters<typeof send>) => {
      const run = await send(...args);
      sent.push(run);
      return run;
    };
    try {
      // runUntilImpl is what agent.runUntil returns (local-agent-runtime-extensions.ts), called
      // here with a stub judge so the test can count judge calls; the facade adds no catch.
      const iterator = runUntilImpl(
        agent,
        "reach the goal",
        { signal: controller.signal },
        { judge },
      );
      let thrown: unknown;
      try {
        for (let step = await iterator.next(); step.done !== true; step = await iterator.next()) {
          // drain the goal events until the iterator throws
        }
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(AuthenticationError);
      expect(judge).toHaveBeenCalledTimes(0);
      expect(sent).toHaveLength(1);
      const cancel = vi.spyOn(sent[0] as Run, "cancel");
      controller.abort();
      expect(cancel).toHaveBeenCalledTimes(0);
    } finally {
      await agent.dispose();
    }
  });

  it("streamToCompletion_throws_the_AuthenticationError_from_its_iterator", async () => {
    const agent = await Agent.create(options);
    try {
      const iterator = agent.streamToCompletion?.("hi");
      let thrown: unknown;
      try {
        for await (const _message of iterator ?? []) {
          // drain the streamed messages until the iterator throws
        }
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(AuthenticationError);
      expect((thrown as AuthenticationError).code).toBe(PROVIDER_CODE);
    } finally {
      await agent.dispose();
    }
  });

  it("agentStep_fails_with_the_AuthenticationError_name", async () => {
    const agent = await Agent.create(options);
    try {
      const workflow = Workflow.create({ name: "throw-on-error-step" })
        .then(agentStep("ask", agent, "hi"))
        .commit();

      const run = await workflow.run(undefined);

      expect(run.status).toBe("failed");
      const step = run.stepResults.find((result) => result.stepId === "ask");
      expect(step?.status).toBe("failed");
      expect(step?.error?.name).toBe("AuthenticationError");
    } finally {
      await agent.dispose();
    }
  });

  it("cron_fire_task_errors_with_the_provider_code", async () => {
    __resetTaskRegistryForTests();
    const job = {
      id: "throw-on-error-job",
      name: "throw on error",
      cron: "*/5 * * * *",
      timezone: "UTC",
      runtime: "local",
      enabled: true,
      status: "scheduled",
      createdAt: Date.now(),
      agent: options,
      message: "hi",
    } as unknown as CronJob;

    await fireCronJobAsTask(job);
    const task = await waitForTerminalCronTask(job.id);

    expect(task.state).toBe("error");
    expect(task.error?.code).toBe(PROVIDER_CODE);
  });

  it("eval_row_keeps_the_run_message_as_its_error", async () => {
    const agent = await Agent.create(options);
    try {
      const run = await Eval.create({
        name: "throw-on-error-eval",
        dataset: [{ input: "hi" }],
        scorers: [{ name: "any", score: () => ({ score: 1 }) }],
        agent,
      }).run();

      expect(run.rows).toHaveLength(1);
      expect(run.rows[0]?.error).toContain("auth_failed");
    } finally {
      await agent.dispose();
    }
  });
});

const TERMINAL = new Set(["finished", "error", "cancelled"]);

/** Yield to the event loop until the cron task for `jobId` is terminal; bounded, never a sleep. */
async function waitForTerminalCronTask(
  jobId: string,
): Promise<{ state: string; error?: { code?: string } }> {
  for (let attempt = 0; attempt < 5_000; attempt += 1) {
    const tasks = await listTasks({ kind: "cron" });
    const mine = tasks.find((t) => t.id.startsWith(`cron-${jobId}-`));
    if (mine !== undefined && TERMINAL.has(mine.state)) {
      return mine as unknown as { state: string; error?: { code?: string } };
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`cron task for ${jobId} never reached a terminal state`);
}
