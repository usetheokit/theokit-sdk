/**
 * SE40 — native session store over the Claude-shaped `.jsonl` transcript.
 *
 * The theokit session format IS the Claude Code record shape (see
 * `../../persistence/session-transcript.ts`). This module owns the FS lifecycle:
 * read existing records, seed a {@link SessionTranscript}'s parent chain, append
 * the new turn (user + assistant/tool blocks), and write append-only. Compaction
 * appends a `compact_boundary` record (a new root) — it NEVER shrinks the line
 * set (that would break the DAG). Reads reconstruct `LlmMessage[]` via
 * {@link reconstructMessages}, narrowed to the in-memory {@link SessionMessage}.
 *
 * @internal
 */

import { ConfigurationError } from "../../errors.js";
import type { ToolResultContentBlock } from "../../types/content-blocks.js";
import type { ConversationStep, ConversationTurn } from "../../types/conversation.js";
import type { DeferredToolCall } from "../../types/run.js";
import type { SessionStore } from "../../types/session-store.js";
import {
  type AssistantTurn,
  reconstructAllMessages,
  reconstructMessages,
  type SessionRecord,
  SessionTranscript,
} from "../persistence/session-transcript.js";
import type { SessionMessage, SessionMessagePart } from "./types.js";

/**
 * Seed a {@link SessionTranscript} from the already-on-disk records so a new
 * append parents correctly on the existing DAG leaf. The transcript re-emits the
 * seeded records verbatim before the new turn, so the whole file rewrites atomically
 * as one append-only line set. Returns the transcript primed with the prior records.
 */
function seedTranscript(
  prior: readonly SessionRecord[],
  opts: { cwd: string; sessionId: string; model: string; memoryPartition?: string },
): SessionTranscript {
  return SessionTranscript.fromRecords(prior, opts);
}

/** The turn to persist: the user's text plus the rich per-turn conversation view. */
export interface PersistTurnInput {
  userText: string;
  /** The turn resumes deferred calls: its first conversation turn holds their results, no user text is written. */
  resumed?: boolean;
  /** The turn ended on these unanswered tool calls; they are marked so a later send can resume them. */
  deferredToolCalls?: readonly DeferredToolCall[];
  conversation: readonly ConversationTurn[];
  /**
   * M50 — when supplied, size-driven auto-compaction runs in the SAME write chain after the turn
   * persists (usage real vs the model's context window; summarizer injected by the caller).
   */
  autoCompact?: {
    usageTotal?: number | undefined;
    contextWindow?: number | undefined;
    summarize: (
      messages: readonly import("../../compaction.js").CompressibleMessage[],
    ) => Promise<string>;
  };
}

interface MappedTurn {
  assistant: AssistantTurn;
  toolResults: Array<{ toolUseId: string; content: string; isError?: boolean }>;
}

/**
 * theokit#122 — record the turn's thinking block, signature included.
 *
 * The signature is what makes the block replayable: without it the resumed turn is rejected by
 * Anthropic with `400 "thinking blocks cannot be modified"`.
 */
function applyThinkingStep(
  assistant: AssistantTurn,
  message: { text: string; signature?: string },
): void {
  assistant.thinking = message.text;
  if (message.signature !== undefined) assistant.thinkingSignature = message.signature;
}

/** Fold one agent turn's steps into an assistant record + paired tool results. */
function mapAgentTurn(steps: readonly ConversationStep[]): MappedTurn {
  const assistant: AssistantTurn = {};
  const toolResults: MappedTurn["toolResults"] = [];
  const toolCalls: NonNullable<AssistantTurn["toolCalls"]> = [];
  for (const step of steps) {
    if (step.type === "thinkingMessage") applyThinkingStep(assistant, step.message);
    else if (step.type === "assistantMessage") assistant.text = step.message.text;
    else if (step.type === "toolCall")
      toolCalls.push({
        id: step.message.callId,
        name: step.message.name,
        input: (step.message.args as Record<string, unknown> | undefined) ?? {},
      });
    else
      toolResults.push({
        toolUseId: step.message.callId,
        content: step.message.result,
        isError: step.message.isError,
      });
  }
  if (toolCalls.length > 0) assistant.toolCalls = toolCalls;
  return { assistant, toolResults };
}

/** True when the assistant record carries any content worth emitting. */
function hasAssistantContent(a: AssistantTurn): boolean {
  return a.text !== undefined || a.thinking !== undefined || (a.toolCalls?.length ?? 0) > 0;
}

