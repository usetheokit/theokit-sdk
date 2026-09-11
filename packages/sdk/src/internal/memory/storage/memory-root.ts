import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";

import { ConfigurationError } from "../../../errors.js";
import { encodeProjectDir } from "../../persistence/session-transcript.js";
import { findGitRoot } from "../../runtime/context/context-discovery.js";
import type { MemoryConfig } from "../types.js";

/*
 * Where this agent's memory lives — asked once, answered once (#463).
 *
 * Every path in the subsystem used to compute its own answer from `cwd`, and one of them computed a
 * different one. `appendFact` relocated on `local.sessionDir`; the indexer, the `memory_get` path
 * guard, `MEMORY.md`, `sessions/`, `notes/`, `wiki/`, the dream diary and the index database did
 * not. A relocated fact was written, never indexed, unreadable by the tool meant to read it, and
 * shadowed by a second `MEMORY.md` in the store it had left.
 *
 * Every site that answers this question is a chance to answer it differently. They now take the
 * root as an argument, so a caller that has not resolved it does not compile — which is the only
 * version of this invariant that survives the next file being added.
 *
 * The brand is also what FOUND two of them. `index-db.ts` and `lance-index.ts` each spelled
 * `.theokit/memory` out again as a string literal rather than calling the shared helper, so no
 * search for that helper would have reached either; the type error did.
 *
 * The remaining gap, stated rather than hidden: `IndexManager.open()` and `LanceIndex.open()` are
 * entry points that take a `cwd`, so their `memoryRoot` is optional and falls back to the default.
 * Inside an agent the root is resolved once and passed to every consumer; a caller opening either
 * by hand against a non-default directory must pass it.
 */

/** The layout under a workspace when nothing overrides it. */
const DEFAULT_SUBPATH = [".theokit", "memory"] as const;

/**
 * A path that {@link resolveMemoryRoot} produced — the only thing the subsystem's path helpers
 * accept.
 *
 * The brand is what makes "every path derives from one resolution" a compiler rule rather than a
 * convention. Both a `cwd` and a root are strings, so without it the helpers would go on accepting
 * either, and the next one added would have the same even chance of taking the wrong one that
 * produced #463 in the first place. It costs one cast, at the one place a caller legitimately has a
 * directory that did not come from here.
 *
 * STRUCTURAL, not a `unique symbol`. A `unique symbol` brand is identity-based, and the d.ts
 * bundler inlines the declaration into each package that re-exports it — so `@theokit/sdk-memory`
 * ended up with a `MemoryRoot` its own compiler considered incompatible with the SDK's, on values
 * that were the same string. A structural tag refuses a bare `string` exactly as well and survives
 * the package boundary, which is where this type has to work.
 */
// G7 / DIP — the branded type now lives in the domain layer it belongs to
// (`types/memory-provider.ts`), and this adapter imports it rather than owning it. It used to be
// defined here and reached for by `types/memory-provider.ts`, so the PORT depended on the ADAPTER
// for a field of its own argument type — while that file's docblock called itself "the DIP-correct
// home ... the port + companion contract types live in the domain types/ layer". Re-exported so
// every existing `import { MemoryRoot } from ".../memory-root.js"` keeps resolving.
import type { MemoryRoot } from "../../../types/memory-provider.js";

export type { MemoryRoot };

/**
 * Treat a directory as a memory root without resolving one.
 *
 * For the two honest cases: a test fixture, and a consumer opening an index against a store it
 * located itself. Every other caller resolves.
 */
export function asMemoryRoot(dir: string): MemoryRoot {
  return dir as MemoryRoot;
}

/** Only `directory` is read; the full config is accepted so callers pass what they already hold. */
export type MemoryLocationConfig = Partial<MemoryConfig>;

/**
 * The project store: `<cwd>/.theokit/memory`. The default root, and always a READ root even when
 * the write root moved — see {@link memoryReadRoots}.
 */
export function projectMemoryDir(cwd: string): MemoryRoot {
  return join(cwd, ...DEFAULT_SUBPATH) as MemoryRoot;
}

