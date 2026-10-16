import { migrateLegacyJson } from "../../memory/migration.js";
import { resolveMaxFacts } from "../../memory/storage/fact-ceiling.js";
import {
  appendFact as appendFactMd,
  readFacts as readFactsMd,
} from "../../memory/storage/markdown-store.js";
import {
  MEMORY_KINDS,
  type MemoryConfig,
  type MemoryFact,
  type MemoryKind,
  redactSecrets,
} from "../../memory/types.js";

/**
 * Workspace-level memory store. Storage migrated from JSON-array to
 * markdown-first per memory-system-peer-project-parity-plan ADR D1: facts live in
 * `.theokit/memory/MEMORY.md` under a `## Facts` section. On first read the
 * legacy JSON file is migrated and deleted (ADR D8).
 *
 * Public surface (`readMemoryFacts` + `appendMemoryFact`) is unchanged.
 *
 * @internal
 */

export type { MemoryConfig, MemoryFact };
export { redactSecrets };

const REMEMBER_PATTERN =
  /^\s*Remember(?:\s+this\s+durable\s+preference)?\s*(?:\((user|feedback|project|reference)\))?\s*:\s*(.+)$/i;

/**
 * Predicate: does the user message opt into memory persistence via the
 * `Remember:` prefix? Anchored at start-of-message; case-insensitive.
 *
 * Shared by the fixture runtime and the real LLM runtime so both paths
 * agree on which user messages persist a fact.
 *
 * @internal
 */
export function isMemoryWritePrompt(message: string): boolean {
  return REMEMBER_PATTERN.test(message) || message.includes("Remember this durable");
}

/**
 * Extract the fact text from a user message that matched
 * {@link isMemoryWritePrompt}. Strips the leading "Remember:" prefix and
 * a trailing period. Returns an empty string when the capture group is
 * empty — callers must check for that and skip the persistence call.
 *
 * @internal
 */
export function extractMemoryFact(message: string): string {
  const match = REMEMBER_PATTERN.exec(message);
  if (match === null || match[2] === undefined) return "";
  return match[2].trim().replace(/\.$/, "");
}

/**
 * Matches a message that OPENS with the capture verb, past an optional politeness prefix.
 *
 * The prefix is admitted because `Please remember: …` is one of the reported near-misses and reads
 * as correct to the person typing it. It is a CLOSED list rather than "any words before the verb":
 * "I will remember to check that later" is an ordinary sentence, and a warning that fired on it
 * would be a warning somebody turns off.
 */
const LOOKS_LIKE_A_CAPTURE = /^\s*(?:please\s+|can\s+you\s+|could\s+you\s+)?remember\b/i;

/** Enough of the turn to recognise it in a log line, without pasting the whole message into one. */
const QUOTED_MESSAGE_MAX = 120;

/**
 * What to say about a `Remember` phrase that stored nothing, or `undefined` when there is nothing
 * true to say (#462).
 *
 * The gate itself is right: a heuristic over user text must not capture aggressively, and widening
 * it until every phrasing lands would make an ordinary sentence about remembering into a durable
 * fact. What was missing is the SIGNAL. `persistMemoryFactIfWritePrompt` had three early returns
 * and a diagnostic on none of them, so a phrase one token from the supported one — `Remember,
 * please:`, `Remember that:` — answered normally and stored nothing, and the caller could only find
 * out by listing the store.
 *
 * The transcript indexer is what made it expensive. The sentence still lands in `sessions/run-*.md`
 * and is indexed, so a follow-up question comes back with the right answer and the developer
 * concludes memory is on. What they have is full-text search over transcripts: no `MEMORY.md`,
 * nothing to commit, nothing a human can edit, nothing that survives transcript pruning.
 *
 * **The supported forms are interpolated from {@link MEMORY_KINDS}, never spelled out.** The
 * reported defect IS the accepted vocabulary changing between 4.56.0 and 4.57.0 with nothing
 * announcing it; a hand-written list here would be a second place for that vocabulary to live and
 * could go stale exactly the same way, one layer up from the bug it explains.
 *
 * Returns a string rather than emitting one, in the shape {@link indexBudgetWarning} established:
 * the caller decides where it goes, and a pure function is testable without a captured stderr.
 *
 * @internal
 */
export function unstoredRememberWarning(message: string): string | undefined {
  if (!LOOKS_LIKE_A_CAPTURE.test(message)) return undefined;
  // A supported phrase that yields a fact is the success path and says nothing. The two failures
  // reach here for different reasons — an unrecognised form, or a recognised one with nothing after
  // the colon — and the reader needs the same three things in both cases.
  if (isMemoryWritePrompt(message) && extractMemoryFact(message).length > 0) return undefined;
  const trimmed = message.trim();
  const quoted =
    trimmed.length > QUOTED_MESSAGE_MAX ? `${trimmed.slice(0, QUOTED_MESSAGE_MAX)}…` : trimmed;
  return (
    `[theokit-sdk] NOTHING WAS STORED — this message does not match the memory capture pattern: ` +
    `${JSON.stringify(quoted)}. Supported: "Remember: <fact>" or ` +
    `"Remember (${MEMORY_KINDS.join("|")}): <fact>". It still reaches the session transcript, so a ` +
    `follow-up may answer from it — that is search over transcripts, not a durable memory.`
  );
}

/**
 * The kind a `Remember:` prompt declared, if it declared one (#401).
 *
 * `Remember (feedback): prefer tabs` types the fact; a bare `Remember:` leaves it untyped, which is
 * the honest default — a kind nobody stated is a kind nobody knows, and guessing it would make the
 * store confident about the wrong thing.
 *
 * ONLY the four kinds the store accepts are recognised as a kind. Any other parenthetical is not a
 * mistyped kind to punish but ordinary prose, and it keeps the pre-existing behaviour of the prompt
 * unchanged rather than being reinterpreted here.
 *
 * @internal
 */
export function extractMemoryKind(message: string): MemoryKind | undefined {
  const match = REMEMBER_PATTERN.exec(message);
  const declared = match?.[1];
  if (declared === undefined) return undefined;
  const lowered = declared.toLowerCase() as MemoryKind;
  return MEMORY_KINDS.includes(lowered) ? lowered : undefined;
}

export async function readMemoryFacts(cwd: string, config: MemoryConfig): Promise<MemoryFact[]> {
  if (!config.enabled) return [];
  await migrateLegacyJson(cwd, config);
  return readFactsMd(cwd, config);
}

export async function appendMemoryFact(
  cwd: string,
  config: MemoryConfig,
  fact: MemoryFact,
): Promise<void> {
  if (!config.enabled) return;
  // Before the migration, which can move a legacy JSON store on disk: an invalid ceiling is
  // refused while nothing has been touched (B-380). The writer validates it again, for its other
  // callers; this call is about ordering, not a second rule.
  resolveMaxFacts(config.maxFacts);
  await migrateLegacyJson(cwd, config);
  // #401 — this used to be `{ text: ... }` only, so a kind never reached storage even when a caller
  // supplied one: the field round-tripped through the file format and was severed at the one
  // chokepoint every write passes through. `modified` is deliberately NOT carried over — the SDK
  // stamps it, because a timestamp the caller controls can lie about when something was learned.
  const sanitized: MemoryFact = {
    text: redactSecrets(fact.text),
    ...(fact.kind === undefined ? {} : { kind: fact.kind }),
  };
  await appendFactMd(cwd, config, sanitized);
}
