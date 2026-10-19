import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { ConfigurationError } from "../../../errors.js";
import { diag } from "../../diagnostics.js";
import { replaceFileAtomic } from "../../persistence/atomic-write.js";
import { withCwdMutex } from "../../persistence/cwd-mutex.js";
import { type FileLockOptions, withFileLock } from "../../persistence/file-lock.js";
import { safeFilenameForId } from "../../security/path-guard.js";
import { MEMORY_KINDS, type MemoryConfig, type MemoryFact, redactSecrets } from "../types.js";
import { ceilingReachedError, resolveMaxFacts } from "./fact-ceiling.js";
import { parseMemoryFile, renderMemoryFile, slugForFact, titleForFact } from "./memory-file.js";
import {
  indexBudgetWarning,
  type MemoryLocationConfig,
  type MemoryRoot,
  memoryReadRoots,
  projectMemoryDir,
  resolveMemoryRoot,
} from "./memory-root.js";
import { scanForThreats } from "./threat-scan.js";

/*
 * Markdown-first memory storage (ADR D1 of memory-system-peer-project-parity).
 *
 * Layout, converged with the one the Claude Code CLI reads:
 *   <memoryDir>/
 *   ├── MEMORY.md          # INDEX — one `- [text](slug.md)` line per memory
 *   ├── <slug>.md          # one memory, frontmatter carrying `metadata.type` + `modified`
 *   └── notes/
 *       └── <slug>.md      # hand-written per-topic notes (read by the indexer, never written here)
 *
 * The SDK already emits native Claude Code `.jsonl` sessions, so a consumer can point
 * `local.sessionDir` at `~/.claude` and `--continue` a session its agent wrote. Memory did not hold
 * that line: a fact was a bullet under `## Facts` with its kind in an HTML comment (#389), which
 * that CLI reads as prose. Pointing a memory directory at `~/.claude/projects/<project>/memory/`
 * produced nothing it could open.
 *
 * `## Facts` bullets are still READ. They are already on disk in consumers' repositories, and a
 * format change that stopped reading them would delete what someone recorded — worse than the
 * format it replaces.
 *
 * All writes go through `replaceFileAtomic` + a per-cwd mutex (EC-4 of the
 * edge-case review) so concurrent `appendFact` calls within the same process
 * serialize. Multi-process safety is NOT provided.
 *
 * Module header, not a JSDoc block: it describes the file, and a JSDoc comment attaching to
 * nothing ships the symbol below undocumented and this text invisible.
 */

/**
 * The index header the interop partner writes. Measured over its real stores rather than chosen:
 * `# Memory Index`, and nothing else. The previous header said "# Memory" plus a line announcing
 * which tool manages the file — accurate, and a divergence in the one file both tools append to.
 */
const MEMORY_MD_HEADER = "# Memory Index\n";
const FACTS_HEADING = "## Facts";
/** How many `topic-N` variants to try before falling back to a name derived from the whole text. */
const MAX_NAME_VARIANTS = 50;

/**
 * Path to `MEMORY.md`, the index that points at the per-memory files — and, in stores written before
 * #389, the flat `## Facts` list itself. Pure path computation; the file may not exist.
 *
 * Takes the RESOLVED ROOT, not a `cwd`. Every path helper here does, so a caller that has not asked
 * {@link resolveMemoryRoot} where memory lives does not compile — see `memory-root.ts` for the
 * defect that made that the requirement (#463).
 */
export function memoryMdPath(root: MemoryRoot): string {
  return join(root, "MEMORY.md");
}

/**
 * Path to `<memory root>/notes`, where per-topic notes and the consolidated notes a dreaming sweep
 * writes live. Pure path computation — the directory may not exist.
 */
export function notesDir(root: MemoryRoot): string {
  return join(root, "notes");
}

/**
 * Filenames in the order they were written, as far as a name can say.
 *
 * Plain string order gets disambiguated names backwards: `-` sorts before `.`, so `topic-2.md`
 * would precede `topic.md`. Comparing the base first and the variant number second restores it.
 *
 * This is the TIE-BREAK, not the ordering. Entries are read in this order and then stable-sorted
 * by `modified`, so the recorded time decides and equal timestamps fall back here. Timestamps do
 * collide: three appends in one test land within nine milliseconds, and a faster disk closes that
 * gap entirely.
 */
