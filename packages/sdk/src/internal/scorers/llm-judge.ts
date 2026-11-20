/**
 * LLM-as-judge scorer implementation (ADR D205).
 *
 * Builds a transient agent with the judge model + apiKey, calls the public
 * Agent facade's `prompt` (via the `getAgentFacade()` inversion seam) with a
 * structured judge prompt, parses score from the response. Returns 0 (with
 * diagnostic reason) on any parse failure.
 *
 * NOTE — no internal-visibility tag in this block. `tsconfig.base.json` sets `stripInternal: true`,
 * and TypeScript scans EVERY leading comment range of the declaration that follows, including the
 * import right below this one. The tag that used to sit here deleted that import from the emitted
 * `.d.ts`, leaving the types it binds unresolvable for any consumer running type-aware lint
 * (usetheodev/theokit-sdk#283 records the same trap on a declaration).
 */

import type { ZodType } from "zod";

import type { ModelSelection } from "../../types/agent.js";
import type { Score } from "../../types/eval.js";
import type { ProviderRoutingSettings } from "../../types/providers.js";
import { getAgentFacade } from "../runtime/registry/agent-factory-registry.js";

/** The judge transport shared by `llmJudge`, `faithfulness`, `rubric` and `judgedTrajectory`. */
export interface LlmJudgeTransportOptions {
  readonly model: ModelSelection;
  readonly apiKey: string;
  readonly providers?: ProviderRoutingSettings;
}

export interface LlmJudgeOptions extends LlmJudgeTransportOptions {
  readonly criteria: string;
  /** "continuous" → [0, 1] real number. "discrete" → 0 or 1 only. Default: continuous. */
  readonly rubric?: "continuous" | "discrete";
}

function buildPrompt(
  subject: string,
  criteria: string,
  rubric: "continuous" | "discrete",
  expected: unknown,
): string {
  const scoreHint =
    rubric === "discrete" ? "between 0 and 1 (use 0 for fail, 1 for pass)" : "between 0.0 and 1.0";
  const expectedBlock =
    expected !== undefined ? `EXPECTED (reference): ${JSON.stringify(expected)}\n\n` : "";
  return [
    "You are evaluating an AI assistant's output.",
    "",
    `CRITERIA: ${criteria}`,
    "",
    `${expectedBlock}ACTUAL OUTPUT:`,
    '"""',
    subject,
    '"""',
    "",
    `Reply with EXACTLY this JSON object on a single line:`,
    `{"score": <number ${scoreHint}>, "reason": "<one short sentence>"}`,
    "",
    "Reply with the JSON object ONLY. No preface, no explanation outside the JSON.",
  ].join("\n");
}

/**
 * EC-8: regex is GENEROUS — accepts the JSON object even when the model
 * wraps it in markdown fences (```json ... ```) or prose around it.
 */
const SCORE_REGEX = /\{\s*"score"\s*:\s*([0-9]*\.?[0-9]+)\s*,\s*"reason"\s*:\s*"([^"]*)"\s*\}/;

export async function callJudge(
  message: string,
  options: LlmJudgeTransportOptions,
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  try {
    const result = await getAgentFacade().prompt(message, {
      apiKey: options.apiKey,
      model: options.model,
      local: { cwd: process.cwd(), sandboxOptions: { enabled: false } },
      // #581 — a `shell` tool is ALWAYS registered on a local agent, including when `tools: []` is
      // passed, so this judge held one it never asked for. `sandboxOptions: { enabled: false }` is
      // not a mitigation for that and reads like one: it does not restrict the shell, it removes the
      // sandbox around it.
      //
      // A judge is the worst place for it. Its entire job is to read content produced by the thing
      // under evaluation, so anything able to influence that content was talking to a process that
      // held an unsandboxed shell in `process.cwd()`. `types/agent.ts` § LocalOptions records the
      // case that already happened: a working directory holding the benchmark's answer key, and two
      // transcripts showing the model citing it.
      //
      // Withholding rather than sandboxing, because this judge needs no shell at all — removing it
      // from the catalog beats confining it. The line above is left as it was: with no shell there
      // is nothing for it to govern, and changing it would be a second, unrelated decision.
      withheldBuiltinTools: ["shell"],
      ...(options.providers !== undefined ? { providers: options.providers } : {}),
    });
    if (result.status === "finished") return { ok: true, text: result.result ?? "" };
    return { ok: false, reason: `judge_run_failed: ${result.error?.message ?? result.status}` };
  } catch (err) {
    return {
      ok: false,
      reason: `judge_threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * The parser, exposed for tests. NOT re-exported from any barrel — `_...ForTests` is this repo's
 * convention for a seam that exists so a test can call production code instead of copying it
 * (`_redactAttrValueForTests`, `__resetSnapshotStoresForTests`).
 *
 * It exists because the alternative was measured and was worse: the judge's only test file declared
 * its own copy of `SCORE_REGEX` under the comment "Mirror the one in llm-judge.ts", and six of its
 * eight cases exercised the copy. Byte-identical today, which is exactly why the drift would have
 * been invisible — changing the production regex broke nothing there. Testing a mirror tests the
 * mirror.
 */
export function _parseScoreForTests(text: string, rubric: "continuous" | "discrete"): Score {
  return parseScore(text, rubric);
}

function parseScore(text: string, rubric: "continuous" | "discrete"): Score {
  const match = SCORE_REGEX.exec(text);
  if (match === null) return { score: 0, reason: "judge_parse_failed" };
  const raw = Number(match[1]);
  if (!Number.isFinite(raw)) return { score: 0, reason: "judge_score_not_finite" };
  const clamped = rubric === "discrete" ? (raw >= 0.5 ? 1 : 0) : Math.max(0, Math.min(1, raw));
  return { score: clamped, reason: match[2] };
}

export async function llmJudgeScore(
  options: LlmJudgeOptions & { output: string; expected?: unknown },
): Promise<Score> {
  const rubric = options.rubric ?? "continuous";
  const message = buildPrompt(options.output, options.criteria, rubric, options.expected);
  const judgement = await callJudge(message, options);
  if (!judgement.ok) return { score: 0, reason: judgement.reason };
  return parseScore(judgement.text, rubric);
}

/** Pull the first JSON object out of a reply, tolerating markdown fences and surrounding prose. */
function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/**
 * One judge call whose reply must be a JSON object accepted by `schema`. A transport failure keeps
 * its reason; a reply that is not JSON or does not fit the schema is `judge_unparseable`.
 */
export async function judgeJson<T>(
  message: string,
  options: LlmJudgeTransportOptions,
  schema: ZodType<T>,
): Promise<{ ok: true; value: T } | { ok: false; score: Score }> {
  const judgement = await callJudge(message, options);
  if (!judgement.ok) return { ok: false, score: { score: 0, reason: judgement.reason } };
  const parsed = schema.safeParse(extractJson(judgement.text));
  if (!parsed.success) return { ok: false, score: { score: 0, reason: "judge_unparseable" } };
  return { ok: true, value: parsed.data };
}
