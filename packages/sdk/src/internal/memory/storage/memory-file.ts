/**
 * One memory as a file, in the shape the Claude Code CLI reads.
 *
 * `@theokit/sdk` already writes native Claude Code `.jsonl` sessions — the README's differentiator
 * is "point `local.sessionDir` at `~/.claude` and the Claude Code CLI can `--continue` a session
 * your agent wrote". Memory had no such convergence: a fact was a bullet under `## Facts` with its
 * kind in an HTML comment (#389), which that CLI reads as prose. Pointing a memory directory at
 * `~/.claude/projects/<project>/memory/` produced nothing it could open.
 *
 * The contract here was measured against a real store rather than inferred from documentation. Of
 * nine files, all nine carry `name`, `description` and `metadata.type`; six also carry
 * `node_type`, `originSessionId` and `modified`, which the runtime stamps on write. So the minimum
 * a reader must accept is the first three — refusing the rest would refuse memories the CLI itself
 * accepts.
 *
 * `originSessionId` is deliberately not written. It identifies the session that learned the fact,
 * and the append path has no session in scope; inventing one would be worse than omitting a field
 * the format already treats as optional.
 *
 * @internal
 */

import { parseSimpleYaml, splitFrontmatter } from "../../runtime/context/context-yaml-lite.js";
import { safeFilenameForId } from "../../security/path-guard.js";
import { MEMORY_KINDS, type MemoryKind } from "../types.js";

/** The fields one memory file carries. */
export interface MemoryFileFields {
  /** Slug, and the file's basename. */
  readonly name: string;
  /** One-line summary — what the index shows and what recall ranks. */
  readonly description: string;
  /** `metadata.type`, absent when the file does not declare one this contract admits. */
  readonly kind?: MemoryKind;
  /** `metadata.modified`, an ISO 8601 instant stamped by whoever wrote the file. */
  readonly modified?: string;
  /**
   * How many times this exact text has been recorded — the corroboration count SOP-06-01 needs.
   *
   * One observation may be a coincidence, a mistake, or a plant. Requiring a second INDEPENDENT
   * observation before an entry is treated as established is the cheapest defence against memory
   * poisoning that exists, and a live run showed its absence is not theoretical: a single planted
   * fact made the agent assert that the team's deploy convention was `--skip-tests`.
   *
   * Absent means one, so every file written before this field existed reads as uncorroborated
   * rather than as trusted — the safe direction for a field that gates confidence.
   */
  readonly observations?: number;
  /** The markdown after the frontmatter. */
  readonly body: string;
}

/** The safe filename grammar a slug must satisfy before it is used as one. */
const SAFE_SLUG = /^[a-z0-9][a-z0-9_-]*$/;
/** Long enough to stay readable, short enough to survive every filesystem's component limit. */
const MAX_SLUG_LENGTH = 64;
/**
 * Where a topic name stops growing. Measured, not chosen: names written by the interop partner
 * average 30.6 characters over 688 files (measured 2026-08), so a slug is built word by word and
 * stops once it reaches this — close to what that corpus does, without truncating mid-word.
 *
 * The date is part of the constant. These numbers describe what the partner writes TODAY; if its
 * style moves, they age silently and still read like measurements. Dating them makes that
 * checkable instead of assumed — the same failure this project already met in an ADR whose
 * factual premise quietly stopped being true.
 */
const TARGET_SLUG_LENGTH = 32;
/**
 * Index link titles, measured over the partner's 673 real index lines (2026-08): median 4 words
 * and 29 characters, p90 at 39. Both caps are applied because either alone admits the wrong shape — a
 * character budget lets five short words through, and a word budget lets four long ones run past
 * the column the index is read in.
 */
const TITLE_MAX_LENGTH = 40;
const TITLE_MAX_WORDS = 4;

/**
 * Function words carry no topic signal. Dropping them is what turns a sentence into a name.
 *
 * English only, and that is a project rule rather than a judgement: this codebase is English-only
 * by lint. A store whose entries are written in another language keeps that language's function
 * words in its names — longer and noisier, never wrong, and never lossy, because the collision
 * guard below is what protects the entry either way.
 */
