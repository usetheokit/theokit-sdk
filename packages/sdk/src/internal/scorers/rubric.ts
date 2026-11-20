/** Rubric judge scorer: one call returns a pass/fail verdict per item; score = weighted pass ratio. */

import { z } from "zod";

import type { Score } from "../../types/eval.js";
import { judgeJson, type LlmJudgeTransportOptions } from "./llm-judge.js";

export interface RubricItem {
  readonly id: string;
  readonly description: string;
  /** Default 1. Must be a positive finite number. */
  readonly weight?: number;
}

export interface RubricOptions extends LlmJudgeTransportOptions {
  readonly items: ReadonlyArray<RubricItem>;
}

const verdictsSchema = z.object({
  verdicts: z.array(z.object({ id: z.string(), pass: z.boolean() })),
});

export function validateRubricItems(items: ReadonlyArray<RubricItem>): void {
  if (items.length === 0) throw new TypeError("Scorers.rubric: items must not be empty");
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) throw new TypeError(`Scorers.rubric: duplicate item id "${item.id}"`);
    ids.add(item.id);
    const w = item.weight ?? 1;
    if (!Number.isFinite(w) || w <= 0) {
      throw new TypeError(`Scorers.rubric: item "${item.id}" weight must be a positive number`);
    }
  }
}

function rubricPrompt(output: string, items: ReadonlyArray<RubricItem>): string {
  return [
    "You are evaluating an AI assistant's output against a rubric. Decide for each item whether the output passes it.",
    "",
    "RUBRIC ITEMS:",
    ...items.map((i) => `- ${i.id}: ${i.description}`),
    "",
    "OUTPUT:",
    '"""',
    output,
    '"""',
    "",
    'Reply with the JSON object ONLY: {"verdicts": [{"id": "<item id>", "pass": <true|false>}, ...]} with exactly one verdict per item.',
  ].join("\n");
}

/** Verdicts keyed by id, or undefined when an id repeats or the set differs from the items. */
function verdictMap(
  verdicts: ReadonlyArray<{ id: string; pass: boolean }>,
  items: ReadonlyArray<RubricItem>,
): Map<string, boolean> | undefined {
  const passById = new Map<string, boolean>();
  for (const v of verdicts) {
    if (passById.has(v.id)) return undefined;
    passById.set(v.id, v.pass);
  }
  const complete = passById.size === items.length && items.every((i) => passById.has(i.id));
  return complete ? passById : undefined;
}

function weightedScore(items: ReadonlyArray<RubricItem>, passById: Map<string, boolean>): Score {
  let total = 0;
  let passed = 0;
  const failed: string[] = [];
  for (const item of items) {
    const w = item.weight ?? 1;
    total += w;
    if (passById.get(item.id) === true) passed += w;
    else failed.push(item.id);
  }
  const score = passed / total;
  return failed.length === 0 ? { score } : { score, reason: `failed: ${failed.join(", ")}` };
}

export async function scoreRubric(options: RubricOptions, output: string): Promise<Score> {
  const judged = await judgeJson(rubricPrompt(output, options.items), options, verdictsSchema);
  if (!judged.ok) return judged.score;
  const passById = verdictMap(judged.value.verdicts, options.items);
  if (passById === undefined) return { score: 0, reason: "judge_unparseable" };
  return weightedScore(options.items, passById);
}
