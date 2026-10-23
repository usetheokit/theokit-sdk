/**
 * T3.2 — register a `Run` from `LocalAgent.send({ task: ... })` as a
 * Task in the observable registry. Extracted from `local-agent.ts`
 * to keep that file under the 400-LoC quality gate (G8).
 *
 * @internal
 */

import type { Run } from "../../types/run.js";
import { readRunResolving } from "../runtime/lifecycle/throw-on-error-run.js";
import { submit as taskRegistrySubmit } from "../task/registry.js";

export function registerRunAsTask(
  run: Run,
  agentId: string,
  taskOpt: true | { id?: string; meta?: Record<string, unknown> },
  userText: string,
): void {
  const opts = taskOpt === true ? {} : taskOpt;
  const meta: Record<string, unknown> = {
    agentId,
    runId: run.id,
    promptPreview: userText.slice(0, 120),
    ...(opts.meta ?? {}),
  };
  void taskRegistrySubmit({
    kind: "run",
    work: async (ctx) => {
      ctx.signal.addEventListener(
        "abort",
        () => {
          void run.cancel().catch(() => {
            /* swallow — run may already be terminal */
          });
        },
        { once: true },
      );
      const result = await readRunResolving(run);
      ctx.emit({ status: result.status, runId: run.id });
      return { status: result.status, result: result.result };
    },
    ...(opts.id !== undefined ? { id: opts.id } : {}),
    meta,
  });
}
