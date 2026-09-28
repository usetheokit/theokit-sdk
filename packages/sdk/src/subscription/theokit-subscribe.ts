/**
 * `Theokit.subscribe` client (G8 public API) — `@theokit/sdk`.
 *
 * Per ADR D427 (Theokit.subscribe namespace) + D424 (transport selection)
 * + D423 (lastEventId opaque propagation).
 *
 * Returns an AsyncGenerator that yields server-sent values. Transparent
 * reconnect with exponential backoff. Propagates `lastEventId` from the last
 * received tracked envelope on each reconnect attempt.
 *
 * @public
 */

import { boundFetch } from "../internal/runtime-fetch.js";
import { parseSseW3C } from "./internal/sse-parser.js";
import type { WireFrame } from "./internal/subscription-runtime.js";
import {
  SubscriptionDisconnectError,
  SubscriptionError,
  type SubscriptionTransport,
} from "./types.js";

/**
 * Options accepted by `Theokit.subscribe(name, input, opts?)`.
 *
 * @public
 */
export interface SubscribeOptions {
  /** Base URL of the server (e.g., `"http://localhost:3000"`). Required. */
  baseUrl: string;
  /** Preferred transport. Default `"auto"` (WS preferred, SSE fallback). */
  transport?: SubscriptionTransport;
  /** Max reconnect attempts (default 10). 0 disables reconnect. */
  maxReconnectAttempts?: number;
  /** Backoff strategy. Default exponential `min(30_000, 1000 * 2^attempt)` ms. */
  retryDelayMs?: (attempt: number) => number;
  /** Caller-supplied abort signal. Cancels the subscription entirely. */
  signal?: AbortSignal;
  /** Additional fetch-style headers (e.g., `Authorization`). */
  headers?: Record<string, string>;
  /**
   * Override the SSE transport's `fetch`. Defaults to `globalThis.fetch`.
   * Lets a consumer supply a proxying agent or instrumented fetch without
   * mutating the runtime global.
   */
  fetch?: typeof globalThis.fetch;
  /**
   * Override the WS transport's `WebSocket` constructor. Defaults to
   * `globalThis.WebSocket`. Lets a consumer polyfill WS on a runtime that
   * lacks it, or supply an instrumented implementation, without mutating
   * the runtime global.
   */
  WebSocket?: typeof WebSocket;
}

const defaultRetry = (attempt: number) => Math.min(30_000, 1000 * 2 ** attempt);

