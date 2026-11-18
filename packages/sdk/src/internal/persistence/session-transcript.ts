/**
 * SE40 — native session transcript (Claude-Code-compatible on-disk shape, theokit-native names).
 *
 * The theokit session format IS the Claude Code record shape (a `uuid`/`parentUuid` DAG of records with
 * structured `text`/`tool_use`/`tool_result`/`thinking` blocks) — so the ecosystem's read-side tools
 * parse our sessions AND, pointed at `~/.claude`, the Claude Code CLI can `--continue` them. This module
 * is the PURE core: append-per-turn record builders + the DAG reader that rebuilds `LlmMessage[]` for
 * resume. File I/O + loop wiring + append-only compaction live in the FS store.
 *
 * Reader mirrors `claude-code-log` dag.py: leaf = a uuid never used as a parentUuid; walk parentUuid to a
 * root (cycle-break); dedup a uuid across sessions keeping the earliest; a `compact_boundary` root
 * terminates the walk so a resume-after-compaction replays only the post-boundary continuation.
 *
 * reference: knowledge-base/references/claude-code-log/claude_code_log/dag.py + models.py
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { SessionRecord, TranscriptBlock } from "../../types/session-record.js";
import { diag } from "../diagnostics.js";
import type { LlmContentPart, LlmMessage, LlmToolResultPart } from "../llm/types.js";
import { redactSecrets } from "../security/redact.js";
import { replaceFileAtomic } from "./atomic-write.js";

// The `SessionRecord` contract now lives in the domain `types/` layer (SE46 DIP
// direction). Re-exported here so existing importers of this DAG-core module
// keep resolving the same name.
export type { SessionRecord } from "../../types/session-record.js";

export interface SessionTranscriptOptions {
  cwd: string;
  sessionId: string;
  model: string;
  version?: string;
}

export interface AssistantTurn {
  text?: string;
  thinking?: string;
  /**
   * theokit#122 — the provider's signature for the thinking block. Written into the `thinking`
   * record block (`Block` already declared `signature?`), so a resumed session can replay the block
   * exactly as the provider issued it.
   */
  thinkingSignature?: string;
  toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
}

/** Claude Code path convention: cwd with every non-alphanumeric replaced by `-`. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Make a caller-supplied session id safe as a path component (no traversal). */
export function safeSessionId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "-");
}

const red = (s: string): string => redactSecrets(s);

/** Deep-redact a structured value (tool input) preserving object shape. */
function redactValue(value: unknown): unknown {
  try {
    return JSON.parse(redactSecrets(JSON.stringify(value ?? null)));
  } catch {
    return redactSecrets(String(value));
  }
}

// M94 — it was `Record<string, unknown>`. The published type describes the same shape this file
// has always produced; the local alias now points at it so writer and reader cannot
// diverge silently.
type Block = TranscriptBlock;

/**
 * Builds a session transcript append-by-append, maintaining the `parentUuid` chain. Each turn mints a
 * fresh `uuid` and parents on the previous record; `appendCompactBoundary` starts a NEW ROOT.
 */
export class SessionTranscript {
  #records: SessionRecord[] = [];
  #last: string | null = null;
  #opts: SessionTranscriptOptions;

  constructor(opts: SessionTranscriptOptions) {
    this.#opts = opts;
  }

  /**
   * Seed a transcript from records already on disk so a subsequent append parents
   * on the existing DAG leaf (the last record in file order). Prior records are
   * re-emitted verbatim by {@link records}, so the whole file rewrites atomically
   * as one append-only line set — never shrinking (SE40 compaction is append-only).
   */
  static fromRecords(
    prior: readonly SessionRecord[],
    opts: SessionTranscriptOptions,
  ): SessionTranscript {
    const t = new SessionTranscript(opts);
    t.#records = [...prior];
    t.#last = prior.length > 0 ? (prior[prior.length - 1]?.uuid ?? null) : null;
    return t;
  }

