/**
 * Tool-call collection for the eval runner, and the deterministic scorers over it
 * (`Scorers.toolCallAccuracy`, `Scorers.trajectory`).
 *
 * @internal
 */

import type { Score, ScoreContext, ScoredToolCall } from "../../types/eval.js";
import type { Run } from "../../types/run.js";

export type MatchInput = "exact" | "subset" | "ignore";
export type TrajectoryOrder = "strict" | "subsequence" | "any";

interface MutableCall {
  name: string;
  input: Record<string, unknown>;
  output?: string;
  isError: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

function applyToolMessage(
  calls: Map<string, MutableCall>,
  m: {
    call_id: string;
    name: string;
    status: string;
    args?: unknown;
    result?: unknown;
  },
): void {
  let call = calls.get(m.call_id);
  if (call === undefined) {
    call = { name: m.name, input: {}, isError: false };
    calls.set(m.call_id, call);
  }
  if (isRecord(m.args)) call.input = m.args;
  if (m.status === "error") call.isError = true;
  if (m.status !== "running" && m.result !== undefined) call.output = stringify(m.result);
}

async function drainToolCalls(run: Run, calls: Map<string, MutableCall>): Promise<void> {
  let seen = 0;
  for await (const ev of run.events()) {
    seen += 1;
    if (ev.kind === "message" && ev.message.type === "tool_call")
      applyToolMessage(calls, ev.message);
  }
  // Some runtimes (fixture runs) record messages but leave the merged timeline empty.
  if (seen > 0 || typeof run.stream !== "function") return;
  for await (const message of run.stream()) {
    if (message.type === "tool_call") applyToolMessage(calls, message);
  }
}

/**
 * Drain a run's timeline into its tool calls, in the order each call started. A run without
 * `events()` (a partial double) or whose timeline throws yields what was gathered so far.
 */
export async function collectToolCalls(run: Run): Promise<ScoredToolCall[]> {
  const calls = new Map<string, MutableCall>();
  if (typeof run.events !== "function") return [];
  try {
    await drainToolCalls(run, calls);
  } catch {
    // keep whatever was observed; scoring must not fail on a timeline error
  }
  return [...calls.values()].map((c) => ({
    name: c.name,
    input: c.input,
    ...(c.output !== undefined ? { output: c.output } : {}),
    isError: c.isError,
  }));
}

// ---------------------------------------------------------------------------
// Scorers
// ---------------------------------------------------------------------------

interface ExpectedCall {
  name: string;
  input?: Record<string, unknown>;
}

function parseExpectedCalls(raw: unknown): ExpectedCall[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ExpectedCall[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.name !== "string") return undefined;
    if (item.input !== undefined && !isRecord(item.input)) return undefined;
    out.push({ name: item.name, ...(item.input !== undefined ? { input: item.input } : {}) });
  }
  return out;
}

/** `expected.toolCalls` wins when present (even if malformed); metadata is the fallback. */
function resolveExpectedCalls(expected: unknown, ctx?: ScoreContext): ExpectedCall[] | undefined {
  if (isRecord(expected) && "toolCalls" in expected) return parseExpectedCalls(expected.toolCalls);
  return parseExpectedCalls(ctx?.metadata?.expectedToolCalls);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return stringify(canonical(a)) === stringify(canonical(b));
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (isRecord(v)) {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, canonical(v[k])]),
    );
  }
  return v;
}

function isSubset(want: unknown, have: unknown): boolean {
  if (isRecord(want)) {
    if (!isRecord(have)) return false;
    return Object.keys(want).every((k) => k in have && isSubset(want[k], have[k]));
  }
  return deepEqual(want, have);
}

function inputMatches(mode: MatchInput, want: Record<string, unknown> | undefined, have: unknown) {
  if (mode === "ignore" || want === undefined) return true;
  return mode === "exact" ? deepEqual(want, have) : isSubset(want, have);
}

function matchCalls(
  want: ExpectedCall[],
  actual: readonly ScoredToolCall[],
  mode: MatchInput,
): { used: Set<number>; missing: string[] } {
  const used = new Set<number>();
  const missing: string[] = [];
  for (const exp of want) {
    const idx = actual.findIndex(
      (a, i) => !used.has(i) && a.name === exp.name && inputMatches(mode, exp.input, a.input),
    );
    if (idx === -1) missing.push(exp.name);
    else used.add(idx);
  }
  return { used, missing };
}

export function scoreToolCallAccuracy(
  opts: { matchInput: MatchInput; allowExtra: boolean },
  expected: unknown,
  ctx: ScoreContext | undefined,
): Score {
  const want = resolveExpectedCalls(expected, ctx);
  if (want === undefined) return { score: 0, reason: "expected_tool_calls_missing" };
  const actual = ctx?.toolCalls ?? [];
  const { used, missing } = matchCalls(want, actual, opts.matchInput);
  const extra = opts.allowExtra ? undefined : actual.find((_, i) => !used.has(i));
  if (extra !== undefined) return { score: 0, reason: `unexpected_tool_call:${extra.name}` };
  if (want.length === 0) return { score: 1 };
  const score = (want.length - missing.length) / want.length;
  return missing.length === 0 ? { score } : { score, reason: `missing_tool_call:${missing[0]}` };
}

function parseTrajectory(expected: unknown): string[] | undefined {
  if (!isRecord(expected) || !Array.isArray(expected.trajectory)) return undefined;
  const t = expected.trajectory;
  return t.every((x): x is string => typeof x === "string") ? (t as string[]) : undefined;
}

function strictDivergence(want: string[], got: string[]): string | undefined {
  const n = Math.max(want.length, got.length);
  for (let i = 0; i < n; i += 1) {
    if (want[i] !== got[i]) {
      return `trajectory_mismatch_at_position:${i + 1} (expected ${want[i] ?? "<end>"}, got ${got[i] ?? "<end>"})`;
    }
  }
  return undefined;
}

function subsequenceDivergence(want: string[], got: string[]): string | undefined {
  let pos = 0;
  for (let i = 0; i < want.length; i += 1) {
    const found = got.indexOf(want[i] as string, pos);
    if (found === -1) return `trajectory_mismatch_at_position:${i + 1} (missing ${want[i]})`;
    pos = found + 1;
  }
  return undefined;
}

function anyDivergence(want: string[], got: string[]): string | undefined {
  const remaining = [...got];
  for (let i = 0; i < want.length; i += 1) {
    const found = remaining.indexOf(want[i] as string);
    if (found === -1) return `trajectory_mismatch_at_position:${i + 1} (missing ${want[i]})`;
    remaining.splice(found, 1);
  }
  return undefined;
}

export function scoreTrajectory(
  order: TrajectoryOrder,
  expected: unknown,
  ctx: ScoreContext | undefined,
): Score {
  const want = parseTrajectory(expected);
  if (want === undefined) return { score: 0, reason: "expected_trajectory_missing" };
  const got = (ctx?.toolCalls ?? []).map((c) => c.name);
  const check =
    order === "strict" ? strictDivergence : order === "any" ? anyDivergence : subsequenceDivergence;
  const divergence = check(want, got);
  return divergence === undefined ? { score: 1 } : { score: 0, reason: divergence };
}
