/**
 * B-498 type test, compiled by `pnpm --filter @theokit/sdk typecheck` (the tsconfig includes
 * `tests/**`). A failed run's `result.error.cause` is a `TheokitAgentError`, so a caller can
 * branch with `instanceof` without narrowing an `unknown` first.
 *
 * `tests/internal/runtime/typed-run-error.test.ts` calls both helpers, so the file is reachable.
 */
import type { TheokitAgentError } from "../../src/errors.js";
import type { RunErrorDetail } from "../../src/types/run.js";

export function causeOf(detail: RunErrorDetail): TheokitAgentError | undefined {
  return detail.cause;
}

export function detailWithForeignCause(): RunErrorDetail {
  return {
    message: "a plain Error is not a TheokitAgentError",
    // @ts-expect-error RunErrorDetail.cause accepts only a TheokitAgentError
    cause: new Error("plain"),
  };
}