/**
 * Map the rich `ConversationTurn[]` (from `run.conversation()`) into the native
 * assistant/tool records. One transcript turn is: an `assistant` record carrying
 * thinking + text + tool_use blocks, then (when present) a `user` record carrying
 * the paired tool_result blocks. Tool results pair with tool_use by `callId`.
 */
function appendConversation(
  transcript: SessionTranscript,
  conversation: readonly ConversationTurn[],
): void {
  for (const ct of conversation) {
    if (ct.type !== "agentConversationTurn") continue;
    const { assistant, toolResults } = mapAgentTurn(ct.turn.steps);
    if (hasAssistantContent(assistant)) transcript.appendAssistantTurn(assistant);
    if (toolResults.length > 0) transcript.appendToolResults(toolResults);
  }
}

/**
 * The per-agent transcript metadata used to seed a {@link SessionTranscript}. The
 * actual record I/O goes through the injected {@link SessionStore} (SE41), so this
 * no longer carries a `baseDir` — the store is already bound to its location.
 */
export interface TranscriptLocation {
  cwd: string;
  agentId: string;
  model: string;
  /** `memory.userId` of the agent; stamped on the records the turn writes. */
  memoryPartition?: string | undefined;
}

/**
 * Read the session's records via the {@link SessionStore} and reconstruct the
 * resumable history, narrowed to the in-memory {@link SessionMessage} shape
 * (user/assistant text). Tool turns fold into assistant-role context so resume
 * keeps tool history. Works identically for the FS default and an external store.
 */
export async function readSessionMessages(
  store: SessionStore,
  agentId: string,
  options: { keepDeferred?: boolean } = {},
): Promise<SessionMessage[]> {
  return messagesFromRecords(await store.readRecords(agentId), options);
}

/** Every message record in file order, with no chain walk or compaction cut-off. */
export function allMessagesFromRecords(records: readonly SessionRecord[]): SessionMessage[] {
  return reconstructAllMessages(records).map(narrowToSessionMessage);
}

/** The reconstruction half of {@link readSessionMessages}, for a caller that already holds records. */
export function messagesFromRecords(
  records: readonly SessionRecord[],
  options: { keepDeferred?: boolean } = {},
): SessionMessage[] {
  const visible = options.keepDeferred === true ? records : withoutAbandonedCalls(records);
  return reconstructMessages(visible).map(narrowToSessionMessage);
}

/**
 * Drop the `tool_use` blocks of deferred calls that no `tool_result` answers. A provider rejects a
 * history holding an unanswered call, so a deferral nobody resumed would block the session for good;
 * a resume reads the transcript with `keepDeferred` instead.
 */
function withoutAbandonedCalls(records: readonly SessionRecord[]): readonly SessionRecord[] {
  const deferred = new Set([...storedSchemaVersions(records).keys()]);
  if (deferred.size === 0) return records;
  for (const rec of records) {
    for (const b of rec.message?.content ?? []) {
      if (b.type === "tool_result") deferred.delete(b.tool_use_id);
    }
  }
  if (deferred.size === 0) return records;
  return records.map((rec) => {
    const content = rec.message?.content;
    if (rec.message === undefined || content === undefined) return rec;
    const kept = content.filter((b) => b.type !== "tool_use" || !deferred.has(b.id));
    return kept.length === content.length
      ? rec
      : { ...rec, message: { ...rec.message, content: kept } };
  });
}

type NarrowPart = {
  type: string;
  text?: string;
  content?: unknown;
  name?: string;
  id?: string;
  toolUseId?: string;
  input?: unknown;
  isError?: boolean;
};

/** Render one reconstructed content part as folded session text. */
function partToText(p: NarrowPart): string {
  if (p.type === "text") return p.text ?? "";
  if (p.type === "tool_use") return `[tool call] ${p.name ?? ""}`;
  if (p.type === "tool_result") {
    const body = typeof p.content === "string" ? p.content : JSON.stringify(p.content);
    return `[tool result] ${body}`;
  }
  return "";
}

/**
 * theokit#146 — the same part, kept as STRUCTURE.
 *
 * `partToText` above is what the model replay wants; a host rendering tool cards needs the call id,
 * the tool name and the arguments, none of which survive `[tool call] NAME`. Both projections are
 * produced from the one reconstructed part, so they cannot drift apart.
 *
 * Returns `undefined` for a part with no display meaning (e.g. an image placeholder the session
 * projection does not model), which the caller filters out.
 */
