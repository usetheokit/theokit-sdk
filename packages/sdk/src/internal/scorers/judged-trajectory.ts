/** Judged trajectory scorer: one call rates whether the ordered tool calls were a reasonable path. */

import { z } from "zod";

import type { Score, ScoreContext } from "../../types/eval.js";
import { judgeJson, type LlmJudgeTransportOptions } from "./llm-judge.js";

export interface JudgedTrajectoryOptions extends LlmJudgeTransportOptions {
  /** What the run was supposed to achieve. Defaults to the row's input. */
  readonly goal?: string;
}

const replySchema = z.object({ score: z.number().finite(), reason: z.string().optional() });

function describeCalls(context: ScoreContext | undefined): string[] {
  const calls = context?.toolCalls ?? [];
  if (calls.length === 0) return ["(no tool calls)"];
  return calls.map(
    (c, i) =>
      `${i + 1}. ${c.name} input=${JSON.stringify(c.input)} isError=${c.isError ? "true" : "false"}`,
  );
}

function trajectoryPrompt(
  options: JudgedTrajectoryOptions,
  output: string,
  context: ScoreContext | undefined,
): string {
  return [
    "You are evaluating the sequence of tool calls an AI assistant made to answer a request.",
    "",
    `INPUT: ${context?.input ?? ""}`,
    ...(options.goal !== undefined ? ["", `GOAL: ${options.goal}`] : []),
    "",
    "TOOL CALLS (in order):",
    ...describeCalls(context),
    "",
    "FINAL OUTPUT:",
    '"""',
    output,
    '"""',
    "",
    "Judge whether the tool calls were a reasonable, efficient path to the result (right tools, sensible order, no pointless or repeated calls, errors handled).",
    'Reply with the JSON object ONLY: {"score": <number between 0.0 and 1.0>, "reason": "<one short sentence>"}',
  ].join("\n");
}

export async function scoreJudgedTrajectory(
  options: JudgedTrajectoryOptions,
  output: string,
  context: ScoreContext | undefined,
): Promise<Score> {
  const judged = await judgeJson(trajectoryPrompt(options, output, context), options, replySchema);
  if (!judged.ok) return judged.score;
  const score = Math.max(0, Math.min(1, judged.value.score));
  const reason = judged.value.reason;
  return reason === undefined ? { score } : { score, reason };
}