  #push(
    rec: Omit<SessionRecord, "uuid" | "parentUuid" | "sessionId" | "timestamp">,
  ): SessionRecord {
    const full: SessionRecord = {
      ...rec,
      uuid: randomUUID(),
      parentUuid: this.#last,
      sessionId: this.#opts.sessionId,
      timestamp: new Date().toISOString(),
      isSidechain: false,
      userType: "external",
      cwd: this.#opts.cwd,
      version: this.#opts.version ?? "1.0.0-theokit",
    };
    this.#records.push(full);
    this.#last = full.uuid;
    return full;
  }

  appendUserTurn(text: string): SessionRecord {
    return this.#push({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: red(text) }] },
    });
  }

  appendAssistantTurn(turn: AssistantTurn): SessionRecord {
    const content: Block[] = [];
    if (turn.thinking) {
      // theokit#122 — the signature is computed by the provider over the ORIGINAL text, so it is
      // only valid while the text is byte-identical. Redaction rewrites the text; keeping the
      // signature next to a masked body persists a pair that Anthropic rejects with
      // `400 "thinking blocks cannot be modified"` — the very failure this issue exists to remove.
      //
      // So redaction WINS and the signature is dropped. The block survives as display-only history
      // (`thinkingToWireBlock` already refuses to replay an unsigned block), which loses one block
      // of context; keeping a signature that cannot verify would lose the whole turn.
      //
      // The signature itself is never redacted — it is an opaque provider token with no user
      // content — but that was only half the reasoning the first version of this fix wrote down.
      const redactedThinking = red(turn.thinking);
      const signatureStillValid =
        turn.thinkingSignature !== undefined && redactedThinking === turn.thinking;
      content.push({
        type: "thinking",
        thinking: redactedThinking,
        ...(signatureStillValid ? { signature: turn.thinkingSignature } : {}),
      });
    }
    if (turn.text) content.push({ type: "text", text: red(turn.text) });
    for (const c of turn.toolCalls ?? []) {
      content.push({ type: "tool_use", id: c.id, name: c.name, input: redactValue(c.input) });
    }
    return this.#push({
      type: "assistant",
      message: {
        id: randomUUID(),
        type: "message",
        role: "assistant",
        model: this.#opts.model,
        content,
      },
    });
  }

  appendToolResults(
    results: Array<{ toolUseId: string; content: string; isError?: boolean }>,
  ): SessionRecord {
    const content: Block[] = results.map((r) => ({
      type: "tool_result",
      tool_use_id: r.toolUseId,
      content: red(r.content),
      is_error: r.isError === true,
    }));
    return this.#push({ type: "user", message: { role: "user", content } });
  }

  /** Append-only compaction: a `compact_boundary` system record becomes a NEW ROOT (parentUuid null). */
  appendCompactBoundary(meta: { preTokens: number; trigger: string }): SessionRecord {
    const rec: SessionRecord = {
      type: "system",
      uuid: randomUUID(),
      parentUuid: null,
      sessionId: this.#opts.sessionId,
      timestamp: new Date().toISOString(),
      subtype: "compact_boundary",
      compactMetadata: meta,
      isSidechain: false,
      userType: "external",
      cwd: this.#opts.cwd,
      version: this.#opts.version ?? "1.0.0-theokit",
    };
    this.#records.push(rec);
    this.#last = rec.uuid;
    return rec;
  }

  records(): readonly SessionRecord[] {
    return this.#records;
  }
}

// ─── Reader (DAG → LlmMessage[]) ──────────────────────────────────────────────────────────────────

/** Earliest timestamp seen per session id. */
function sessionFirstTimestamps(records: readonly SessionRecord[]): Map<string, string> {
  const first = new Map<string, string>();
  for (const r of records) {
    const cur = first.get(r.sessionId);
    if (cur === undefined || r.timestamp < cur) first.set(r.sessionId, r.timestamp);
  }
  return first;
}

