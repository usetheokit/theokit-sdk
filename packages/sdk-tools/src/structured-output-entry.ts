/**
 * `@theokit/sdk-tools/structured-output` — the `structured_output` tool's own entry.
 *
 * Kept out of the package barrel on purpose: the root `dist/index.js` has a gzip budget
 * (`.bundle-budget.json`) that a root export of this module would exceed.
 */
export {
  type CreateStructuredOutputToolOptions,
  createStructuredOutputTool,
  type StructuredOutputIssue,
  type StructuredOutputResult,
} from "./structured-output.js";