function byNaturalName(a: string, b: string): number {
  const split = (f: string): [string, number] => {
    const stem = f.replace(/\.md$/, "");
    const m = /^(.*?)-(\d+)$/.exec(stem);
    return m === null ? [stem, 0] : [m[1] as string, Number(m[2])];
  };
  const [baseA, nA] = split(a);
  const [baseB, nB] = split(b);
  return baseA === baseB ? nA - nB : baseA.localeCompare(baseB);
}

/**
 * Every memory in the store: the per-memory files, plus any legacy `## Facts` bullets still in
 * `MEMORY.md`. Returns `[]` when the directory does not exist.
 *
 * Reading both is not transitional politeness. Those bullets are already on disk in consumers'
 * repositories, and the store's own header invites editing them by hand — a converged writer that
 * stopped reading them would delete what someone recorded, which is worse than the format it fixes.
 */
export async function readFactsFromMarkdown(
  cwd: string,
  config?: MemoryLocationConfig,
): Promise<MemoryFact[]> {
  const facts: MemoryFact[] = [];
  // READ ALL — the configured root, the project store, and the one the Claude Code CLI keeps for
  // this project. The format has been shared since #389; only the directory was not, so a memory
  // the CLI recorded was invisible to an agent working in the same repository. `memoryReadRoots`
  // owns the list and the deduplication; see `memory-root.ts` for why the write is a single root
  // while the read is all of them.
  const roots = memoryReadRoots(cwd, config);
  for (const dir of roots) facts.push(...(await readMemoryFilesIn(dir)));
  // Legacy `## Facts` bullets, in EVERY root rather than only the project store's index. A store
  // that moved carries its own index, and reading one of them would have dropped the other's
  // bullets — the same half-read this change exists to remove.
  for (const dir of roots) facts.push(...(await readLegacyFactsSectionIn(dir)));
  return facts;
}

/**
 * The per-memory files in one directory, in the order they were recorded.
 *
 * Read order is chronological, not alphabetical. Filename order used to approximate insertion order
 * because a name WAS the entry; once colliding names get a `-2` suffix that stops being true —
 * `fact-2.md` sorts before `fact.md` — and three appends came back as B, C, A. The store already
 * stamps `modified` on every write, so the order is recorded; it just was not being read.
 *
 * Undated entries keep their filename order and come first. They carry no time signal, and
 * inventing one for them is the inference this codebase refuses one field over.
 */
async function readMemoryFilesIn(dir: string): Promise<MemoryFact[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const facts: MemoryFact[] = [];
  for (const entry of entries.sort(byNaturalName)) {
    const fact = await readMemoryFileIn(dir, entry);
    if (fact !== undefined) facts.push(fact);
  }
  // Stable: equal timestamps keep the natural-name order the read used.
  facts.sort((a, b) => (a.modified ?? "").localeCompare(b.modified ?? ""));
  return facts;
}

/** The pre-#389 `## Facts` bullets in one root's index, or `[]` when there is no index there. */
async function readLegacyFactsSectionIn(dir: string): Promise<MemoryFact[]> {
  try {
    return parseFactsSection(await readFile(join(dir, "MEMORY.md"), "utf8"));
  } catch {
    return []; // no index in this root — the per-memory files are the whole store here
  }
}

/**
 * How many facts one directory holds, counted the way the readers above count them: entries that
 * parse as a memory file, plus the legacy `## Facts` bullets of its `MEMORY.md`.
 *
 * STRICT where those readers are lenient. They turn every read error into "no fact", which is right
 * for recall and wrong for an admission count: an `EACCES` on one file would undercount the store
 * and admit the write its ceiling exists to refuse. Only absence is read as zero: no directory is
 * an empty store, no `MEMORY.md` is a store with no legacy bullets.
 */
async function countFactsIn(dir: string): Promise<number> {
  const entries = (await unlessMissing(readdir(dir))) ?? [];
  let count = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".md") || entry === "MEMORY.md") continue;
    // A file that vanished after `readdir` (another process, a hand edit) is absence, not an error.
    const raw = await unlessMissing(readFile(join(dir, entry), "utf8"));
    if (raw !== undefined && parseMemoryFile(raw) !== undefined) count += 1;
  }
  const index = await unlessMissing(readFile(join(dir, "MEMORY.md"), "utf8"));
  return index === undefined ? count : count + parseFactsSection(index).length;
}