/** Dedup a uuid across sessions: keep the record whose session's earliest timestamp is smallest. */
function dedupByUuid(records: readonly SessionRecord[]): Map<string, SessionRecord> {
  const firstTs = sessionFirstTimestamps(records);
  const byUuid = new Map<string, SessionRecord>();
  for (const r of records) {
    const existing = byUuid.get(r.uuid);
    const wins =
      existing === undefined ||
      (firstTs.get(r.sessionId) ?? "") < (firstTs.get(existing.sessionId) ?? "");
    if (wins) byUuid.set(r.uuid, r);
  }
  return byUuid;
}

/**
 * Map one structured block to an `LlmContentPart`.
 *
 * theokit#122 — thinking blocks used to be DROPPED here, which is why an extended-thinking session
 * could not be resumed: the block never made it back into the replayed messages, so the provider saw
 * a conversation whose assistant turn had lost its thinking. They are now reconstructed with their
 * signature; the Anthropic wire re-serializes signed blocks and skips unsigned ones.
 */
function thinkingBlockToPart(b: Extract<Block, { type: "thinking" }>): LlmContentPart {
  return {
    type: "thinking",
    text: String(b.thinking ?? ""),
    ...(b.signature !== undefined ? { signature: String(b.signature) } : {}),
  };
}

function blockToPart(b: Block): LlmContentPart | undefined {
  if (b.type === "text") return { type: "text", text: String(b.text ?? "") };
  if (b.type === "thinking") return thinkingBlockToPart(b);
  if (b.type === "tool_use") {
    return {
      type: "tool_use",
      id: String(b.id),
      name: String(b.name),
      input: (b.input as Record<string, unknown>) ?? {},
    };
  }
  if (b.type === "tool_result") {
    const tr: LlmToolResultPart = {
      type: "tool_result",
      toolUseId: String(b.tool_use_id),
      content: typeof b.content === "string" ? b.content : JSON.stringify(b.content),
      isError: b.is_error === true,
    };
    return tr;
  }
  return undefined;
}

/** Map one record to an LlmMessage; `undefined` for non-conversational (system) records. */
function recordToMessage(rec: SessionRecord): LlmMessage | undefined {
  if (rec.type !== "user" && rec.type !== "assistant") return undefined;
  const blocks = rec.message?.content ?? [];
  const parts = blocks.map(blockToPart).filter((p): p is LlmContentPart => p !== undefined);
  return { role: rec.type, content: parts };
}

/** The most-recent leaf: the LAST record (in input order) whose uuid is never used as a parentUuid. */
function findLatestLeaf(
  records: readonly SessionRecord[],
  byUuid: Map<string, SessionRecord>,
  parents: Set<string>,
): SessionRecord | undefined {
  let leaf: SessionRecord | undefined;
  for (const r of records) {
    if (byUuid.get(r.uuid) === r && !parents.has(r.uuid)) leaf = r;
  }
  return leaf;
}

/** Walk parentUuid from a leaf to a root (cycle-safe), returning root→leaf order. */
function walkToRoot(leaf: SessionRecord, byUuid: Map<string, SessionRecord>): SessionRecord[] {
  const chain: SessionRecord[] = [];
  const seen = new Set<string>();
  let cur: SessionRecord | undefined = leaf;
  while (cur !== undefined && !seen.has(cur.uuid)) {
    seen.add(cur.uuid);
    chain.push(cur);
    cur = cur.parentUuid !== null ? byUuid.get(cur.parentUuid) : undefined;
  }
  return chain.reverse();
}

/**
 * Rebuild the resumable `LlmMessage[]` from transcript records: dedup → find the most-recent leaf →
 * walk `parentUuid` to a root (a `compact_boundary` root terminates the walk) → map to LlmMessages.
 * Returns them in root→leaf (chronological replay) order.
 */
