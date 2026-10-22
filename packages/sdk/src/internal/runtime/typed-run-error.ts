import { TheokitAgentError, UnknownAgentError } from "../../errors.js";
import type { RunErrorDetail } from "../../types/run.js";

/** A run's error detail as its writers record it, before the cause is normalised. */
interface RecordedRunErrorDetail {
  message: string;
  code?: string;
  cause?: unknown;
}

/**
 * Gives a failed run's error detail a `TheokitAgentError` cause (B-498).
 *
 * A typed cause is kept by identity, so the detail is returned unchanged. Any other cause, or none,
 * is wrapped in an `UnknownAgentError` carrying the detail's message and code, with the original
 * value kept as that error's own `cause`. `message` and `code` are never rewritten.
 */
export function toTypedRunErrorDetail(
  detail: RecordedRunErrorDetail | undefined,
): RunErrorDetail | undefined {
  if (detail === undefined) return undefined;
  if (hasTypedCause(detail)) return detail;
  const { cause } = detail;
  const wrapped = new UnknownAgentError(detail.message, {
    ...(detail.code !== undefined ? { code: detail.code } : {}),
    ...(cause !== undefined ? { cause } : {}),
  });
  return { ...detail, cause: wrapped };
}

function hasTypedCause(detail: RecordedRunErrorDetail): detail is RunErrorDetail {
  return detail.cause instanceof TheokitAgentError;
}