/**
 * The read's value, or `undefined` when there is nothing there to read: the path does not exist,
 * or it is a directory (a `*.md` directory is not a fact either). Every other error is rethrown.
 */
async function unlessMissing<T>(read: Promise<T>): Promise<T | undefined> {
  try {
    return await read;
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "EISDIR") return undefined;
    throw cause;
  }
}

/**
 * Refuse a NEW fact once the directory holds `maxFacts` or more. With no ceiling nothing is counted,
 * so the default path does no extra I/O. Only a second observation of a stored fact
 * (`observations > 1`) is exempt; a name that merely exists, such as a hand-written note
 * `resolveName` hands back, is a new fact. `>=`, not `===`: a store already above its ceiling (a
 * lowered ceiling, a legacy migration) refuses too, and says its real count.
 */
async function assertRoomForNewFact(
  dir: string,
  maxFacts: number | undefined,
  observations: number,
): Promise<void> {
  if (maxFacts === undefined || observations > 1) return;
  const count = await countFactsIn(dir);
  if (count >= maxFacts) throw ceilingReachedError(dir, count, maxFacts, markdownRemedy(dir));
}

/** How the markdown store tells a caller to make room under its ceiling. */
function markdownRemedy(dir: string): string {
  return `merge or delete fact files in ${dir}, or raise memory.maxFacts`;
}

/**
 * One directory entry as a fact, or `undefined` when it is not one.
 *
 * `MEMORY.md` is the index, not a memory; a non-markdown entry is not a memory; and a markdown file
 * without the frontmatter is a note somebody wrote by hand. Turning any of those into a fact would
 * put text into recall that nobody recorded as one.
 *
 * The DIRECTORY is a parameter rather than derived from `cwd`, because both stores — this SDK's and
 * the one the Claude Code CLI keeps for the same project — read entries the same way, and a second
 * copy of this function is a second place for those three rules to drift.
 */
async function readMemoryFileIn(dir: string, entry: string): Promise<MemoryFact | undefined> {
  if (!entry.endsWith(".md") || entry === "MEMORY.md") return undefined;
  let raw: string;
  try {
    raw = await readFile(join(dir, entry), "utf8");
  } catch {
    return undefined; // vanished between readdir and read
  }
  const parsed = parseMemoryFile(raw);
  if (parsed === undefined) return undefined;
  // The BODY is the memory; `description` is the one-line recall aid. This SDK writes both the same,
  // so nothing it wrote changes — but the Claude Code CLI writes a summary in `description` and the
  // substance below it, and reading only the summary silently dropped the fact itself.
  const body = parsed.body.trim();
  return {
    text: body.length > 0 ? body : parsed.description,
    ...(parsed.kind !== undefined ? { kind: parsed.kind } : {}),
    ...(parsed.modified !== undefined ? { modified: parsed.modified } : {}),
    ...(parsed.observations !== undefined ? { observations: parsed.observations } : {}),
  };
}

/**
 * The two boundary refusals a write must survive, kept together and out of the writer.
 *
 * Both refuse rather than repair, for the same reason: a kind outside the four and a malformed
 * entry would both be written to a file that recall later trusts.
 */
function assertWritable(fact: MemoryFact, text: string): void {
  if (fact.kind !== undefined && !MEMORY_KINDS.includes(fact.kind)) {
    throw new ConfigurationError(
      `Unknown memory fact kind "${fact.kind}". Expected one of: ${MEMORY_KINDS.join(", ")}.`,
      { code: "invalid_memory_kind" },
    );
  }
  // Scan AFTER redaction and BEFORE persistence (SOP-06-05 step 1). After, so a redacted
  // secret cannot look like an encoded payload; before, because an entry that reaches disk is
  // recalled in every session afterwards.
  //
  // What this closes, stated so nobody cites it for more: the MALFORMED-ENTRY class,
  // completely — injection framing, role reassignment, invisible characters, encoded blobs.
  // It closes NONE of the class that was actually measured end to end. Both planted entries
  // from that run pass this scanner, the executive one included, and `threat-scan.ts` pins
  // that in tests rather than in a comment. Execution is answered at the tool boundary by the
  // permission engine; this is not a second line of defence for it.
  const threat = scanForThreats(text);
  if (threat !== undefined) {
    throw new ConfigurationError(
      `Refusing to write a memory entry that ${threat.why}: ${threat.excerpt}`,
      { code: "memory_threat_rejected" },
    );
  }
  // Name the memory after its SUBJECT, and let the caller override. The interop partner names
  // files this way, and it is also what keeps a payload out of the most-exposed field (#446).
}