export function reconstructMessages(records: readonly SessionRecord[]): LlmMessage[] {
  const byUuid = dedupByUuid(records);
  const parents = new Set<string>();
  for (const r of byUuid.values()) if (r.parentUuid) parents.add(r.parentUuid);
  const leaf = findLatestLeaf(records, byUuid, parents);
  if (leaf === undefined) return [];

  const msgs: LlmMessage[] = [];
  for (const rec of walkToRoot(leaf, byUuid)) {
    const m = recordToMessage(rec);
    if (m !== undefined) msgs.push(m);
  }
  return msgs;
}

// ─── File I/O (the on-disk Claude layout) ─────────────────────────────────────────────────────────

/**
 * Root of the transcript state.
 *
 * `THEOKIT_HOME` wins; the fallback is `~/.theokit`. Home-anchored on purpose, and NOT
 * `paths.ts`'s `getTheokitHome(cwd)`: that one falls back to `<cwd>/.theokit`, and switching
 * by it would move the transcript of everyone who does **not** set the variable. The sibling with the
 * right shape is `catalog-source-models-dev.ts` (M94 ADR-2).
 *
 * Before M94 this function ignored the env var, so whoever set it had their state split in
 * two silently — sessions stayed in `~/.theokit` while the rest of the SDK migrated.
 */
export function transcriptRoot(): string {
  const override = process.env.THEOKIT_HOME?.trim();
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), ".theokit");
}

/** @deprecated Use {@link transcriptRoot}. Kept as an alias — same value. */
export function defaultBaseDir(): string {
  return transcriptRoot();
}

/**
 * Expand a leading `~` / `~/` to the user's home dir. `node:path` does NOT expand `~`, so a
 * `baseDir: "~/.claude"` (the documented Claude Code CLI interop path) would otherwise resolve to a
 * literal `./~/.claude` under cwd and the CLI would never find the session. Absolute or relative
 * paths without a leading tilde pass through untouched.
 */
export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * The fixed namespace for deriving a session UUID from an agent id (RFC 9562 § 5.8, version 8).
 *
 * A constant, because the derivation must be STABLE FOREVER: it is what lets the SDK find the
 * session it wrote last week without storing an id-to-filename map anywhere. Changing this value
 * orphans every transcript ever written.
 */
const SESSION_NAMESPACE = Buffer.from("b7a1f0c94e3d4a1b8f26d05c3a91e7d2", "hex");

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Is this id already a canonical UUID, and therefore usable as a filename verbatim? */
export function isSessionUuid(id: string): boolean {
  return UUID_SHAPE.test(id);
}

/**
 * The transcript filename for an agent id — always a UUID.
 *
 * #400: the Claude Code CLI resumes a transcript ONLY when its basename is a UUID. Measured against
 * CLI 2.1.236: `<uuid>.jsonl` resumes; `agent-<uuid>.jsonl` and `billing-bot.jsonl` are both ignored,
 * with no error — the session simply is not offered. So a session written under a human-readable
 * agent id was invisible to `claude --continue`, which is the interoperability this project claims
 * as its difference from a proprietary session store.
 *
 * An id that is ALREADY a UUID passes through verbatim, so a transcript Claude Code wrote keeps its
 * own name and the two directions stay symmetric. Anything else is derived with a UUIDv8, which is
 * deterministic: the same agent id always yields the same filename, so nothing has to be persisted
 * to map one back to the other.
 *
 * A DERIVED name is version 8 — RFC 9562's slot for a UUID whose bits come from an
 * implementation-defined scheme, which is exactly what this is. The obvious alternative was v5, but
 * RFC 4122 fixes v5's hash to SHA-1, and reaching for SHA-1 in 2026 means either shipping a weak
 * primitive or arguing with every scanner that flags it, forever. v8 lets the hash be SHA-256 and
 * lets the version nibble say honestly that this is our scheme rather than a standard one.
 *
 * There is no security claim here either way — no secret, no signature, and nothing an attacker
 * gains by colliding two agent ids inside one consumer's own directory. The hash is a naming
 * function. The point of preferring SHA-256 is not that SHA-1 was exploitable here; it is that a
 * weak primitive in the tree costs a permanent argument with every scanner that sees it.
 *
 * The version nibble was measured, not assumed: CLI 2.1.236 resumes a v8-named transcript exactly as
 * it does a v4 one.
 */