/**
 * Where the Claude Code CLI keeps THIS project's memories.
 *
 * `<claudeHome>/projects/<encoded-cwd>/memory` — the same `encodeProjectDir` scheme the transcripts
 * already use, which is why no new encoding is invented here. `CLAUDE_CONFIG_DIR` names the home
 * when set (the CLI's own variable); `~/.claude` otherwise.
 *
 * Read, never written. This is the half of the interop that decoupling the write MUST NOT cost: a
 * memory the CLI recorded stays visible whatever `memory.directory` says.
 *
 * **Keyed by the GIT ROOT, not by `cwd` (#479).** The CLI derives this path from the repository, so
 * every subdirectory and worktree shares one auto-memory directory; outside a repository it uses the
 * directory itself. Keying by `cwd` meant an agent running from a monorepo package, a `tools/`
 * script or a nested test read a directory the CLI never writes to — finding nothing, and saying
 * nothing, which is the same observation an empty store produces.
 *
 * TRANSCRIPTS ARE THE TRAP, and the reason this went unnoticed: the CLI keys THOSE by `cwd`, and
 * `encodeProjectDir` is right for them. One encoder for two axes made the two indistinguishable in
 * the code. The encoder is still shared — the path it is given is not.
 *
 * ## What is READ here and what is not IMPLEMENTED (B-054)
 *
 * This reads the directory the Claude Code CLI writes its auto-memory into. It does not implement
 * the CLI's auto-memory BEHAVIOUR: `autoMemoryEnabled`, `autoMemoryDirectory`,
 * `CLAUDE_CODE_DISABLE_AUTO_MEMORY`, `cleanupPeriodDays` and the documented 200-line / 25 KB read
 * cap have no counterpart — measured 0 files across this package and `@theokit/agents`.
 *
 * Interop in one direction is the decision, not an oversight: a memory the CLI recorded stays
 * visible, and this runtime does not start writing into a store another product owns the lifecycle
 * of. A `cleanupPeriodDays` implemented here would delete files the CLI expects to find.
 *
 * `CLAUDE_CONFIG_DIR` is honoured HERE and nowhere else, and that is the whole of its scope in this
 * runtime: it names the CLI's home so this reader finds the right directory. It does not relocate a
 * user-level configuration root of this product's own, because there is none to relocate — the
 * config roots resolved elsewhere are PROJECT-relative.
 *
 * ## The filename collision, stated at one of its two ends
 *
 * `MEMORY.md` names two different contracts. The CLI's is a plain file under the directory above,
 * capped and swept by the CLI. This SDK's is the durable-memory subsystem — a SQLite+FTS5 store
 * under `.theokit/memory/` with `memory_search` / `memory_get` tools, no index cap, and a different
 * directory entirely.
 *
 * Same filename, different directory, different semantics. A parity checklist that greps for
 * `MEMORY.md` finds one and concludes the other exists — the third name in this backlog to collide
 * that way, and the reason the statement lives at both ends rather than in a changelog.
 */
export function claudeProjectMemoryDir(cwd: string): MemoryRoot {
  const home = process.env.CLAUDE_CONFIG_DIR?.trim();
  const root = home !== undefined && home.length > 0 ? home : join(homedir(), ".claude");
  return join(root, "projects", encodeProjectDir(findGitRoot(cwd) ?? cwd), "memory") as MemoryRoot;
}

/**
 * The memory root for this agent: `memory.directory` when set, the project store otherwise.
 *
 * `directory` must be absolute or start with `~/`, which is the contract the interop partner
 * documents for the same option. A relative path is REFUSED rather than resolved against the
 * process cwd: the two plausible bases (workspace vs process) put memory in two different places,
 * and picking one silently is how a store ends up split across both.
 *
 * @throws {ConfigurationError} `invalid_memory_directory` — the value is blank or relative.
 */
export function resolveMemoryRoot(cwd: string, config?: MemoryLocationConfig): MemoryRoot {
  const declared = config?.directory;
  if (declared === undefined) return projectMemoryDir(cwd);
  const trimmed = declared.trim();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2)) as MemoryRoot;
  if (trimmed.length === 0 || !isAbsolute(trimmed)) {
    throw new ConfigurationError(
      `memory.directory must be an absolute path or start with "~/". Received: ${JSON.stringify(declared)}`,
      { code: "invalid_memory_directory" },
    );
  }
  return trimmed as MemoryRoot;
}

/**
 * The line limit the Claude Code CLI applies when it loads a `MEMORY.md`.
 *
 * Its number, not ours, and that is the point — see {@link indexBudgetWarning}.
 */
export const MEMORY_INDEX_MAX_LINES = 200;

/**
 * The byte limit the Claude Code CLI applies when it loads a `MEMORY.md`, whichever it reaches
 * first. Also its number — see {@link indexBudgetWarning}.
 */
export const MEMORY_INDEX_MAX_BYTES = 25 * 1024;

