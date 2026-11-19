import { ConfigurationError, ToolDecisionMismatchError } from "../../errors.js";
import type { DeferredToolCall } from "../../types/run.js";
import type { SessionRecord } from "../../types/session-record.js";
import type { SessionStore } from "../../types/session-store.js";
import { flushSessionWrites } from "./index.js";

/** Reads one stored call; a `schemaVersion` this build does not read is refused, not guessed at. */
function readDeferred(raw: unknown): DeferredToolCall {
  const call = raw as DeferredToolCall;
  if (call.schemaVersion === 1) return call;
  throw new ConfigurationError(
    `Pending tool call has unsupported schemaVersion ${String(call.schemaVersion)}; upgrade @theokit/sdk`,
    { code: "deferred_schema_unsupported" },
  );
}

/** Folds one record into the pending set: a deferred record adds calls, a `tool_result` removes them. */
function applyRecord(pending: Map<string, DeferredToolCall>, rec: SessionRecord): void {
  const added = rec.type === "system" && rec.subtype === "deferred_tool_calls";
  for (const raw of added ? (rec.deferredToolCalls ?? []) : []) {
    const call = readDeferred(raw);
    pending.set(call.toolUseId, call);
  }
  for (const b of rec.message?.content ?? []) {
    if (b.type === "tool_result") pending.delete(b.tool_use_id);
  }
}

/**
 * The tool calls a session is waiting on: deferred in a `deferred_tool_calls` record and not yet
 * answered by a later `tool_result`. Records are read in file order (append-only).
 *
 * @internal
 */
export function findPendingDeferredCalls(records: readonly SessionRecord[]): DeferredToolCall[] {
  const pending = new Map<string, DeferredToolCall>();
  for (const rec of records) applyRecord(pending, rec);
  return [...pending.values()];
}

/**
 * Refuses a send on a session that ends on deferred tool calls: the pending calls are never dropped
 * silently. (Answering them is not supported yet.)
 *
 * @internal
 */
export async function assertNoPendingDeferredCalls(
  store: SessionStore,
  agentId: string,
): Promise<void> {
  await flushSessionWrites();
  const pending = findPendingDeferredCalls(await store.readRecords(agentId));
  if (pending.length === 0) return;
  throw new ToolDecisionMismatchError(
    `Session ends on deferred tool calls (${pending.map((c) => c.toolUseId).join(", ")}); a send would drop them`,
  );
}