export function sessionUuidFor(id: string): string {
  if (isSessionUuid(id)) return id.toLowerCase();
  const hash = createHash("sha256")
    .update(Buffer.concat([SESSION_NAMESPACE, Buffer.from(id, "utf8")]))
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x80; // version 8 — RFC 9562 custom
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80; // RFC 9562 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The `.jsonl` path for a session: `<baseDir>/projects/<encoded-cwd>/<session-uuid>.jsonl`. */
export function transcriptPath(baseDir: string, cwd: string, sessionId: string): string {
  return join(baseDir, "projects", encodeProjectDir(cwd), `${sessionUuidFor(sessionId)}.jsonl`);
}

/**
 * The path this session used BEFORE #400 made transcript filenames UUIDs.
 *
 * Kept so an existing transcript is never orphaned: {@link FsSessionStore} prefers this file when it
 * exists, so history written under the old scheme keeps accumulating in the same file instead of
 * being silently abandoned for a fresh one under the new name.
 */
export function legacyTranscriptPath(baseDir: string, cwd: string, sessionId: string): string {
  return join(baseDir, "projects", encodeProjectDir(cwd), `${safeSessionId(sessionId)}.jsonl`);
}

/** Write records as one JSONL line each (atomic; parent dir created). Returns the path. */
export async function writeTranscript(
  path: string,
  records: readonly SessionRecord[],
): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  const body = records.map((r) => JSON.stringify(r)).join("\n");
  await replaceFileAtomic(path, records.length > 0 ? `${body}\n` : "");
  return path;
}

/** Parse one JSONL line to a record; `undefined` for blank/torn/invalid lines (skipped on read). */
function parseRecordLine(line: string): SessionRecord | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const rec = JSON.parse(trimmed) as SessionRecord;
    return typeof rec.uuid === "string" && typeof rec.type === "string" ? rec : undefined;
  } catch {
    return undefined; // a torn last line (crash mid-write) — the rest of the DAG still reconstructs
  }
}

/** Parse a transcript `.jsonl` into records; a missing file yields `[]`; malformed lines are skipped. */
export async function readTranscript(path: string): Promise<SessionRecord[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    // An absent file is an empty transcript — a first turn has none, so this is the common case.
    if (code === "ENOENT") return [];
    // And so is a runtime with no filesystem. The only call inside this `try` is `readFile`, and a
    // real filesystem failure ALWAYS carries a code: ENOENT, EACCES, EISDIR, EMFILE. An error with
    // no code did not come from a filesystem; it came from the absence of one — `unenv`'s
    // `createNotImplementedError` returns a plain `new Error(…)`, so there is nothing else to key on
    // and no message to match without depending on another package's wording.
    //
    // Measured 2026-09-28: every turn on Cloudflare Workers failed during `LocalAgent.initialize`,
    // because `hydrateSession` reached for a transcript the platform has no way to hold. Before the
    // model, before a token, on a session that never existed.
    //
    // NOT a bare `catch { return [] }`, which would report EACCES on a real transcript as an empty
    // history — a permissions problem read as "no messages", which is the silent-corruption shape
    // `error-handling.md` refuses. A test pins EACCES, EISDIR and EMFILE still throwing.
    if (code === undefined) {
      diag(
        `[theokit-sdk] no filesystem for the session transcript, continuing with an empty one: ${
          cause instanceof Error ? cause.message : String(cause)
        }\n`,
      );
      return [];
    }
    throw cause;
  }
  return raw
    .split("\n")
    .map(parseRecordLine)
    .filter((r): r is SessionRecord => r !== undefined);
}
