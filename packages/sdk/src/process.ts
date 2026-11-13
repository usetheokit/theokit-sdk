/**
 * Published as `@theokit/sdk/process`.
 *
 * Public bounded subprocess runner: a deadline, a per-stream output cap and whole-process-tree
 * cleanup on timeout or abort. Backs the SDK's `shell` tool and `sh -c` hooks.
 */
export type {
  RunBoundedOptions,
  RunBoundedResult,
} from "./internal/runtime/lifecycle/run-bounded.js";
export { runBounded } from "./internal/runtime/lifecycle/run-bounded.js";