function partToStructured(p: NarrowPart): SessionMessagePart | undefined {
  if (p.type === "text") return { type: "text", text: p.text ?? "" };
  if (p.type === "tool_use") {
    return {
      type: "tool_use",
      id: p.id ?? "",
      name: p.name ?? "",
      input: (p.input ?? {}) as Record<string, unknown>,
    };
  }
  if (p.type === "tool_result") {
    return {
      type: "tool_result",
      toolUseId: p.toolUseId ?? "",
      // Reconstructed tool results carry either a string or the SE7 content blocks; both are
      // already the session shape, so this narrows `unknown` rather than converting anything.
      content: p.content as string | ReadonlyArray<ToolResultContentBlock>,
      ...(p.isError === true ? { isError: true } : {}),
    };
  }
  return undefined;
}

/** Flatten a reconstructed `LlmMessage` to the narrowed in-memory `SessionMessage`. */
function narrowToSessionMessage(m: {
  role: "system" | "user" | "assistant";
  content: NarrowPart[];
}): SessionMessage {
  const role = m.role === "user" ? "user" : "assistant";
  const text = m.content
    .map(partToText)
    .filter((s) => s.length > 0)
    .join("\n");
  const parts = m.content
    .map(partToStructured)
    .filter((p): p is SessionMessagePart => p !== undefined);
  return { role, text, parts };
}

/** The records appended by the last turn (the delta beyond the seeded prior). */
function deltaRecords(
  transcript: SessionTranscript,
  priorLength: number,
): readonly SessionRecord[] {
  return transcript.records().slice(priorLength);
}

/**
 * Persist one conversation turn (user + assistant/tool records) to the session
 * store, append-only. Reads the prior records to seed the parent chain, folds the
 * new turn, and appends ONLY the delta via {@link SessionStore.appendRecords}
 * (the store owns the append atomicity — the FS default serializes under a file
 * lock). Within one process, turns for an agent are already chained upstream, so
 * the read→append is ordered; cross-host ordering is the external store's contract.
 */
export async function persistTurn(
  store: SessionStore,
  loc: TranscriptLocation,
  sessionId: string,
  turn: PersistTurnInput,
): Promise<void> {
  const prior = await store.readRecords(loc.agentId);
  const transcript = seedTranscript(prior, {
    cwd: loc.cwd,
    sessionId,
    model: loc.model,
    ...(loc.memoryPartition !== undefined ? { memoryPartition: loc.memoryPartition } : {}),
  });
  if (turn.resumed !== true) transcript.appendUserTurn(turn.userText);
  appendConversation(transcript, turn.conversation);
  if (turn.deferredToolCalls !== undefined && turn.deferredToolCalls.length > 0) {
    transcript.appendDeferredCalls(
      turn.deferredToolCalls.map((c) => ({
        toolUseId: c.toolUseId,
        schemaVersion: c.schemaVersion,
      })),
    );
  }
  await store.appendRecords(loc.agentId, deltaRecords(transcript, prior.length));
}

/**
 * Append-only compaction: add a `compact_boundary` system record (a new root) so
 * resume replays only the post-boundary continuation. Appends only the boundary
 * record via the store — NEVER rewrites or shrinks the prior records.
 */
export async function appendCompactBoundaryRecord(
  store: SessionStore,
  loc: TranscriptLocation,
  sessionId: string,
  meta: { preTokens: number; trigger: string },
): Promise<void> {
  const prior = await store.readRecords(loc.agentId);
  const transcript = seedTranscript(prior, { cwd: loc.cwd, sessionId, model: loc.model });
  transcript.appendCompactBoundary(meta);
  await store.appendRecords(loc.agentId, deltaRecords(transcript, prior.length));
}

/** The `tool_use` ids of an assistant record that no id in `answered` closes. */
function openToolUseIds(rec: SessionRecord, answered: ReadonlySet<string>): string[] {
  const ids: string[] = [];
  for (const b of rec.message?.content ?? []) {
    if (b.type === "tool_use" && !answered.has(b.id)) ids.push(b.id);
  }
  return ids;
}

/** The ids a user record answers, or `undefined` when it holds anything but tool results. */
function answeredIds(rec: SessionRecord): string[] | undefined {
  const blocks = rec.message?.content ?? [];
  if (!blocks.every((b) => b.type === "tool_result")) return undefined;
  return blocks.flatMap((b) => (b.type === "tool_result" ? [b.tool_use_id] : []));
}

