/**
 * Minimal Server-Sent-Events parser. Consumes a fetch `Response` body
 * stream and yields `{ event, data }` records as they arrive. Used by
 * both the Anthropic and OpenAI streaming clients — neither vendor sends
 * binary SSE so a simple text decoder is enough.
 *
 * @internal
 */

import { NetworkError } from "../../errors.js";

export interface SseRecord {
  event: string;
  data: string;
}

/**
 * M2 #61 — default idle timeout (ms) between SSE reads. "Idle" means *no bytes
 * at all* arrive within the window — distinct from a slow-but-alive stream that
 * keeps trickling chunks. A stalled upstream that handshakes then goes silent no
 * longer hangs the AsyncGenerator forever; it rejects a typed NetworkError so
 * FallbackLlmClient / retry can route it. Pass `0` to disable.
 */
export const DEFAULT_SSE_IDLE_MS = 60_000;

/**
 * Default bound (ms) on the wait for a response's HEADERS. Without it that wait falls to undici's
 * `headersTimeout` (300 s) and a request whose response never starts holds the turn with no retry.
 * Pass `0` (or less) to disable.
 */
export const DEFAULT_RESPONSE_HEADERS_MS = 30_000;

/**
 * Wraps `inner` so the wait for the response headers is bounded: when they do not arrive within
 * `timeoutMs`, the request is aborted and a retryable `NetworkError`
 * (`code: "response_headers_timeout"`) is thrown. The caller's own signal still wins (its abort is
 * propagated untouched). The timer stops once headers arrive, so body streaming is not affected
 * (that is `parseSseStream`'s idle bound). `timeoutMs <= 0` returns `inner` unchanged.
 *
 * @internal
 */
export function withResponseHeadersTimeout(
  inner: typeof fetch,
  timeoutMs: number = DEFAULT_RESPONSE_HEADERS_MS,
): typeof fetch {
  if (!(timeoutMs > 0)) return inner;
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    const callerSignal = init?.signal ?? undefined;
    const onCallerAbort = (): void => controller.abort(callerSignal?.reason);
    if (callerSignal?.aborted) onCallerAbort();
    else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new NetworkError(`no response headers within ${timeoutMs}ms — upstream stalled`, {
            code: "response_headers_timeout",
          }),
        );
        controller.abort();
      }, timeoutMs);
    });
    try {
      const pending = inner(input, { ...init, signal: controller.signal });
      // If the timeout wins, the aborted fetch rejects later; keep that from being unhandled.
      pending.catch(() => undefined);
      return await Promise.race([pending, timeout]);
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }) as typeof fetch;
}

interface ParserState {
  buffer: string;
  event: string;
  data: string;
}

export async function* parseSseStream(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
  idleTimeoutMs: number = DEFAULT_SSE_IDLE_MS,
): AsyncGenerator<SseRecord, void, void> {
  if (body === null) return;
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  const state: ParserState = { buffer: "", event: "message", data: "" };
  try {
    for await (const chunk of readChunks(reader, signal, idleTimeoutMs)) {
      state.buffer += decoder.decode(chunk, { stream: true });
      for (const record of drainCompleteRecords(state)) yield record;
    }
    if (state.data.length > 0) yield { event: state.event, data: state.data };
  } finally {
    // T3.2 + T3.3 — cancel the underlying body stream on EVERY exit path
    // (abort, normal close, consumer break, consumer throw). Without this
    // the upstream HTTP TCP socket stays in CLOSE_WAIT until the OS times
    // it out. cancel() on a finished stream is a no-op so always-cancel
    // is safe.
    await cancelReaderQuietly(reader);
    releaseReader(reader);
  }
}

/**
 * T3.2 — yield each chunk from `reader` until `done` OR `signal.aborted`.
 * Extracted from `parseSseStream` so its complexity stays under budget.
 *
 * @internal
 */
async function* readChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  idleTimeoutMs: number,
): AsyncGenerator<Uint8Array, void, void> {
  while (true) {
    if (signal.aborted) return;
    const { value, done } = await readWithIdleTimeout(reader, idleTimeoutMs);
    if (done) return;
    if (value !== undefined) yield value;
  }
}

/**
 * M2 #61 — race a single `reader.read()` against an idle timer. The timer is
 * cleared the moment the read settles (success OR error), so a healthy stream
 * never leaves a dangling timeout. When the timer wins, reject a typed
 * `NetworkError` (`code: "stream_idle_timeout"`); the caller's `finally` cancels
 * the body socket. `idleTimeoutMs <= 0` disables the bound (legacy behavior).
 *
 * @internal
 */
function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>> {
  if (idleTimeoutMs <= 0) return reader.read();
  return new Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new NetworkError(`SSE stream idle for ${idleTimeoutMs}ms — upstream stalled`, {
            code: "stream_idle_timeout",
          }),
        );
      }, idleTimeoutMs);
      reader.read().then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    },
  );
}

/**
 * T3.2 + T3.3 — cancel the underlying body stream on every exit path.
 * Swallows any cancel-time error per ADR D34's safe-exporter contract
 * (cancel-time errors never propagate to caller).
 *
 * Calling cancel on a stream that already completed naturally is a no-op
 * per the WHATWG streams spec, so unconditional cancel is safe.
 *
 * @internal
 */
async function cancelReaderQuietly(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // best-effort — already cancelled OR upstream closed
  }
}

function drainCompleteRecords(state: ParserState): SseRecord[] {
  const out: SseRecord[] = [];
  let newlineIndex = state.buffer.indexOf("\n");
  while (newlineIndex !== -1) {
    const line = state.buffer.slice(0, newlineIndex).replace(/\r$/, "");
    state.buffer = state.buffer.slice(newlineIndex + 1);
    const finished = applyLine(state, line);
    if (finished !== undefined) out.push(finished);
    newlineIndex = state.buffer.indexOf("\n");
  }
  return out;
}

function applyLine(state: ParserState, line: string): SseRecord | undefined {
  if (line === "") {
    if (state.data.length === 0) {
      state.event = "message";
      return undefined;
    }
    const record: SseRecord = { event: state.event, data: state.data };
    state.event = "message";
    state.data = "";
    return record;
  }
  if (line.startsWith(":")) return undefined;
  if (line.startsWith("event:")) {
    // T3.1 — HTML Living Standard § 9.2.6: strip exactly ONE leading
    // U+0020 SPACE from the value; preserve other whitespace verbatim.
    state.event = stripOneLeadingSpace(line.slice(6));
    return undefined;
  }
  if (line.startsWith("data:")) {
    const piece = stripOneLeadingSpace(line.slice(5));
    state.data = state.data.length === 0 ? piece : `${state.data}\n${piece}`;
  }
  return undefined;
}

/**
 * T3.1 — HTML Living Standard § 9.2.6 step 5 of "Process the field":
 *   "If the value of field starts with a U+0020 SPACE character, remove
 *    it from value."
 *
 * Pre-T3.1 the parser called `.trim()` which destroyed legitimate trailing
 * whitespace (and any extra leading whitespace beyond the first space).
 * This helper strips at most one leading space and leaves everything else.
 *
 * @internal
 */
function stripOneLeadingSpace(value: string): string {
  return value.startsWith(" ") ? value.slice(1) : value;
}

function releaseReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    reader.releaseLock();
  } catch {
    // already released
  }
}
