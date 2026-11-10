/**
 * Gemini text-form tool calls (#939): `<ctrl42>call\nprint(default_api.NAME(k=v, ...))`.
 * Values are Python literals (quoted strings, numbers, True/False/None). A call that does not parse
 * cleanly stays text. @internal
 */
import type { LlmToolCallPart } from "./types.js";

const CALL_START = /print\(\s*default_api\.([A-Za-z_]\w*)\(/g;
const MARKER = /<ctrl\d+>call/g;
const LITERALS: Record<string, unknown> = { True: true, False: false, None: null };
const ESCAPES: Record<string, string> = { n: "\n", t: "\t" };

type Parsed<T> = { value: T; end: number } | undefined;

class Cursor {
  i: number;
  constructor(
    readonly s: string,
    start: number,
  ) {
    this.i = start;
  }
  skipWs(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i] ?? "")) this.i += 1;
  }
  peek(): string | undefined {
    return this.s[this.i];
  }
  match(re: RegExp): string | undefined {
    const m = re.exec(this.s.slice(this.i, this.i + 200));
    if (m === null) return undefined;
    this.i += m[0].length;
    return m[0];
  }
}

function parseString(c: Cursor): string | undefined {
  const quote = c.peek();
  c.i += 1;
  let out = "";
  while (c.i < c.s.length) {
    const ch = c.s[c.i] as string;
    c.i += 1;
    if (ch === quote) return out;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = c.s[c.i];
    if (next === undefined) return undefined;
    out += ESCAPES[next] ?? next;
    c.i += 1;
  }
  return undefined;
}

function parseWord(c: Cursor): { value: unknown } | undefined {
  const word = c.match(/^[^\s,)]+/);
  if (word === undefined) return undefined;
  if (word in LITERALS) return { value: LITERALS[word] };
  if (/^-?\d+(\.\d+)?$/.test(word)) return { value: Number(word) };
  return undefined;
}

function parseValue(c: Cursor): { value: unknown } | undefined {
  const q = c.peek();
  if (q === "'" || q === '"') {
    const str = parseString(c);
    return str === undefined ? undefined : { value: str };
  }
  return parseWord(c);
}

/** Parse one `key=value` pair. */
function parsePair(c: Cursor): { key: string; value: unknown } | undefined {
  const key = c.match(/^[A-Za-z_]\w*/);
  c.skipWs();
  if (key === undefined || c.peek() !== "=") return undefined;
  c.i += 1;
  c.skipWs();
  const v = parseValue(c);
  return v === undefined ? undefined : { key, value: v.value };
}

/** Parse `k=v, k=v` up to (not consuming) the closing `)`. */
function parseKwargs(c: Cursor): Record<string, unknown> | undefined {
  const args: Record<string, unknown> = {};
  for (;;) {
    c.skipWs();
    if (c.peek() === ")") return args;
    const pair = parsePair(c);
    if (pair === undefined) return undefined;
    args[pair.key] = pair.value;
    c.skipWs();
    if (c.peek() === ",") c.i += 1;
    else if (c.peek() !== ")") return undefined;
  }
}

/** Parse one call whose `NAME(` was just consumed; returns the args and the index after `))`. */
function parseCallBody(content: string, from: number): Parsed<Record<string, unknown>> {
  const c = new Cursor(content, from);
  const args = parseKwargs(c);
  if (args === undefined) return undefined;
  c.i += 1; // the call's `)`
  c.match(/^ */);
  if (c.peek() !== ")") return undefined;
  return { value: args, end: c.i + 1 };
}

export function extractGeminiCalls(
  content: string,
  makeId: () => string,
  isPromoted: (name: string) => boolean,
  onDropped: (name: string) => void,
): { calls: LlmToolCallPart[]; text: string } {
  const calls: LlmToolCallPart[] = [];
  let text = "";
  let last = 0;
  CALL_START.lastIndex = 0;
  for (let m = CALL_START.exec(content); m !== null; m = CALL_START.exec(content)) {
    const name = m[1] ?? "";
    const parsed = parseCallBody(content, m.index + m[0].length);
    if (parsed === undefined) continue;
    CALL_START.lastIndex = parsed.end;
    if (!isPromoted(name)) {
      onDropped(name);
      continue;
    }
    calls.push({ type: "tool_use", id: makeId(), name, input: parsed.value });
    text += content.slice(last, m.index);
    last = parsed.end;
  }
  if (calls.length === 0) return { calls, text: content };
  return { calls, text: (text + content.slice(last)).replace(MARKER, "").trim() };
}
