import { ToolDecisionMismatchError } from "../../errors.js";
import type { DeferredToolCall, SendOptions, ToolCallDecision } from "../../types/run.js";
import type { SessionStore } from "../../types/session-store.js";
import { findPendingDeferredCalls, matchToolDecisions } from "../session/deferred-calls.js";
import { flushSessionWrites, readSessionMessages } from "../session/index.js";
import type { SessionMessage } from "../session/types.js";

/**
 * A send that answers deferred tool calls: the calls read from the transcript, the host's decisions
 * for them, and the transcript's own messages (with their tool blocks) as the history to replay.
 *
 * @internal
 */
export interface ToolResume {
  readonly calls: readonly DeferredToolCall[];
  readonly decisions: readonly ToolCallDecision[];
  readonly priorMessages: SessionMessage[];
}

/**
 * Reads the session's pending deferred calls and checks `options.toolDecisions` against them.
 * Returns `undefined` for an ordinary send. A plain send on a session that ends on deferred calls
 * throws: the pending calls are never dropped silently.
 *
 * @internal
 */
export async function resolveToolResume(
  store: SessionStore,
  agentId: string,
  options: SendOptions,
): Promise<ToolResume | undefined> {
  await flushSessionWrites();
  const pending = findPendingDeferredCalls(await store.readRecords(agentId));
  if (pending.length > 0 && options.toolDecisions === undefined) {
    throw new ToolDecisionMismatchError(
      `This session ends on deferred tool calls (${pending.map((c) => c.toolUseId).join(", ")}); pass toolDecisions to answer them.`,
    );
  }
  const decisions = matchToolDecisions(pending, options.toolDecisions);
  if (decisions === undefined) return undefined;
  return { calls: pending, decisions, priorMessages: await readSessionMessages(store, agentId) };
}
