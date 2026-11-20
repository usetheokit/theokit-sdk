/**
 * Faithfulness judge scorer: extract the answer's claims (call 1), then judge each against the
 * context (call 2). Score = supported claims / claims.
 */

import { z } from "zod";

import type { Score, ScoreContext } from "../../types/eval.js";
import { judgeJson, type LlmJudgeTransportOptions } from "./llm-judge.js";

export interface FaithfulnessOptions extends LlmJudgeTransportOptions {
  /** `ScoreContext.metadata` key holding the context (string or string[]). Default `"context"`. */
  readonly contextKey?: string;
}

const claimsSchema = z.object({ claims: z.array(z.string()) });
const verdictsSchema = z.object({
  verdicts: z.array(z.object({ index: z.number().int(), supported: z.boolean() })),
});

const MAX_LISTED = 5;
const MAX_CLAIM_CHARS = 120;

function readContext(ctx: ScoreContext | undefined, key: string): string | undefined {
  const raw = ctx?.metadata?.[key];
  const parts = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
  if (!parts.every((p) => typeof p === "string")) return undefined;
  const text = (parts as string[]).filter((p) => p.trim() !== "").join("\n\n");
  return text === "" ? undefined : text;
}

function claimsPrompt(output: string): string {
  return [
    "Break the ANSWER into a list of short, self-contained factual claims.",
    "",
    "ANSWER:",
    '"""',
    output,
    '"""',
    "",
    'Reply with the JSON object ONLY: {"claims": ["<claim>", ...]}. Use an empty list if there are no factual claims.',
  ].join("\n");
}

function verdictsPrompt(claims: readonly string[], context: string): string {
  return [
    "For each numbered CLAIM, decide whether it is supported by the CONTEXT alone.",
    "",
    "CONTEXT:",
    '"""',
    context,
    '"""',
    "",
    "CLAIMS:",
    ...claims.map((c, i) => `${i}. ${c}`),
    "",
    'Reply with the JSON object ONLY: {"verdicts": [{"index": <claim number>, "supported": <true|false>}, ...]} with exactly one verdict per claim.',
  ].join("\n");
}

/** The verdict indexes must cover every claim exactly once; otherwise the reply is unusable. */
function supportedSet(
  verdicts: ReadonlyArray<{ index: number; supported: boolean }>,
  count: number,
): Set<number> | undefined {
  const seen = new Set<number>();
  const supported = new Set<number>();
  for (const v of verdicts) {
    if (v.index < 0 || v.index >= count || seen.has(v.index)) return undefined;
    seen.add(v.index);
    if (v.supported) supported.add(v.index);
  }
  return seen.size === count ? supported : undefined;
}

function unsupportedReason(claims: readonly string[], supported: Set<number>): string | undefined {
  const bad = claims.filter((_, i) => !supported.has(i));
  if (bad.length === 0) return undefined;
  const listed = bad
    .slice(0, MAX_LISTED)
    .map((c) => (c.length > MAX_CLAIM_CHARS ? `${c.slice(0, MAX_CLAIM_CHARS)}…` : c));
  const more = bad.length > MAX_LISTED ? ` (+${bad.length - MAX_LISTED} more)` : "";
  return `unsupported: ${listed.join(" | ")}${more}`;
}

export async function scoreFaithfulness(
  options: FaithfulnessOptions,
  output: string,
  context: ScoreContext | undefined,
): Promise<Score> {
  const contextText = readContext(context, options.contextKey ?? "context");
  if (contextText === undefined) return { score: 0, reason: "context_missing" };
  const extracted = await judgeJson(claimsPrompt(output), options, claimsSchema);
  if (!extracted.ok) return extracted.score;
  const claims = extracted.value.claims;
  if (claims.length === 0) return { score: 1, reason: "no_claims" };
  const judged = await judgeJson(verdictsPrompt(claims, contextText), options, verdictsSchema);
  if (!judged.ok) return judged.score;
  const supported = supportedSet(judged.value.verdicts, claims.length);
  if (supported === undefined) return { score: 0, reason: "judge_unparseable" };
  const reason = unsupportedReason(claims, supported);
  const score = supported.size / claims.length;
  return reason === undefined ? { score } : { score, reason };
}
