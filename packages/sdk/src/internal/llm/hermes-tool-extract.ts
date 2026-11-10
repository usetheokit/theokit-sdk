/**
 * Hermes tool-call extraction — leaked-dialect safe-parse (theokit#58 follow-up).
 *
 * Some models (qwen3-coder via OpenRouter, OpenAI-compatible API) intermittently emit their
 * Hermes tool-call dialect as assistant TEXT content instead of native `tool_calls`:
 *
 *   <function=NAME><parameter=KEY>VALUE</parameter>...</function></tool_call>
 *
 * When that happens the provider sends ZERO native tool_calls, so the agent loop sees an
 * `end_turn` with no tools and the intended call is silently lost. This pure helper recovers
 * those calls from the content so the loop can execute them.
 *
 * OPT-IN only (`ProviderProfile.extractToolCallsFromContent`) and run ONLY when the provider
 * emitted no native tool_calls. A code assistant can legitimately print a literal `<function=` in a
 * fenced code block, so recovery is gated TWICE: the per-route flag is the coarse enable, and the R5
 * request-scoped `allowedToolNames` allowlist below is the precise false-positive guard — a block is
 * promoted only when its name is a real tool in the current request. The size-guard (no native call)
 * prevents double-counting a real native call.
 *
 * Fail-open like `stripThinkBlocks`: a partial/unclosed block (missing the `</tool_call>`
 * marker) is NOT matched — it stays in the residual text and yields no tool call, so a corrupted
 * stream never fabricates a call from junk.
 *
 * Accepted best-effort limit (mirrors the consumer-side stripper EC-5): if a parameter VALUE
 * contains the literal substring `</tool_call>`, the non-greedy block scanner closes at that inner
 * occurrence. This errs toward NOT over-consuming text — same class as `strip-think`'s EC-10.
 *
 * Recovered parameter values are ALWAYS strings: the text dialect carries no per-param type info, so
 * `<parameter=count>5</parameter>` yields `{ count: "5" }`, not `{ count: 5 }`. A downstream schema
 * (e.g. Zod) coercing/validating the tool input is the right place to type it — a mismatch there
 * fails clear (typed tool error), never silently. This differs from the native `tool_calls` path,
 * whose `arguments` is JSON and is parsed into typed values.
 *
 * @internal
 */
import { sanitizeToolInput } from "../../sanitize/sanitize-tool-input.js";
import { extractGeminiCalls } from "./gemini-text-calls.js";
import type { LlmToolCallPart } from "./types.js";

/** A full leaked block: `<function=NAME> …inner… </tool_call>`. The closing `</tool_call>` is
 *  required (fail-open: a partial block at stream end is left as text). Non-greedy inner. */
const GEMINI_FORMAT = "gemini-default-api";
const HERMES_BLOCK = /<function=\s*([^>\s]+)\s*>([\s\S]*?)<\/tool_call>/g;
/** A single parameter inside a block: `<parameter=KEY>VALUE</parameter>`. Non-greedy value. */
const HERMES_PARAM = /<parameter=\s*([^>\s]+)\s*>([\s\S]*?)<\/parameter>/g;

export interface HermesExtractResult {
  /** Recovered tool calls (empty when none matched). */
  toolCalls: LlmToolCallPart[];
  /** Content with every PROMOTED block removed + trimmed; gated-out and unmatched blocks stay visible. */
  residualText: string;
  /** Names of well-formed leaked blocks that WERE dropped by the request-scoped allowlist (R5) — a
   *  block whose name is not a tool in the current request. Empty when no allowlist was applied or
   *  nothing was gated out. The caller logs these so a guard firing is observable in production. */
  droppedNames: string[];
  /** Names of the text formats a call was recovered from ("hermes", "gemini-default-api"). */
  formats: string[];
}

/**
 * Recover Hermes-dialect tool calls leaked into assistant text. `makeId` supplies a unique id per
 * recovered call (the provider gave none). Pure — no side effects.
 *
 * @param allowedToolNames R5 request-scoped gate — when provided, only a block whose name is in the
 *   set is promoted (exact, case-sensitive); an empty set promotes nothing; `undefined` recovers all
 *   (back-compat). Gated-out blocks stay as visible text (they are not tool calls).
 * @internal
 */
