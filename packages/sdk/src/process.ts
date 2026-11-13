/**
 * Published as `@theokit/sdk/process`.
 *
 * A bounded subprocess runner: timeout and abort kill the whole process group (POSIX), and each
 * output stream is capped.
 */
export type {
  RunBoundedOptions,
  RunBoundedResult,
} from "./internal/runtime/lifecycle/run-bounded.js";
export { runBounded } from "./internal/runtime/lifecycle/run-bounded.js";