/**
 * Write a fact as its own memory file and point the `MEMORY.md` index at it. Atomic + serialized.
 *
 * `modified` is stamped HERE and never read from `fact`: a timestamp a caller can set is a
 * timestamp that can lie about when something was learned, and weighing recency is the point.
 */
export function appendFactToMarkdown(
  cwd: string,
  fact: MemoryFact,
  targetDir: string = projectMemoryDir(cwd),
  options: { maxFacts?: number } = {},
): Promise<void> {
  return withCwdMutex(targetDir, async () => {
    const text = redactSecrets(fact.text);
    assertWritable(fact, text);
    const maxFacts = resolveMaxFacts(options.maxFacts);
    if (maxFacts === undefined) return writeFactFile(targetDir, fact, text, undefined);
    return withCeilingLock(targetDir, () => writeFactFile(targetDir, fact, text, maxFacts));
  });
}

/**
 * Retries for the ceiling's cross-process lock: about 11 s of waiting in all (100 to 5000 ms per
 * attempt). A holder only counts and writes, so that is many critical sections. It is shorter
 * than the 30 s `stale` window, so a lock left by a process that crashed fails ceilinged writes
 * with `ELOCKED` until it goes stale, rather than being waited out.
 */
const CEILING_LOCK: FileLockOptions = { retries: 10 };

/**
 * Run `fn` holding a lock that other SDK processes writing `targetDir` with a ceiling also take
 * (B-380, LCR0111). The outer `withCwdMutex` orders writers inside this process; the count and the
 * write must also be one critical section across processes, or two processes one fact below the
 * ceiling both pass it. Only writers that declare a ceiling take it: a writer without one, and the
 * Claude Code CLI, never count, so they never needed to wait.
 *
 * The companion lock is `<targetDir>.lock`, BESIDE the memory directory: inside it, the lock
 * would need the directory to exist before the ceiling check, and a refusal must create nothing
 * there. That makes the parent the one directory this creates on a refusal; when `targetDir` is
 * the CLI's `~/.claude/projects/<project>/memory`, the parent and the short-lived `memory.lock`
 * sit in the CLI's tree, which is accepted because the lock is removed on release.
 */
async function withCeilingLock(targetDir: string, fn: () => Promise<void>): Promise<void> {
  const lockTarget = resolve(targetDir);
  await mkdir(dirname(lockTarget), { recursive: true });
  return withFileLock(lockTarget, fn, CEILING_LOCK);
}

/** The write itself: name, ceiling check, fact file, index. Callers hold the locks it needs. */
async function writeFactFile(
  targetDir: string,
  fact: MemoryFact,
  text: string,
  maxFacts: number | undefined,
): Promise<void> {
  const title = fact.title?.trim() ?? titleForFact(text);
  const base = fact.title !== undefined ? slugForFact(fact.title) : slugForFact(text);
  const name = await resolveName(targetDir, base, text);
  const observations = await nextObservationCount(targetDir, name, text);
  // Under the ceiling lock, so the count and the write are one critical section: two writes at
  // one below the ceiling cannot both pass, in one process or across several.
  await assertRoomForNewFact(targetDir, maxFacts, observations);
  // After the ceiling check, so a refusal creates no directory either.
  await mkdir(targetDir, { recursive: true });
  const description = fact.description?.trim() ?? text;
  await replaceFileAtomic(
    join(targetDir, `${name}.md`),
    renderMemoryFile({
      name,
      description,
      ...(fact.kind !== undefined ? { kind: fact.kind } : {}),
      modified: new Date().toISOString(),
      observations,
      body: text,
    }),
  );
  // The index lives BESIDE the files it lists. A `MEMORY.md` in one directory pointing at
  // memories in another names files that are not there — and the CLI reads that index.
  const index = await nextIndex(targetDir, description, name, title);
  await replaceFileAtomic(join(targetDir, "MEMORY.md"), index);
  // AFTER the write, never instead of it. The fact file and the index are one atomic operation,
  // so refusing the second would lose the first — and the thing being reported is a limit the
  // interop partner applies when reading, not a failure of this write.
  const warning = indexBudgetWarning(index, targetDir);
  if (warning !== undefined) diag(`[theokit-sdk] ${warning}\n`);
}