const SLUG_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "for",
  "of",
  "to",
  "in",
  "on",
  "at",
  "by",
  "with",
  "from",
  "as",
  "that",
  "this",
  "these",
  "those",
  "it",
  "its",
  "he",
  "she",
  "they",
  "we",
  "you",
  "i",
  "do",
  "does",
  "did",
  "has",
  "have",
  "had",
  "will",
  "would",
  "can",
  "could",
  "should",
  "must",
  "not",
  "no",
  "over",
  "under",
  "into",
  "onto",
  "than",
  "then",
  "when",
  "where",
  "which",
  "who",
  "why",
  "how",
  "all",
  "any",
  "each",
  "more",
  "most",
  "other",
  "some",
  "such",
  "only",
  "own",
  "same",
  "so",
  "too",
  "very",
  "just",
  "also",
  "about",
  "after",
  "before",
  "between",
  "during",
  "up",
  "down",
  "out",
  "off",
  "again",
  "once",
  "here",
  "there",
  "if",
  "because",
  "while",
]);

/** Words a topic name is made of: 2+ chars and not a function word. */
function topicWords(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !SLUG_STOPWORDS.has(w));
}

/**
 * A short, readable, filesystem-safe TOPIC name for `text` — not the text itself.
 *
 * WHY THIS IS NOT THE SENTENCE. The interop partner this store shares its format with names
 * memories after their subject: measured over 688 real files, names average 30.6 characters and
 * read like `prefere-explicacao-visual` or `zsh-sem-word-splitting` — two to five content words.
 * This function used to lowercase the whole entry and cut it at 64 characters, which produced
 * `the-deploy-passphrase-for-the-atlas-cluster-is-sirius-sod521`.
 *
 * That example is not hypothetical and it is the reason this changed. A filename is the most
 * exposed part of an entry: it shows in directory listings, shell completion, tool logs and
 * stack traces, none of which require opening the file. Naming a memory after its subject rather
 * than its content keeps the payload out of the most-quoted field by construction, with no rule
 * about secrets anywhere — a rule would have to recognise the secret, and pattern matching
 * cannot recognise `sirius-sod521`.
 *
 * Readability remains the goal — a directory of `h-3f2a…` files is one nobody browses — but it is
 * not the floor: anything failing the safe grammar falls back to {@link safeFilenameForId}, which
 * is total.
 */
export function slugForFact(text: string): string {
  const words = topicWords(text);
  let slug = "";
  for (const w of words) {
    const next = slug.length === 0 ? w : `${slug}-${w}`;
    // Stop BEFORE exceeding, never after. Checking the length of what was just appended overshoots
    // by one word every time — which is how `…-atlas-cluster-sirius` kept a token that
    // `…-atlas-cluster` had already excluded. One word past a budget is the whole point of #446.
    if (next.length > TARGET_SLUG_LENGTH && slug.length > 0) break;
    if (next.length > MAX_SLUG_LENGTH) break;
    slug = next;
  }
  // A text made entirely of function words or symbols leaves nothing to name it after; fall back
  // to the old whole-text form rather than returning an empty component.
  if (slug.length === 0) {
    slug = text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_SLUG_LENGTH)
      .replace(/-+$/, "");
  }
  return SAFE_SLUG.test(slug) ? slug : safeFilenameForId(text);
}

/**
 * A short human-readable title for `text` — what the index shows in its link.
 *
 * The interop partner writes `- [Kernel batched AH JÁ EXISTE](slug.md) — <hook>`: a concept in
 * the link and the detail after the dash. A caller that knows the concept SHOULD pass its own
 * title; this is the fallback for the common path, where all the writer has is one sentence.
 *
 * It is deliberately mechanical. A derived title will not match an authored one, and pretending
 * otherwise would be the mistake this codebase already refuses one field over — so the honest
 * design is an explicit field with a derivation behind it, not a derivation dressed as authorship.
 */
export function titleForFact(text: string): string {
  const words = topicWords(text);
  if (words.length === 0) return text.trim().slice(0, TITLE_MAX_LENGTH);
  let title = "";
  let used = 0;
  for (const w of words) {
    if (used >= TITLE_MAX_WORDS) break;
    const next = title.length === 0 ? w : `${title} ${w}`;
    if (next.length > TITLE_MAX_LENGTH && title.length > 0) break;
    title = next;
    used += 1;
  }
  if (title.length === 0) title = words[0] as string;
  return title.charAt(0).toUpperCase() + title.slice(1);
}

