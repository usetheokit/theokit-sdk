import { NetworkError } from "../../errors.js";

const RECONNECT_BASE_MS = 250;

/** M2 #59 — full-jitter backoff (AWS Brooker 2015) for the Nth reconnect attempt,
 * then a plain delay. MCP requests carry no AbortSignal so the delay is unabortable. */
export function reconnectDelay(attempt: number): Promise<void> {
  const ceiling = RECONNECT_BASE_MS * 2 ** attempt;
  const ms = Math.floor(Math.random() * ceiling);
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

/** Typed timeout error shared by both transports (#59). */
export function mcpTimeoutError(name: string, timeoutMs: number): NetworkError {
  return new NetworkError(`MCP ${name} request timed out after ${timeoutMs}ms`, {
    code: "mcp_timeout",
  });
}

/**
 * True when a rejected fetch was aborted by our `AbortSignal.timeout` (#59).
 * `AbortSignal.timeout` rejects with a `DOMException` (name `TimeoutError`),
 * which is not always `instanceof Error`, so we inspect `.name` directly.
 */
export function isAbortLike(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null || !("name" in cause)) return false;
  const name = (cause as { name: unknown }).name;
  return name === "TimeoutError" || name === "AbortError";
}

/** The `capabilities` object of an `initialize` response; `{}` when the server sent none. @internal */
export function capabilitiesOf(response: unknown): Record<string, unknown> {
  const caps = (response as { result?: { capabilities?: unknown } } | undefined)?.result
    ?.capabilities;
  return typeof caps === "object" && caps !== null ? (caps as Record<string, unknown>) : {};
}