/**
 * The filename this text should occupy: the topic name, or the first free variant of it.
 *
 * A topic slug is a LOSSY summary, and lossy summaries collide. `fact A`, `fact B` and `fact C`
 * all reduce to `fact`; before this guard existed they reduced to the same FILE, and the third
 * write silently destroyed the first two. Naming memories after their subject is right, and it
 * makes collisions ordinary rather than rare — so the guard is not optional, it is the other half
 * of the change.
 *
 * Same text on the same name is NOT a collision: it is the second observation of one fact, and
 * returning the same name is what lets the corroboration count increment. Only DIFFERENT text
 * moves aside.
 *
 * Losing a memory is the worst outcome this store has. Between overwriting a distinct entry and
 * writing `topic-2.md`, the ugly name wins every time.
 */
async function resolveName(dir: string, base: string, text: string): Promise<string> {
  const wanted = normalizeFactText(text);
  for (let i = 1; i <= MAX_NAME_VARIANTS; i += 1) {
    const candidate = i === 1 ? base : `${base}-${i}`;
    let existing: string;
    try {
      existing = await readFile(join(dir, `${candidate}.md`), "utf8");
    } catch {
      return candidate; // free
    }
    const parsed = parseMemoryFile(existing);
    if (parsed === undefined) return candidate; // not a memory; the writer owns the name
    if (normalizeFactText(parsed.body) === wanted) return candidate; // same fact — corroborate
  }
  // Every variant taken by a different fact. Fall back to a name derived from the whole text,
  // which is unique where the topic name is not.
  return slugForFact(text) === base ? safeFilenameForId(text) : slugForFact(text);
}

/**
 * The corroboration count for the write about to happen.
 *
 * The rule that makes this a defence rather than a counter: **only the SAME text corroborates
 * itself.** Recording an identical fact a second time is a second observation; recording
 * different text under the same file is a REWRITE, and it starts again at one.
 *
 * That distinction is not decoration. `slugForFact` truncates at 64 characters, so two different
 * facts sharing a prefix land on the same filename — and a count that incremented on filename
 * alone would promote an entry to "corroborated" that nobody corroborated. A quarantine that can
 * be fooled by a rewrite is worse than no quarantine, because it hands confidence to exactly the
 * entry that has not earned it.
 *
 * Comparison is on normalized text (whitespace, case, trailing punctuation), so "X." recorded
 * after "x" counts as the same observation rather than as a new fact.
 */
// Returns 1 for a first write — and 1 is now recorded, because "counted once" and "unknown"
// are different claims and only the first one earns the [unconfirmed] marker.
async function nextObservationCount(dir: string, name: string, text: string): Promise<number> {
  let existing: string;
  try {
    existing = await readFile(join(dir, `${name}.md`), "utf8");
  } catch {
    return 1;
  }
  const parsed = parseMemoryFile(existing);
  if (parsed === undefined) return 1;
  const sameFact = normalizeFactText(parsed.body) === normalizeFactText(text);
  if (!sameFact) return 1;
  return (parsed.observations ?? 1) + 1;
}

/** Identity, not similarity — the same normalization the sweep uses for untyped entries. */
function normalizeFactText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/, "");
}

/**
 * The `MEMORY.md` index with `name` present exactly once.
 *
 * Rewriting the same memory replaces its line rather than adding a second: the index is a map from
 * memory to file, and two lines for one file is a map that disagrees with itself.
 */
