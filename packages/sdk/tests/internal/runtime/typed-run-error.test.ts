/**
 * B-498: every failed run's error detail carries a `TheokitAgentError` at `cause`.
 *
 * `toTypedRunErrorDetail` is the one place a `RunResult.error` is normalised: a typed cause is
 * kept by identity, and a missing or foreign one is wrapped in `UnknownAgentError` that keeps the
 * original as its own `cause`.
 */
import { describe, expect, it } from "vitest";

import { AuthenticationError, TheokitAgentError, UnknownAgentError } from "../../../src/errors.js";
import { toTypedRunErrorDetail } from "../../../src/internal/runtime/typed-run-error.js";
import { causeOf, detailWithForeignCause } from "../../runtime/run-error-detail-cause.types.js";

describe("toTypedRunErrorDetail", () => {
  it("keeps_a_typed_cause_by_identity", () => {
    const cause = new AuthenticationError("bad key", { code: "openrouter_auth_failed" });
    const detail = {
      message: "openrouter API error: auth_failed (HTTP 401)",
      code: "auth_failed",
      cause,
    };

    const typed = toTypedRunErrorDetail(detail);

    expect(typed).toBe(detail);
    expect(typed === undefined ? undefined : causeOf(typed)).toBe(cause);
  });

  it("wraps_a_missing_cause_in_an_UnknownAgentError", () => {
    const typed = toTypedRunErrorDetail({
      message: "budget exceeded: 3 iterations",
      code: "iteration_limit",
    });

    expect(typed?.message).toBe("budget exceeded: 3 iterations");
    expect(typed?.code).toBe("iteration_limit");
    expect(typed?.cause).toBeInstanceOf(UnknownAgentError);
    expect(typed?.cause?.message).toBe("budget exceeded: 3 iterations");
    expect(typed?.cause?.code).toBe("iteration_limit");
    expect(typed?.cause !== undefined && "cause" in typed.cause).toBe(false);
  });

  it("wraps_a_foreign_cause_and_keeps_it", () => {
    const plain = new Error("loop exploded");
    const fromError = toTypedRunErrorDetail({
      message: "Agent loop failed",
      code: "agent_loop_failed",
      cause: plain,
    });
    const fromString = toTypedRunErrorDetail({ message: "hook failed", cause: "denied" });

    expect(fromError?.cause).toBeInstanceOf(TheokitAgentError);
    expect(fromError?.cause?.cause).toBe(plain);
    expect(fromString?.cause).toBeInstanceOf(UnknownAgentError);
    expect(fromString?.cause?.cause).toBe("denied");
    expect(fromString?.cause?.code).toBeUndefined();
  });

  it("returns_undefined_for_a_run_without_an_error_detail", () => {
    expect(toTypedRunErrorDetail(undefined)).toBeUndefined();
  });

  it("wraps_a_cause_the_public_type_refuses", () => {
    const forced = detailWithForeignCause();

    const typed = toTypedRunErrorDetail(forced);

    expect(typed?.cause).toBeInstanceOf(UnknownAgentError);
    expect(typed?.cause?.cause).toBe(forced.cause);
  });
});