export function extractHermesToolCalls(
  content: string,
  makeId: () => string,
  allowedToolNames?: ReadonlySet<string>,
): HermesExtractResult {
  // R5 request-scoped gate: promote a block only when its name is a real tool in the current request
  // (exact, case-sensitive — peer-project payload.ts:190). `undefined` allowlist → recover-all (back-compat
  // for direct callers); an EMPTY set recovers nothing (a request with no tools has nothing legitimate
  // to recover). The name is already trimmed above, so the gate and the emitted call agree (EC-1).
  const isPromoted = (name: string): boolean =>
    name.length > 0 && (allowedToolNames === undefined || allowedToolNames.has(name));
  const toolCalls: LlmToolCallPart[] = [];
  const droppedNames: string[] = [];
  for (const block of content.matchAll(HERMES_BLOCK)) {
    const name = (block[1] ?? "").trim();
    if (!isPromoted(name)) {
      // A well-formed leaked block gated out by a defined allowlist — record it for observability.
      if (name.length > 0 && allowedToolNames !== undefined) droppedNames.push(name);
      continue;
    }
    toolCalls.push({
      type: "tool_use",
      id: makeId(),
      name,
      input: parseHermesParams(block[2] ?? ""),
    });
  }
  // EC-5: strip ONLY promoted blocks — a gated-out block (e.g. a `<function=example>` in a code fence
  // whose name is not a request tool) keeps its text visible instead of being silently deleted.
  const residualText =
    toolCalls.length === 0
      ? content
      : content
          .replace(HERMES_BLOCK, (full, rawName) =>
            isPromoted((rawName ?? "").trim()) ? "" : full,
          )
          .trim();
  return withGeminiCalls(
    toolCalls,
    residualText,
    droppedNames,
    makeId,
    isPromoted,
    allowedToolNames,
  );
}

/** Second pass: recover Gemini text-form calls from what the Hermes pass left, and merge the results. */
function withGeminiCalls(
  toolCalls: LlmToolCallPart[],
  residual: string,
  droppedNames: string[],
  makeId: () => string,
  isPromoted: (name: string) => boolean,
  allowedToolNames: ReadonlySet<string> | undefined,
): HermesExtractResult {
  const gemini = extractGeminiCalls(residual, makeId, isPromoted, (name) => {
    if (allowedToolNames !== undefined) droppedNames.push(name);
  });
  const formats = [
    toolCalls.length > 0 ? "hermes" : "",
    gemini.calls.length > 0 ? GEMINI_FORMAT : "",
  ];
  return {
    toolCalls: [...toolCalls, ...gemini.calls],
    residualText: gemini.text,
    droppedNames,
    formats: formats.filter(Boolean),
  };
}

/** Parse the `<parameter=KEY>VALUE</parameter>` pairs inside a block's inner text into an input map.
 *
 * Value hygiene is DELEGATED to the public `sanitizeToolInput` primitive (`@theokit/sdk/sanitize`,
 * trim-only) so the internal recovery and the public sanitizer share ONE source of truth (DRY) — the
 * P0 bug (`\n`-wrapped paths → `not_found` → stalled multi-read loops) was born from an ad-hoc,
 * un-shared trim. Keys are trimmed here (the regex already excludes whitespace from the key capture);
 * values stay strings (the doc-comment invariant), trimmed by the shared primitive. */
function parseHermesParams(inner: string): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const param of inner.matchAll(HERMES_PARAM)) {
    const key = param[1];
    const value = param[2];
    if (key === undefined || value === undefined) continue;
    input[key.trim()] = value;
  }
  return sanitizeToolInput(input, { trim: true }).value;
}

const STREAM_MARKER = "<function=";
const DEFAULT_STREAM_BUFFER_CAP = 8192;

const isStreamWs = (c: string | undefined): boolean =>
  c === " " || c === "\t" || c === "\n" || c === "\r";

/**
 * R7 stream-boundary suppression FSM. Classifies a suspicion buffer (accumulated streamed content)
 * as `"possible"` — it could still become a `<function=NAME>` tool call for a request tool, so the
 * caller HOLDS it (emits no text_delta) — or `"impossible"` — confirmed NOT a tool call, so the
 * caller FLUSHES it as visible text. The marker match is CASE-SENSITIVE, identical to `HERMES_BLOCK`
 * (no `/i`), so the FSM never holds a block `extractHermesToolCalls` would not recover (EC-1). An
 * empty allowlist promotes nothing (`"impossible"`); over `cap` while still tool-call-like fails open
 * to `"impossible"` (flush) so a never-closing marker cannot grow unbounded. Pure — never throws.
 * @internal
 */
