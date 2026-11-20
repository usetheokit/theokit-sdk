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

function eventData(event: string): string | undefined {
  const lines = event
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).replace(/^ /, ""));
  const data = lines.join("\n");
  return data.trim() === "" ? undefined : data;
}

/** Splits complete events (ended by a blank line) off `buffer`; returns their data and the rest. */
function drainEvents(buffer: string): { data: string[]; rest: string } {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  const data = parts.map(eventData).filter((d): d is string => d !== undefined);
  return { data, rest };
}

/** Yields the joined `data:` payload of each SSE event as it arrives (not after the body ends). @internal */
export async function* readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (let done = false; !done; ) {
      const chunk = await reader.read();
      done = chunk.done;
      buffer += decoder.decode(chunk.value, { stream: !done }).replace(/\r\n?/g, "\n");
      const drained = drainEvents(buffer);
      buffer = drained.rest;
      yield* drained.data;
    }
    const tail = eventData(buffer);
    if (tail !== undefined) yield tail;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
