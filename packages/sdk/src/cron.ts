// Bootstrap import: loading this facade must register the public Agent facade
// into the agent-factory-registry seam, because `internal/cron/run-job.ts`
// resolves it via `getAgentFacade()` at runtime instead of importing `agent.ts`
// directly (which would invert the public-api -> internal dependency
// direction). The `@theokit/sdk/cron` sub-path entry would otherwise throw
// "Agent facade not registered" at runtime.
import "./agent.js";
import { ConfigurationError, UnknownAgentError } from "./errors.js";
import { fireCronJobAsTask } from "./internal/cron/fire-handler.js";
import { runCronJob } from "./internal/cron/run-job.js";
import {
  getSchedulerState,
  scheduleJob,
  setCronFireHandler,
  startScheduler,
  stopScheduler,
  unscheduleJob,
} from "./internal/cron/scheduler.js";
import { deleteJob, getJob, jobCount, listJobs, upsertJob } from "./internal/cron/store.js";
import { nextRunAt, validateCronExpression, validateTimezone } from "./internal/cron/validate.js";
import { resolveApiKey } from "./internal/env.js";
import { generateCronId } from "./internal/ids.js";
import type { AgentOptions, ListResult } from "./types/agent.js";
import type {
  CronCreateOptions,
  CronGetOptions,
  CronJob,
  CronListOptions,
  CronOperationOptions,
  CronRunOptions,
  CronRuntime,
  CronSchedulerStatus,
  CronStartOptions,
} from "./types/cron.js";
import type { Run } from "./types/run.js";

/**
 * Synchronously validate a cron expression with the same rules `Cron.create` applies.
 *
 * @example
 * ```ts
 * import { validateCron } from "@theokit/sdk/cron";
 *
 * validateCron("*\/15 * * * *"); // ok
 * validateCron("61 * * * *"); // throws ConfigurationError (code "invalid_cron")
 * ```
 *
 * @throws ConfigurationError with code `invalid_cron` when `expression` is not one `Cron.create` accepts.
 * @public
 */
export function validateCron(expression: string): void {
  validateCronExpression(expression);
}

/**
 * Synchronously validate an IANA timezone name with the same rules `Cron.create` applies.
 *
 * @example
 * ```ts
 * import { validateCronTimezone } from "@theokit/sdk/cron";
 *
 * validateCronTimezone("America/Sao_Paulo"); // ok
 * validateCronTimezone("Mars/Base"); // throws ConfigurationError (code "invalid_timezone")
 * ```
 *
 * @throws ConfigurationError with code `invalid_timezone` when `timezone` is not a valid IANA zone.
 * @public
 */
export function validateCronTimezone(timezone: string): void {
  validateTimezone(timezone);
}

/**
 * Static façade for scheduling Theo agent runs on a cron expression.
 *
 * @public
 */
export class Cron {
  private constructor() {
    // Static-only façade.
  }

  /**
   * Create and persist a cron job.
   *
   * @public
   */
  static async create(options: CronCreateOptions): Promise<CronJob> {
    const job = await createCronJob(options);
    if (job.runtime === "local" && job.enabled !== false) scheduleJob(job);
    return job;
  }

  /**
   * List cron jobs (local, cloud, or both).
   *
   * @public
   */
  static list(options: CronListOptions = {}): Promise<ListResult<CronJob>> {
    const runtimeFilter = options.runtime;
    const items = listJobs().filter((job) =>
      runtimeFilter === undefined ? true : job.runtime === runtimeFilter,
    );
    return Promise.resolve({ items });
  }

  /**
   * Get a single cron job by ID.
   *
   * @public
   */
  static get(jobId: string, _options: CronGetOptions = {}): Promise<CronJob> {
    const job = getJob(jobId);
    if (job === undefined) {
      return Promise.reject(
        new UnknownAgentError(`Cron job ${jobId} not found`, { code: "unknown_cron_job" }),
      );
    }
    return Promise.resolve(job);
  }

  /**
   * Delete a cron job permanently.
   *
   * @public
   */
  static delete(jobId: string, _options: CronOperationOptions = {}): Promise<void> {
    unscheduleJob(jobId);
    deleteJob(jobId);
    return Promise.resolve();
  }

  /**
   * Re-enable a paused cron job.
   *
   * @public
   */
  static async enable(jobId: string, _options: CronOperationOptions = {}): Promise<CronJob> {
    return updateJobStatus(jobId, true);
  }

  /**
   * Pause a cron job without deleting it.
   *
   * @public
   */
  static async disable(jobId: string, _options: CronOperationOptions = {}): Promise<CronJob> {
    return updateJobStatus(jobId, false);
  }

  /**
   * Manually trigger a cron job off-schedule. Returns the resulting `Run`
   * (agent target) or `WorkflowRun` (workflow target — SE35).
   *
   * @public
   */
  static async run(
    jobId: string,
    _options: CronRunOptions = {},
  ): Promise<Run | import("./types/workflow.js").WorkflowRun> {
    const job = getJob(jobId);
    if (job === undefined) {
      throw new UnknownAgentError(`Cron job ${jobId} not found`, { code: "unknown_cron_job" });
    }
    return runCronJob(job);
  }

