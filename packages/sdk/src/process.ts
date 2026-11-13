/**
 * Published as `@theokit/sdk/process`.
 *
 * Bounded subprocess runner: timeout, abort signal, process-group kill and an output cap.
 */

export type { RunBoundedOptions, RunBoundedResult } from "./internal/runtime/lifecycle/run-bounded.js";
export { runBounded } from "./internal/runtime/lifecycle/run-bounded.js";