export function streamToolCallBufferState(
  held: string,
  allowedToolNames: ReadonlySet<string>,
  cap: number = DEFAULT_STREAM_BUFFER_CAP,
): "possible" | "impossible" {
  if (allowedToolNames.size === 0) return "impossible";
  const t = held.trimStart();
  if (t.length < STREAM_MARKER.length) {
    // Still building the marker itself (e.g. "<fun").
    return STREAM_MARKER.startsWith(t) ? "possible" : "impossible";
  }
  if (!t.startsWith(STREAM_MARKER)) return "impossible";
  const parsed = parseStreamMarkerName(t);
  if (parsed === "building") return "possible";
  if (parsed === "invalid") return "impossible";
  const nameOk = parsed.complete
    ? allowedToolNames.has(parsed.name)
    : someToolNameStartsWith(allowedToolNames, parsed.name);
  if (!nameOk) return "impossible";
  return held.length > cap ? "impossible" : "possible";
}

/** Read the (partial) tool name after a confirmed `<function=` marker (skipping the regex `\s*`).
 *  `"building"` = only the marker(+ws) so far; `"invalid"` = a `>`/other char with no name. */
function parseStreamMarkerName(
  t: string,
): { name: string; complete: boolean } | "building" | "invalid" {
  let cursor = STREAM_MARKER.length;
  while (cursor < t.length && isStreamWs(t[cursor])) cursor += 1;
  const nameStart = cursor;
  while (cursor < t.length && t[cursor] !== ">" && !isStreamWs(t[cursor])) cursor += 1;
  const name = t.slice(nameStart, cursor);
  if (name.length === 0) return cursor >= t.length ? "building" : "invalid";
  return { name, complete: cursor < t.length && t[cursor] === ">" };
}

/** True when any allowed tool name starts with `prefix` — the streaming partial-name probe (R7 D2). */
function someToolNameStartsWith(allowedToolNames: ReadonlySet<string>, prefix: string): boolean {
  for (const name of allowedToolNames) {
    if (name.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * R7 mixed-delta split: given a suspicion buffer that is NOT itself a possible tool call as a whole,
 * find the first `<` index whose suffix COULD still become a `<function=NAME>` tool call for a request
 * tool — so the caller flushes the definitely-prose prefix and holds only the suspicious suffix (e.g.
 * a `hello <function=read` delta flushes `hello ` and holds `<function=read`). Returns `-1` when no
 * suffix is suspicious (flush the whole buffer). Bounded: scans only `<` positions. @internal
 */
export function firstPossibleMarkerStart(
  held: string,
  allowedToolNames: ReadonlySet<string>,
): number {
  for (let i = held.indexOf("<"); i !== -1; i = held.indexOf("<", i + 1)) {
    if (streamToolCallBufferState(held.slice(i), allowedToolNames) === "possible") return i;
  }
  return -1;
}

/**
 * R7 stateful stream-suppression buffer. Owns the held-content buffer for one stream: `push` feeds a
 * content delta and returns the text to emit now (or `undefined` to HOLD while it could still be a
 * `<function=NAME>` tool call for a request tool); `drain` finalizes at stream end. Extracted from the
 * OpenAI accumulator so the adapter stays thin (G8). @internal
 */
export class StreamSuppressionBuffer {
  #held = "";
  constructor(private readonly allowedToolNames: ReadonlySet<string>) {}

  /** Feed a content delta; returns the text to emit as a `text_delta` now, or `undefined` to hold. */
  push(content: string): string | undefined {
    this.#held += content;
    if (streamToolCallBufferState(this.#held, this.allowedToolNames) === "possible")
      return undefined;
    // Whole buffer is not a tool call, but a marker for a request tool may start mid-buffer (prose +
    // marker in one delta) — flush the prose prefix, hold the suspicious suffix.
    const holdStart = firstPossibleMarkerStart(this.#held, this.allowedToolNames);
    if (holdStart > 0) {
      const flush = this.#held.slice(0, holdStart);
      this.#held = this.#held.slice(holdStart);
      return flush;
    }
    const flush = this.#held;
    this.#held = "";
    return flush;
  }

  /** Drain the held buffer at stream end. `hasNativeCalls` mirrors `finish()`'s size-guard: when
   *  native `tool_calls` exist, `finish()` won't strip the leaked block, so stream the held text WHOLE
   *  (keeping `accumulatedText == finish.text`); otherwise strip the recoverable blocks. Idempotent. */
  drain(hasNativeCalls: boolean): string | undefined {
    if (this.#held.length === 0) return undefined;
    const held = this.#held;
    this.#held = "";
    if (hasNativeCalls) return held;
    const residual = extractHermesToolCalls(held, () => "held", this.allowedToolNames).residualText;
    return residual.length > 0 ? residual : undefined;
  }
}
