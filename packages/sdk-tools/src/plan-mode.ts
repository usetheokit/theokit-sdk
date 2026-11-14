/**
 * `plan_mode` — tool for toggling between normal and planning mode.
 *
 * In plan mode, the agent focuses on outlining steps rather than executing them.
 *
 * Return shape (always a JSON string):
 *   - `{ ok: true, mode: string, message: string }`
 *   - `{ ok: false, error: "invalid_action" }`
 *
 * Opt-in persistence (M4-4): `createPlanModeTool({ artifactStore })` returns a
 * variant whose async handler persists the submitted `plan` on `exit`.
 */

import type { CustomTool } from "@theokit/sdk";
import type { SessionArtifactStore } from "./artifact-store.js";

type Mode = "normal" | "plan";

const PLAN_INSTRUCTIONS = [
  "You are now in PLAN MODE.",
  "Outline the steps you will take before executing any code changes.",
  "Number each step. Include file paths and what will change.",
  "Do NOT make any edits or tool calls other than reading files.",
  "When ready, use plan_mode with action 'exit' to return to normal mode.",
].join("\n");

const NORMAL_INSTRUCTIONS = "Returned to NORMAL MODE. You may now execute changes.";

/**
 * The `plan_mode` tool object returned by the no-argument {@link createPlanModeTool}. Its `handler`
 * is synchronous, where {@link PlanModeToolWithStore}'s returns a promise — so the two are not
 * interchangeable at a call site that does not await.
 *
 * `currentMode` is a test seam; the mode also comes back in every result.
 */
export interface PlanModeTool extends CustomTool {
  handler: (input: Record<string, unknown>) => string;
  /** Expose current mode for testing. */
  currentMode: () => Mode;
}

/**
 * Plan-mode tool with opt-in artifact persistence (M4-4). Same surface as
 * {@link PlanModeTool} but the handler is ASYNC (it may write to the store) and
 * accepts an optional `plan` to persist on `exit`.
 *
 * @public
 */
export interface PlanModeToolWithStore extends CustomTool {
  handler: (input: Record<string, unknown>) => Promise<string>;
  currentMode: () => Mode;
}

/**
 * Options for the persistence-enabled {@link createPlanModeTool} overload.
 *
 * @public
 */
export interface PlanModeToolOptions {
  /** M76 — name exposed to the model. Omitted => today's literal (additive). The name is a contract:
   *  the approval key, what the model sees and what telemetry records. */
  name?: string;
  /** M76 — description exposed to the model. Omitted => today's literal (additive). */
  description?: string;
  /** Store the submitted `plan` is persisted to on `exit`. */
  artifactStore: SessionArtifactStore;
  /** Artifact id under which the plan is stored. Default `"plan"`. */
  artifactId?: string;
}

const DESCRIPTION =
  "Toggle between normal and plan mode. " +
  "Actions: 'enter' (switch to plan mode), 'exit' (return to normal), 'status' (check current mode). " +
  "Returns { ok, mode, message }.";

function planModeSchema(withPlan: boolean): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    action: {
      type: "string",
      enum: ["enter", "exit", "status"],
      description: "The action to perform.",
    },
  };
  if (withPlan) {
    properties.plan = {
      type: "string",
      description: "On 'exit', the plan text to persist to the artifact store.",
    };
  }
  return { type: "object" as const, properties, required: ["action"] };
}

function renderMode(action: string, mode: Mode): string | undefined {
  switch (action) {
    case "enter":
      return JSON.stringify({ ok: true, mode, message: PLAN_INSTRUCTIONS });
    case "exit":
      return JSON.stringify({ ok: true, mode, message: NORMAL_INSTRUCTIONS });
    case "status":
      return JSON.stringify({ ok: true, mode, message: `Current mode: ${mode}` });
    default:
      return undefined;
  }
}

function invalidAction(action: string): string {
  return JSON.stringify({
    ok: false,
    error: "invalid_action",
    message: `Unknown action '${action}'. Valid: enter, exit, status.`,
  });
}

/**
 * Build the `plan_mode` tool, which flips a flag and returns instruction text telling the model to
 * outline before it edits. It enforces nothing — no other tool consults the mode, so a model that
 * ignores the instructions is not stopped, and the mode lives in this object rather than in the
 * session.
 *
 * With no argument it returns a {@link PlanModeTool} whose handler is synchronous. With options it
 * returns a {@link PlanModeToolWithStore} whose handler is async and accepts a `plan` string,
 * persisted to `artifactStore` under `artifactId` (default `"plan"`) when the model exits plan mode.
 * An empty or absent `plan` is not written, and `persisted` in the result says which happened.
 *
 * `name` and `description` are read on the options overload only. The no-argument form always
 * publishes `plan_mode` with the built-in description, since it takes nothing to override it with.
 */
export function createPlanModeTool(): PlanModeTool;
export function createPlanModeTool(options: PlanModeToolOptions): PlanModeToolWithStore;
export function createPlanModeTool(
  options?: PlanModeToolOptions,
): PlanModeTool | PlanModeToolWithStore {
  let mode: Mode = "normal";

  if (options === undefined) {
    return {
      name: "plan_mode",
      description: DESCRIPTION,
      inputSchema: planModeSchema(false),
      handler: (input: Record<string, unknown>): string => {
        const action = String(input.action);
        if (action === "enter") mode = "plan";
        else if (action === "exit") mode = "normal";
        return renderMode(action, mode) ?? invalidAction(action);
      },
      currentMode: () => mode,
    };
  }

  const { artifactStore, artifactId = "plan" } = options;
  return {
    name: options.name ?? "plan_mode",
    description: options.description ?? DESCRIPTION,
    inputSchema: planModeSchema(true),
    handler: async (input: Record<string, unknown>): Promise<string> => {
      const action = String(input.action);
      if (action === "enter") {
        mode = "plan";
        return JSON.stringify({ ok: true, mode, message: PLAN_INSTRUCTIONS });
      }
      if (action === "exit") {
        mode = "normal";
        // Persist only a non-empty plan (EC-1); enter/status never persist (EC-2).
        if (typeof input.plan === "string" && input.plan.length > 0) {
          const path = await artifactStore.write(artifactId, input.plan);
          return JSON.stringify({
            ok: true,
            mode,
            message: NORMAL_INSTRUCTIONS,
            persisted: true,
            path,
          });
        }
        return JSON.stringify({ ok: true, mode, message: NORMAL_INSTRUCTIONS, persisted: false });
      }
      return renderMode(action, mode) ?? invalidAction(action);
    },
    currentMode: () => mode,
  };
}