/**
 * Subscribe to a typed subscription. Yields values produced by the server
 * handler. On disconnect with reconnect enabled, transparently re-establishes
 * the connection and forwards `lastEventId` from the last received tracked
 * envelope so the server handler can resume.
 *
 * @public
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: subscribe orchestrates reconnect + transport switch + resume, and the interleaving is the contract. THE DEBT IS UNOWNED — this used to claim it was "tracked in subscription/theokit-subscribe.ts:52 followup", which is a line in an unrelated JSDoc block in this same file, and grepping the file for followup/todo/fixme/#NNN returns only this comment. The citation was its own only evidence. Saying the debt is unowned is worse news and true; a maintainer who checks the tracking before touching the module's @public entry point now learns that in one grep instead of three.
export async function* subscribe<TInput, TOutput>(
  name: string,
  input: TInput,
  opts: SubscribeOptions,
): AsyncGenerator<TOutput, void, void> {
  if (typeof name !== "string" || name.length === 0) {
    throw new SubscriptionError("Theokit.subscribe: name must be a non-empty string", {
      code: "subscribe_name_invalid",
    });
  }
  if (opts === null || typeof opts !== "object" || typeof opts.baseUrl !== "string") {
    throw new SubscriptionError("Theokit.subscribe: opts.baseUrl is required", {
      code: "subscribe_baseUrl_missing",
    });
  }
  const transport = opts.transport ?? "auto";
  const maxReconnects = opts.maxReconnectAttempts ?? 10;
  const retry = opts.retryDelayMs ?? defaultRetry;

  let lastEventId: string | undefined;
  let attempt = 0;

  while (true) {
    if (opts.signal?.aborted) return;
    try {
      const inputWithCursor = mergeLastEventId(input, lastEventId);
      const chosen = await selectTransport(transport, name, opts);
      if (chosen === "ws") {
        for await (const out of openWs<TOutput>(name, inputWithCursor, opts)) {
          if (out.lastEventId !== undefined) lastEventId = out.lastEventId;
          attempt = 0; // reset backoff on successful frame
          yield out.value;
        }
      } else {
        for await (const out of openSse<TOutput>(name, inputWithCursor, opts)) {
          if (out.lastEventId !== undefined) lastEventId = out.lastEventId;
          attempt = 0;
          yield out.value;
        }
      }
      // Clean end-of-stream — no reconnect.
      return;
    } catch (cause) {
      if (opts.signal?.aborted) return;
      if (maxReconnects === 0 || attempt >= maxReconnects) {
        if (cause instanceof SubscriptionError) throw cause;
        throw new SubscriptionDisconnectError(
          `subscription "${name}" disconnected; reconnect exhausted`,
          { cause },
        );
      }
      const delay = retry(attempt);
      attempt++;
      await sleep(delay, opts.signal);
    }
  }
}

interface FrameOut<T> {
  readonly value: T;
  readonly lastEventId?: string;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: openSse parses framed SSE stream with abort/error/retry branches — refactor candidate
async function* openSse<T>(
  name: string,
  input: unknown,
  opts: SubscribeOptions,
): AsyncIterable<FrameOut<T>> {
  const url = `${stripTrailingSlash(opts.baseUrl)}/api/subscriptions/${encodeURIComponent(name)}?input=${encodeURIComponent(JSON.stringify(input))}`;
  const fetchFn = boundFetch(opts.fetch);
  const res = await fetchFn(url, {
    method: "GET",
    headers: {
      accept: "text/event-stream",
      ...(opts.headers ?? {}),
    },
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });
  if (!res.ok || res.body === null) {
    throw new SubscriptionError(`SSE subscribe failed: HTTP ${res.status} ${res.statusText}`, {
      code: "sse_http_error",
    });
  }
  const events = parseSseW3C(streamToAsyncIterable(res.body));
  for await (const ev of events) {
    if (ev.event === "end") return;
    if (ev.event === "error") {
      throw new SubscriptionError(`SSE server emitted error: ${ev.data ?? "(no body)"}`, {
        code: "sse_server_error",
      });
    }
    if (ev.event === "connected") continue;
    if (ev.data === undefined) continue;
    const parsedValue = safeJsonParse<T>(ev.data);
    if (parsedValue === undefined) continue;
    yield {
      value: parsedValue,
      ...(ev.id !== undefined ? { lastEventId: ev.id } : {}),
    };
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: openWs orchestrates WS lifecycle + envelope decode + cleanup — refactor candidate
async function* openWs<T>(
  name: string,
  input: unknown,
  opts: SubscribeOptions,
): AsyncIterable<FrameOut<T>> {
  const baseUrl = stripTrailingSlash(opts.baseUrl);
  const wsUrl = baseUrl
    .replace(/^http:/, "ws:")
    .replace(/^https:/, "wss:")
    .concat("/api/ws");

  const WS = opts.WebSocket ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (WS === undefined) {
    throw new SubscriptionError(
      "Theokit.subscribe(transport='ws'): no global WebSocket available. Use Node >=22 or install 'ws' as a runtime dep + assign to globalThis.WebSocket, or pass opts.WebSocket.",
      { code: "ws_global_missing" },
    );
  }
  const ws = new WS(wsUrl);

  // Set up async iterator-like state.
  const incoming: WireFrame[] = [];
  // biome-ignore lint/suspicious/noConfusingVoidType: idiomatic event-callback signature; refactoring to undefined would mask the no-value semantics
  let waiter: ((value: void) => void) | null = null;
  let closed = false;
  let closeError: Error | undefined;

  ws.addEventListener("message", (ev: MessageEvent) => {
    const data = typeof ev.data === "string" ? ev.data : "";
    const frame = safeJsonParse<WireFrame>(data);
    if (frame !== undefined) {
      incoming.push(frame);
      if (waiter !== null) {
        waiter();
        waiter = null;
      }
    }
  });
  ws.addEventListener("close", () => {
    closed = true;
    if (waiter !== null) {
      waiter();
      waiter = null;
    }
  });
  ws.addEventListener("error", () => {
    closed = true;
    closeError = new Error("WebSocket error");
    if (waiter !== null) {
      waiter();
      waiter = null;
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("WS connect failed")), { once: true });
  });

  // Send subscribe request after handshake.
  ws.send(JSON.stringify({ kind: "subscribe", name, input }));

  if (opts.signal !== undefined) {
    opts.signal.addEventListener("abort", () => ws.close(), { once: true });
  }

  try {
    while (true) {
      if (incoming.length === 0) {
        if (closed) {
          if (closeError !== undefined) throw closeError;
          return;
        }
        await new Promise<void>((resolve) => {
          waiter = resolve;
        });
        continue;
      }
      const frame = incoming.shift() as WireFrame;
      if (frame.type === "end") return;
      if (frame.type === "error") {
        // The server's own code wins. `ws_server_error` is the fallback for a frame that carries
        // none — it used to be the code for EVERY server-side failure, so a caller could not tell an
        // invalid input from a disconnect without reading English out of the message.
        throw new SubscriptionError(
          `WS server emitted error: ${frame.error?.message ?? "(unknown)"}`,
          { code: frame.error?.code ?? "ws_server_error" },
        );
      }
      const value = frame.data as T;
      yield {
        value,
        ...(frame.id !== undefined ? { lastEventId: frame.id } : {}),
      };
    }
  } finally {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function selectTransport(
  pref: SubscriptionTransport,
  _name: string,
  opts: SubscribeOptions,
): Promise<"ws" | "sse"> {
  if (pref === "ws") return "ws";
  if (pref === "sse") return "sse";
  // auto — prefer WS if available (injected or global), else SSE.
  const WS = opts.WebSocket ?? (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof WS === "function") {
    return "ws";
  }
  return "sse";
}

function mergeLastEventId(input: unknown, lastEventId: string | undefined): unknown {
  if (lastEventId === undefined) return input;
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    // Cannot merge into primitive — return as-is.
    return input;
  }
  return { ...(input as object), lastEventId };
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function safeJsonParse<T>(s: string): T | undefined {
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
}

async function* streamToAsyncIterable(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  let finishedNaturally = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        finishedNaturally = true;
        return;
      }
      if (value !== undefined) yield value;
    }
  } finally {
    // B-131: `releaseLock()` alone detaches the reader WITHOUT canceling the stream (WHATWG
    // Streams spec) — the underlying `fetch` response body, and its socket, stays open until
    // something else cancels it or reads it to completion. A consumer that breaks out of the
    // subscription mid-stream (the ordinary shape: `for await ... break`) used to leave that
    // connection dangling. `cancel()` is a no-op once the stream is already closed, so it is safe
    // to call unconditionally on the early-exit path; skip it on natural completion, where the
    // stream is already done and canceling only risks surfacing a spurious rejection.
    if (!finishedNaturally) {
      try {
        await reader.cancel();
      } catch {
        /* best-effort cleanup — the caller's own error (if any) already takes precedence */
      }
    }
    reader.releaseLock();
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