async function nextIndex(dir: string, text: string, name: string, title: string): Promise<string> {
  let existing = "";
  try {
    // The index in the directory being WRITTEN, not the project one — see the caller.
    existing = await readFile(join(dir, "MEMORY.md"), "utf8");
  } catch {
    existing = "";
  }
  // `- [Title](slug.md) — hook`, the shape the interop partner writes in 644 of its 673 index
  // lines. The link carries the concept and the dash carries the detail; putting the whole entry
  // in the link made every line as long as the memory itself.
  const hook = text.replace(/\s+/g, " ").trim();
  const entry =
    hook.length > 0 && hook !== title
      ? `- [${title}](${name}.md) — ${hook}`
      : `- [${title}](${name}.md)`;
  const kept = existing
    .split("\n")
    .filter((line) => !line.startsWith(`- [`) || !line.includes(`](${name}.md)`));
  const body = kept.join("\n").trimEnd();
  // The partner's index is `# Memory Index`, a blank line, then the entries. `trimEnd()` on the
  // header collapsed that blank line and made the first entry hug the heading.
  const head = body.length > 0 ? body : MEMORY_MD_HEADER;
  return `${head}\n${entry}\n`;
}

/**
 * A `MEMORY.md` index entry: a link to a sibling `.md` file, optionally followed by the ` — hook`
 * the index carries after the link.
 *
 * The optional tail is not cosmetic. This pattern was anchored immediately after `)`, which
 * encoded an assumption that an index line ENDS at its link — true until the line gained a hook.
 * With the anchor unchanged, every index line stopped being recognised as a pointer and was
 * recalled as a memory of its own: the agent would read `[New memory](new-memory.md) — a new
 * memory` as a fact, alongside the real one. A filter that silently stops matching does not fail
 * loudly; it just starts letting things through.
 */
const INDEX_ENTRY = /^\[[^\]]*\]\([^)]+\.md\)(?:\s+—\s.*)?$/;

/**
 * Facts from a legacy `## Facts` section — the shape every released version wrote.
 *
 * Kept for reading only. The converged writer puts each memory in its own file, and this parser
 * exists so a store written by an earlier version keeps answering.
 *
 * There is no metadata to recover from a bullet: `kind` and `modified` are absent, which is exactly
 * right, since nothing recorded them. A brief encoding that carried them in a trailing HTML comment
 * (#389) never reached a published version — 4.55.0 was published at 17:23Z and that commit landed
 * at 20:06Z — so there is no store in the wild to migrate from it.
 */
function parseFactsSection(raw: string): MemoryFact[] {
  const idx = raw.indexOf(FACTS_HEADING);
  if (idx === -1) return [];
  const tail = raw.slice(idx + FACTS_HEADING.length);
  // Stop at the next top-level or h2 heading.
  const nextHeading = tail.search(/\n#{1,2}\s/);
  const block = nextHeading === -1 ? tail : tail.slice(0, nextHeading);
  return (
    block
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2).trim())
      // An index entry is a POINTER to a memory, not a memory. Both are `- ` bullets, and when a
      // legacy `## Facts` heading is present the appended index lines land under it — counting them
      // here would report every converged memory twice, once from its file and once from its link.
      .filter((body) => !INDEX_ENTRY.test(body))
      .map((body) => ({ text: body }))
  );
}

/**
 * Every memory in the store, honouring the `enabled` gate on {@link MemoryConfig}: when memory is
 * disabled the call resolves to `[]` without touching disk. Configuration-aware entry point;
 * {@link readFactsFromMarkdown} is the same read without the gate.
 */
export async function readFacts(cwd: string, config: MemoryConfig): Promise<MemoryFact[]> {
  if (!config.enabled) return [];
  return readFactsFromMarkdown(cwd, config);
}

/**
 * Record a fact, honouring the `enabled` gate on {@link MemoryConfig}: when memory is disabled the
 * call resolves without touching disk. Configuration-aware entry point;
 * {@link appendFactToMarkdown} is the same write without the gate.
 *
 * The destination comes from `memory.directory` and from nothing else. It used to come from
 * `local.sessionDir` — the option that names the TRANSCRIPT home — so one option answered two
 * questions and only this call site heard the second answer (#463).
 */
export async function appendFact(
  cwd: string,
  config: MemoryConfig,
  fact: MemoryFact,
): Promise<void> {
  if (!config.enabled) return;
  await appendFactToMarkdown(cwd, fact, resolveMemoryRoot(cwd, config), {
    ...(config.maxFacts !== undefined ? { maxFacts: config.maxFacts } : {}),
  });
}