/**
 * What to say about an index that the interop partner will truncate, or `undefined` when there is
 * nothing true to say.
 *
 * **This is a statement about the PARTNER, not about us.** The CLI loads the first 200 lines / 25KB
 * of `MEMORY.md` into every session and drops the rest in silence. We never load the index at all:
 * the `<memory>` block is built from the per-memory FILES by `selectFactsForInjection`, ranked and
 * capped, so our own recall does not degrade as the index grows. A warning that said "memory stops
 * working" would be false here, and a warning that overstates is a warning somebody disables.
 *
 * It therefore speaks ONLY when the resolved root is the store the CLI reads. Anywhere else the
 * index is ours, nobody truncates it, and the warning would be noise in every project that never
 * opted into interop.
 *
 * Returns a string rather than emitting one: the caller decides what to do with it, and a pure
 * function is testable without a filesystem or a captured stderr.
 */
export function indexBudgetWarning(index: string, root: string): string | undefined {
  if (root !== claudeProjectMemoryDirFor(root)) return undefined;
  const lines = index.split("\n").length;
  const bytes = Buffer.byteLength(index, "utf8");
  const over: string[] = [];
  if (lines > MEMORY_INDEX_MAX_LINES) over.push(`${lines} lines (limit ${MEMORY_INDEX_MAX_LINES})`);
  if (bytes > MEMORY_INDEX_MAX_BYTES) {
    over.push(`${Math.round(bytes / 1024)} KB (limit ${MEMORY_INDEX_MAX_BYTES / 1024} KB)`);
  }
  if (over.length === 0) return undefined;
  return (
    `MEMORY.md at ${root} is ${over.join(" and ")}. The Claude Code CLI loads only the first ` +
    `${MEMORY_INDEX_MAX_LINES} lines / ${MEMORY_INDEX_MAX_BYTES / 1024} KB of an index and drops ` +
    `the rest without saying so, which is where this store is written. Shorten the entries or move ` +
    `detail into the per-memory files. Recall through this SDK is unaffected — it reads the files, ` +
    `not the index.`
  );
}

/**
 * Whether `root` IS a Claude Code project memory directory, without needing the cwd that produced
 * it. The CLI's layout is `<claudeHome>/projects/<encoded-cwd>/memory`, so membership is decidable
 * from the path alone — which is what lets {@link indexBudgetWarning} stay a pure function.
 */
function claudeProjectMemoryDirFor(root: string): string {
  const home = process.env.CLAUDE_CONFIG_DIR?.trim();
  const claudeHome = home !== undefined && home.length > 0 ? home : join(homedir(), ".claude");
  const prefix = join(claudeHome, "projects");
  const isUnderProjects = root.startsWith(`${prefix}${sep}`);
  return isUnderProjects && root.endsWith(`${sep}memory`) ? root : "";
}

/**
 * Where the search index belongs for this configuration (theokit-sdk#554).
 *
 * Not always the same root the FACTS use, and the divergence is narrow on purpose.
 *
 * The index is not a pointer — `chunks.text` holds the fact text, because FTS5/BM25 needs it to
 * search. A copy of the index is therefore a copy of the memory. Leaving it in `<cwd>` while the
 * facts move writes one operator's personal store into every repository the agent runs in,
 * untracked and readable with `strings`.
 *
 * So the index follows the store — EXCEPT into the Claude Code CLI's own directory, which is the
 * case `docs/memory-decisions.md` § 1 reasons about and settles: that CLI has no index format, so
 * a binary there is an artefact the partner does not understand inside a directory it manages. The
 * decision keeps exactly the scope its own argument covers, and no more; every other directory is
 * a plain directory this SDK is free to own.
 */
export function memoryIndexRoot(cwd: string, store: MemoryRoot): MemoryRoot {
  // Decidable from the path alone — the same test `indexBudgetWarning` relies on. Takes the
  // RESOLVED store rather than the config, because every caller has already resolved it once and
  // resolving twice is how the index and the writer end up looking at different directories (#463).
  return claudeProjectMemoryDirFor(store) === "" ? store : projectMemoryDir(cwd);
}

/**
 * Every directory a read must cover, deduplicated and in precedence order.
 *
 * WRITE ONE, READ ALL — this is what keeps a configured `directory` from orphaning anything. The
 * configured root comes first, the project store second so memories recorded before the move stay
 * readable, and the CLI's store last so interop survives the write being decoupled from it.
 */
export function memoryReadRoots(cwd: string, config?: MemoryLocationConfig): readonly MemoryRoot[] {
  return [
    ...new Set([
      resolveMemoryRoot(cwd, config),
      projectMemoryDir(cwd),
      claudeProjectMemoryDir(cwd),
    ]),
  ];
}