  /**
   * Activate the in-process scheduler for local cron jobs.
   *
   * @public
   */
  static start(options: CronStartOptions = {}): Promise<void> {
    // Install the default fire handler so timer ticks actually drive a real
    // agent/workflow run. Users can override via `setCronFireHandler` from
    // `@theokit/sdk/internal` (test-mode hook). Handler body lives in
    // `internal/cron/fire-handler.ts` (testable + G8).
    setCronFireHandler(fireCronJobAsTask);
    startScheduler(options.cwd);
    return Promise.resolve();
  }

  /**
   * Stop the in-process scheduler. Jobs are preserved.
   *
   * @public
   */
  static stop(): Promise<void> {
    stopScheduler();
    return Promise.resolve();
  }

  /**
   * Snapshot of the local scheduler.
   *
   * @public
   */
  static status(_options: CronStartOptions = {}): Promise<CronSchedulerStatus> {
    const scheduler = getSchedulerState();
    return Promise.resolve({ running: scheduler.running, jobCount: jobCount() });
  }
}

async function createCronJob(options: CronCreateOptions): Promise<CronJob> {
  validateCronTarget(options);

  validateCronExpression(options.cron);
  const timezone = options.timezone ?? "UTC";
  validateTimezone(timezone);

  // apiKey is accepted but not required for cron-create in fixture mode.
  resolveApiKey(options.apiKey);

  const runtime = detectRuntime(options);
  const now = Date.now();
  // Computed, not estimated. The predecessor returned now+1h for every expression, so a @yearly job
  // reported that it would run within the hour until the scheduler corrected it — and forever if the
  // scheduler never picked it up. Spread conditionally below: `nextRunAt` is optional, and "no next
  // run" is a real answer for a one-shot date in the past.
  const nextFireAt = nextRunAt(options.cron, timezone);
  const job: CronJob = {
    id: generateCronId(),
    cron: options.cron,
    timezone,
    enabled: options.enabled ?? true,
    status: options.enabled === false ? "paused" : "scheduled",
    runtime,
    createdAt: now,
    ...(nextFireAt === undefined ? {} : { nextRunAt: nextFireAt }),
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.message !== undefined ? { message: options.message } : {}),
    ...(options.agent !== undefined ? { agent: options.agent } : {}),
    ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
    ...(options.workflow !== undefined ? { workflow: options.workflow } : {}),
    ...(options.inputData !== undefined ? { inputData: options.inputData } : {}),
  };
  upsertJob(job);
  return job;
}

/**
 * SE35 (ADR 0014) — exactly ONE target (`agent` | `agentId` | `workflow`).
 * Agent targets require `message`; a workflow target takes `inputData` and MUST
 * NOT set `message`.
 */
function validateCronTarget(options: CronCreateOptions): void {
  const targets = [options.agent, options.agentId, options.workflow].filter(
    (t) => t !== undefined,
  ).length;
  if (targets > 1) {
    throw new ConfigurationError(
      "agent, agentId, and workflow are mutually exclusive — pass exactly one target.",
      { code: "cron_ambiguous_target" },
    );
  }
  if (targets === 0) {
    throw new ConfigurationError(
      "Cron job requires exactly one target: agent, agentId, or workflow.",
      { code: "cron_no_target" },
    );
  }
  if (options.workflow !== undefined && options.message !== undefined) {
    throw new ConfigurationError(
      "A workflow cron target takes inputData, not a message — remove `message`.",
      { code: "cron_workflow_message" },
    );
  }
  if (options.workflow === undefined && options.message === undefined) {
    throw new ConfigurationError("An agent cron target requires a message.", {
      code: "cron_missing_message",
    });
  }
}

function detectRuntime(options: CronCreateOptions): CronRuntime {
  // SE35 — a workflow target is a held in-memory instance; it can only run in
  // the local (in-process) scheduler. A workflow instance cannot cross the
  // cloud process boundary (ADR 0014).
  if (options.workflow !== undefined) return "local";
  if (options.agentId !== undefined) {
    return options.agentId.startsWith("bc-") ? "cloud" : "local";
  }
  const agent = options.agent as AgentOptions | undefined;
  if (agent?.cloud !== undefined) return "cloud";
  return "local";
}

async function updateJobStatus(jobId: string, enabled: boolean): Promise<CronJob> {
  const existing = getJob(jobId);
  if (existing === undefined) {
    throw new UnknownAgentError(`Cron job ${jobId} not found`, { code: "unknown_cron_job" });
  }
  const updated: CronJob = {
    ...existing,
    enabled,
    status: enabled ? "scheduled" : "paused",
  };
  upsertJob(updated);
  if (updated.runtime === "local") {
    if (enabled) {
      scheduleJob(updated);
    } else {
      unscheduleJob(updated.id);
    }
  }
  return updated;
}