/**
 * The optional metadata a memory file carries, with every value this contract does not admit
 * dropped rather than passed through.
 *
 * Extracted from `parseMemoryFile` rather than inlined: that function decides what counts as a
 * memory, which makes it a trust boundary, and this repo caps cognitive complexity at 10 for
 * exactly that kind of code. Three inline validations pushed it to 13.
 *
 * Everything here fails toward absence. An unknown `type` reads as untyped rather than as a fifth
 * kind; a non-integer count reads as uncorroborated. The file is hand-editable, so a value that
 * does not fit the contract must not be believed just because it is present.
 */
function readMetadata(raw: unknown): Pick<MemoryFileFields, "kind" | "modified" | "observations"> {
  const metadata = (raw ?? {}) as Record<string, unknown>;
  const rawKind = metadata.type;
  const kind =
    typeof rawKind === "string" && MEMORY_KINDS.includes(rawKind as MemoryKind)
      ? (rawKind as MemoryKind)
      : undefined;
  const modified = typeof metadata.modified === "string" ? metadata.modified : undefined;
  const observations = readObservationCount(metadata.observations);
  return {
    ...(kind !== undefined ? { kind } : {}),
    ...(modified !== undefined ? { modified } : {}),
    ...(observations !== undefined ? { observations } : {}),
  };
}

/**
 * The corroboration count a file claims, or `undefined` when it claims none this contract admits.
 *
 * Extracted rather than inlined: `parseMemoryFile` decides what counts as a memory, which makes it
 * a trust boundary, and this repo caps cognitive complexity at 10 for exactly that kind of code.
 * Inlining the validation pushed it to 13.
 *
 * Anything that is not a positive integer reads as absent — i.e. as a single, uncorroborated
 * observation. The file is hand-editable, so trusting an arbitrary value here would let a file
 * claim corroboration nobody gave it, which is the failure quarantine exists to prevent.
 */
function readObservationCount(raw: unknown): number | undefined {
  if (typeof raw !== "number") return undefined;
  if (!Number.isInteger(raw) || raw <= 0) return undefined;
  return raw;
}

/** Render one memory file. `description` is quoted so a colon in the text cannot break the block. */
export function renderMemoryFile(fields: MemoryFileFields): string {
  const metadata = ["  node_type: memory"];
  if (fields.kind !== undefined) metadata.push(`  type: ${fields.kind}`);
  if (fields.modified !== undefined) metadata.push(`  modified: ${fields.modified}`);
  // Written even when it is 1. Absent and 1 are DIFFERENT states: absent means the store does
  // not know how many times this was seen (written before this field existed, or by hand), 1
  // means the store counted and the answer is one. Collapsing them would erase the distinction
  // the marker depends on.
  if (fields.observations !== undefined) {
    metadata.push(`  observations: ${fields.observations}`);
  }
  return [
    "---",
    `name: ${fields.name}`,
    `description: ${JSON.stringify(fields.description)}`,
    "metadata:",
    ...metadata,
    "---",
    "",
    fields.body,
    "",
  ].join("\n");
}

/**
 * Read one memory file, or `undefined` when the content is not one.
 *
 * `undefined` rather than a throw, and rather than a best-effort object: the directory holds
 * hand-written notes and a `MEMORY.md` index alongside the memories, and turning any of those into
 * a fact would put text into recall that nobody recorded as one.
 */
export function parseMemoryFile(raw: string): MemoryFileFields | undefined {
  const { yaml, body } = splitFrontmatter(raw);
  if (yaml === undefined) return undefined;

  let fields: Record<string, unknown>;
  try {
    fields = parseSimpleYaml(yaml);
  } catch {
    return undefined; // malformed frontmatter is not a memory
  }

  const name = fields.name;
  const description = fields.description;
  if (typeof name !== "string" || typeof description !== "string") return undefined;

  return {
    name,
    description,
    ...readMetadata(fields.metadata),
    body: body.trim(),
  };
}
