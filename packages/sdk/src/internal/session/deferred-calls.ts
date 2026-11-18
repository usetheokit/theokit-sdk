import { ConfigurationError, ToolDecisionMismatchError } from "../../errors.js";
import type { DeferredToolCall, ToolCallDecision } from "../../types/run.js";
import type { SessionRecord } from "../../types/session-record.js";

/** The `DeferredToolCall.schemaVersion` this build reads and writes. */
const SUPPORTED_SCHEMA_VERSION = 1;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validates one stored record; an unknown `schemaVersion` is refused rather than guessed at. */
function parseDeferredCall(raw: unknown): DeferredToolCall {
  if (!isRecord(raw) || raw.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    const found = isRecord(raw) ? String(raw.schemaVersion) : "none";
    throw new ConfigurationError(
      `Pending tool call has schemaVersion ${found}; this SDK reads version ${SUPPORTED_SCHEMA_VERSION}. Upgrade @theokit/sdk, or answer the call with the version that wrote it.`,
      { code: "deferred_schema_unsupported" },
    );
  }
  return raw as unknown as DeferredToolCall;
}

/** The ids a deferred record names, with the raw entry kept for validation. */
function deferredEntries(rec: SessionRecord): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  for (const raw of rec.deferredToolCalls ?? []) {
    const id = isRecord(raw) ? raw.toolUseId : undefined;
    if (typeof id === "string") out.push([id, raw]);
  }
  return out;
}

/**
 * The tool calls a session is waiting on: deferred in a `deferred_tool_calls` record and not yet
 * answered by a later `tool_result`. Records are read in file order (append-only).
 *
 * @internal
 */
export function findPendingDeferredCalls(records: readonly SessionRecord[]): DeferredToolCall[] {
  const pending = new Map<string, unknown>();
  for (const rec of records) applyRecord(pending, rec);
  return [...pending.values()].map(parseDeferredCall);
}

/** Folds one record into the pending set: a deferred record adds ids, a `tool_result` removes them. */
function applyRecord(pending: Map<string, unknown>, rec: SessionRecord): void {
  if (rec.type === "system") {
    if (rec.subtype !== "deferred_tool_calls") return;
    for (const [id, raw] of deferredEntries(rec)) pending.set(id, raw);
    return;
  }
  for (const block of rec.message?.content ?? []) {
    if (block.type === "tool_result") pending.delete(block.tool_use_id);
  }
}

/**
 * Checks `toolDecisions` against the pending calls. Every pending id needs exactly one decision and
 * every decision must name a pending id. Returns `undefined` when nothing is pending and no decision
 * was given (an ordinary send).
 *
 * @internal
 */
export function matchToolDecisions(
  pending: readonly DeferredToolCall[],
  decisions: readonly ToolCallDecision[] | undefined,
): readonly ToolCallDecision[] | undefined {
  const given = decisions ?? [];
  if (pending.length === 0 && given.length === 0) return undefined;
  const pendingIds = pending.map((c) => c.toolUseId);
  const givenIds = given.map((d) => d.toolUseId);
  const unknown = givenIds.filter((id) => !pendingIds.includes(id));
  const missing = pendingIds.filter((id) => !givenIds.includes(id));
  const duplicated = givenIds.filter((id, i) => givenIds.indexOf(id) !== i);
  if (unknown.length === 0 && missing.length === 0 && duplicated.length === 0) return given;
  const parts: string[] = [];
  if (unknown.length > 0) parts.push(`not pending: ${unknown.join(", ")}`);
  if (missing.length > 0) parts.push(`pending with no decision: ${missing.join(", ")}`);
  if (duplicated.length > 0) parts.push(`decided twice: ${duplicated.join(", ")}`);
  throw new ToolDecisionMismatchError(
    `toolDecisions do not match the deferred tool calls (${parts.join("; ")})`,
  );
}
