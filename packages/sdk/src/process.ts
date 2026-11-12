/**
 * Published as `@theokit/sdk/process`.
 *
 * A bounded subprocess runner: timeout and abort kill the whole process group (POSIX), and each
 * output stream is capped.
 */
export type { EnvPolicy } from "./types/env-policy.js";
export {
  type RunBoundedOptions,
  type RunBoundedResult,
  runBounded,
} from "./internal/runtime/lifecycle/run-bounded.js";
