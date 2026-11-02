/**
 * B-564 — opt-in pruning of aged tool results from the next LLM request.
 *
 * The loop resends every tool result of a run on every later call; with
 * `SendOptions.pruneToolResults` set, results older than `olderThanRounds` tool rounds are
 * replaced by a short stub in the REQUEST copy only. The transcript the loop keeps, persists and
 * resumes from is never touched, so a pruned result can always be recovered (plan D1).
 *
 * Position among tool-result messages is the round distance: at call n the newest tool-result
 * message is round n - 1. So no round counter is threaded through the loop. Text-only feedback
 * messages the loop pushes between rounds carry no `tool_result` part and do not count.
 *
 * A pruned part keeps its `toolUseId` and `isError`: every `tool_use` must still have a paired
 * `tool_result` on both wires, so the result is shortened, never removed.
 */

import { ConfigurationError } from "../../errors.js";
import type { PruneToolResultsOptions } from "../../types/run.js";
import type { LlmContentPart, LlmMessage } from "../llm/types.js";

// The contract type lives in `types/run.ts` (types never import internal/); re-exported here
// for the loop types and the package barrel, as `tool-result-guard.ts` does.
export type { PruneToolResultsOptions } from "../../types/run.js";

function stubFor(olderThanRounds: number): string {
  return `[tool result pruned: older than ${olderThanRounds} rounds]`;
}

function carriesToolResult(message: LlmMessage): boolean {
  return message.content.some((part) => part.type === "tool_result");
}

function stubbed(message: LlmMessage, stub: string): LlmMessage {
  const content: LlmContentPart[] = message.content.map((part) =>
    part.type === "tool_result" ? { ...part, content: stub } : part,
  );
  return { ...message, content };
}

/**
 * Build the messages for one LLM request with aged tool results replaced by a stub.
 *
 * @param messages - The loop transcript. Never mutated.
 * @param options - Absent means no pruning: the input array itself is returned, so the
 *   option-off request is byte-identical to the transcript.
 * @returns A new array when `options` is set; untouched messages are the same objects.
 */
export function pruneToolResultsForRequest(
  messages: LlmMessage[],
  options: PruneToolResultsOptions | undefined,
): LlmMessage[] {
  if (options === undefined) return messages;
  const stub = stubFor(options.olderThanRounds);
  const out = [...messages];
  let rounds = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as LlmMessage;
    if (!carriesToolResult(message)) continue;
    rounds += 1;
    if (rounds > options.olderThanRounds) out[index] = stubbed(message, stub);
  }
  return out;
}

/**
 * Fail fast on an option that cannot describe an age in rounds.
 *
 * @throws ConfigurationError with code `invalid_prune_tool_results` when `olderThanRounds` is
 *   not an integer of at least 1.
 */
export function validatePruneToolResults(options: PruneToolResultsOptions | undefined): void {
  if (options === undefined) return;
  const value: unknown = options.olderThanRounds;
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) return;
  throw new ConfigurationError(
    `SendOptions.pruneToolResults.olderThanRounds must be an integer of at least 1, got ${String(value)}`,
    { code: "invalid_prune_tool_results" },
  );
}
