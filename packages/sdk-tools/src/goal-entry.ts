/**
 * `@theokit/sdk-tools/goal` — the `goal` tool's own entry.
 *
 * Kept out of the package barrel on purpose: the root `dist/index.js` has a gzip budget
 * (`.bundle-budget.json`) this module would exceed (32716 / 32000 bytes gzipped when exported
 * from the barrel, measured 2026-11-02).
 */
export {
  type CreateGoalToolOptions,
  createGoalTool,
  type GoalState,
  type GoalTool,
} from "./goal.js";
