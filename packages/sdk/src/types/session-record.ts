/**
 * Owner: `src/` (1 of 2 importers). Derived from the import graph, not
 * declared — `tests/lint/types-name-their-owner.test.ts` re-derives it.
 *
 * `SessionRecord` — the native on-disk transcript record shape (SE40).
 *
 * The theokit session format IS the Claude Code record shape: a
 * `uuid`/`parentUuid` DAG of records with structured
 * `text`/`tool_use`/`tool_result`/`thinking` blocks. This is the contract the
 * pluggable {@link SessionStore} seam operates over.
 *
 * DIP-correct home (SE46): the contract lives in the domain `types/` layer;
 * the application-layer DAG core (`internal/persistence/session-transcript.ts`)
 * re-exports it for back-compat while owning the record builders + reader.
 *
 * @public
 */

/** A content block inside {@link TranscriptMessage}. */
export type TranscriptBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking?: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: unknown; is_error?: boolean };

/**
 * The message body of a {@link SessionRecord}.
 *
 * **It is NOT called `SessionMessage`** — that name already exists in
 * `internal/session/session-types.ts` with the shape `{role, text}`, incompatible with this one.
 * Reusing an exported name for a new shape is
 * precisely the silent break M91 cost two patches to undo.
 *
 * Parsing from disk stays **tolerant** (`readTranscript` skips a malformed line): what changes here
 * is the **type**, not leniency — records written by earlier versions stay readable.
 *
 * @public
 */
export interface TranscriptMessage {
  role: "user" | "assistant";
  content: TranscriptBlock[];
  /**
   * The three fields below appear **only** on the assistant record, and come from the writer
   * (`SessionTranscript.appendAssistant`). Declared optional because the user record does not carry
   * them — measured in the writer itself, not assumed.
   */
  id?: string;
  type?: "message";
  model?: string;
}

/**
 * One transcript record — a single line of the session JSONL file, and the unit the pluggable
 * `SessionStore` seam reads and writes.
 *
 * Records form a `uuid`/`parentUuid` DAG, not a flat list: `parentUuid` names the preceding record
 * and is `null` at the root. Thread a session by following those links; a reader that assumes file
 * order is linear will mis-thread one that branched.
 *
 * `message` is absent on `system` records — a compaction boundary carries `compactMetadata` instead —
 * so it is optional even on records you would expect to be conversational, and `type` is what tells
 * you which you are holding.
 *
 * Reading is deliberately tolerant: a malformed line is skipped rather than failing the whole read.
 * Every record you receive is well-formed, but the file may have contained more than you got back,
 * so this is not the type to use for an exact-count audit of what was written.
 *
 * @public
 */
export interface SessionRecord {
  type: "user" | "assistant" | "system";
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  isSidechain?: boolean;
  userType?: string;
  cwd?: string;
  version?: string;
  subtype?: string;
  compactMetadata?: { preTokens: number; trigger: string };
  /**
   * The message body, in the shape the transcript writer actually writes.
   *
   * M94 — it was `Record<string, unknown>`, and the consumer recovered the type with a cast on every read.
   * The shape **has always been fixed** (`SessionTranscript.appendToolResults` / `#push` produce
   * it); it simply was not declared. It stays optional because system records carry no message.
   */
  message?: TranscriptMessage;
}