/** The newest turn's unanswered `tool_use` blocks, or none when anything follows them. */
function unansweredToolUses(
  records: readonly SessionRecord[],
): { record: SessionRecord; ids: string[] } | undefined {
  const answered = new Set<string>();
  for (const rec of [...records].reverse().filter((r) => r.type !== "system")) {
    if (rec.type === "assistant") {
      const ids = openToolUseIds(rec, answered);
      return ids.length > 0 ? { record: rec, ids } : undefined;
    }
    // A user turn with anything but tool results means the conversation moved on.
    const closed = answeredIds(rec);
    if (closed === undefined) return undefined;
    for (const id of closed) answered.add(id);
  }
  return undefined;
}

/** The schema version stored for each deferred call; a call without a marker is a version 1 one. */
function storedSchemaVersions(records: readonly SessionRecord[]): Map<string, number> {
  const versions = new Map<string, number>();
  for (const rec of records) {
    if (rec.subtype !== "deferred_tool_calls") continue;
    for (const c of rec.deferredToolCalls ?? []) versions.set(c.toolUseId, c.schemaVersion);
  }
  return versions;
}

/** Reject a stored call whose schema version this SDK does not read. */
function assertSupportedVersion(toolUseId: string, version: number): void {
  if (version === 1) return;
  throw new ConfigurationError(
    `Deferred tool call ${toolUseId} was stored with schema version ${version}; this SDK resumes version 1 only.`,
    { code: "deferred_schema_unsupported" },
  );
}

/**
 * The tool calls a deferred run left unanswered at the end of the stored transcript, in call order.
 * Empty when the newest turn has none. Throws `ConfigurationError` (`deferred_schema_unsupported`)
 * for a stored call whose schema version this SDK does not read.
 */
export async function readPendingToolCalls(
  store: SessionStore,
  agentId: string,
): Promise<DeferredToolCall[]> {
  const records = await store.readRecords(agentId);
  const pending = unansweredToolUses(records);
  if (pending === undefined) return [];
  const versions = storedSchemaVersions(records);
  const parsedAt = Date.parse(pending.record.timestamp);
  const deferredAt = Number.isNaN(parsedAt) ? 0 : parsedAt;
  const open = new Set(pending.ids);
  return (pending.record.message?.content ?? []).flatMap((block) => {
    if (block.type !== "tool_use" || !open.has(block.id)) return [];
    assertSupportedVersion(block.id, versions.get(block.id) ?? 1);
    const call: DeferredToolCall = {
      schemaVersion: 1,
      toolUseId: block.id,
      toolName: block.name,
      input: (block.input ?? {}) as Record<string, unknown>,
      deferredAt,
    };
    return [call];
  });
}

/**
 * Match the decisions of a resume against the pending calls: exactly one decision per pending call.
 * Throws `ConfigurationError` (`tool_decision_unknown`, `tool_decision_duplicate`,
 * `tool_decision_missing`) before anything is written, so a bad resume leaves the session unchanged.
 */
export function matchToolDecisions(
  pending: readonly DeferredToolCall[],
  decisions: ReadonlyArray<{ toolUseId: string; behavior: string }>,
): void {
  if (pending.length === 0) {
    throw new ConfigurationError("There is no deferred tool call to resume.", {
      code: "no_deferred_tool_calls",
    });
  }
  const ids = new Set(pending.map((c) => c.toolUseId));
  const seen = new Set<string>();
  for (const d of decisions) {
    if (!ids.has(d.toolUseId)) {
      throw new ConfigurationError(`No deferred tool call has toolUseId "${d.toolUseId}".`, {
        code: "tool_decision_unknown",
      });
    }
    if (seen.has(d.toolUseId)) {
      throw new ConfigurationError(`Two decisions for toolUseId "${d.toolUseId}".`, {
        code: "tool_decision_duplicate",
      });
    }
    if (d.behavior !== "allow" && d.behavior !== "deny") {
      throw new ConfigurationError(`Decision for "${d.toolUseId}" must be "allow" or "deny".`, {
        code: "tool_decision_invalid",
      });
    }
    seen.add(d.toolUseId);
  }
  const missing = pending.filter((c) => !seen.has(c.toolUseId)).map((c) => c.toolUseId);
  if (missing.length > 0) {
    throw new ConfigurationError(
      `Missing decision for deferred tool call(s): ${missing.join(", ")}.`,
      {
        code: "tool_decision_missing",
      },
    );
  }
}
