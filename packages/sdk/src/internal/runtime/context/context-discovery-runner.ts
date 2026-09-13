/**
 * Multi-format context discovery runner (T5.1, ADRs D150-D156).
 *
 * Walks `DEFAULT_DISCOVERY_SPECS` (or caller override), loads each
 * spec via the appropriate parser, applies `@import` resolution where
 * declared, and returns a flat list of `AggregatorSource[]` ready for
 * the aggregate cap.
 *
 * **EC-E privacy fix:** source disambiguation uses
 * `relative(gitRoot ?? cwd, ...)` — NEVER absolute paths in
 * `<source name="">`.
 *
 * @internal
 */

import { readFile } from "node:fs/promises";
import { dirname, relative } from "node:path";

import type { AggregatorSource } from "./context-aggregator.js";
import {
  admittedSpecs,
  DEFAULT_DISCOVERY_SPECS,
  type DiscoverySpec,
  findGitRoot,
  walkUpForFile,
  walkUpForGlob,
} from "./context-discovery.js";
import { resolveImports } from "./context-import-resolver.js";
import { loadPlainMarkdown } from "./context-loaders.js";
import { parseMdc, shouldActivate } from "./context-mdc-parser.js";
import { parseRules, shouldActivateRule } from "./context-rules-frontmatter.js";

/**
 * Input to the context-discovery run: where to walk, how much of each file to keep, and which
 * trust boundary an `@import` may not cross.
 *
 * `cwd` and `maxBytesPerFile` are required because neither has a safe default — an unset root walks
 * the wrong tree, and an unset cap lets one large file consume the context window.
 *
 * `importRoot` is the field to reach for when the caller's trust boundary is narrower than the
 * repository. Left unset, the repository IS the boundary (`gitRoot ?? cwd`), which is the honest
 * default for a document found by walking the repository — but it does mean an `@import` can pull
 * in any file the repo contains.
 *
 * @public — re-exported from '@theokit/sdk/context', and therefore under semver.
 */
export interface DiscoveryRunnerOptions {
  /** Workspace root passed to all discovery scopes. */
  readonly cwd: string;
  /** Per-file truncation cap (D155). */
  readonly maxBytesPerFile: number;
  /** Optional override of the default registry. */
  readonly specs?: ReadonlyArray<DiscoverySpec>;
  /**
   * The foreign dialects the consumer granted the `context` surface to — the output of
   * `adaptersForSurface(compatSources, "context")`, mapped to `.kind`.
   *
   * Left unset, every spec runs, which is what every caller before usetheokit/theokit-sdk#652 got.
   * Set, it filters specs carrying a {@link DiscoverySpec.dialect} the list does not name — so an
   * empty array is a real value meaning "no foreign dialect granted", NOT the same as absent.
   *
   * That distinction is the whole option. `resolveCompatSources` returns `[]` for a consumer who
   * declared nothing, and collapsing `[]` into `undefined` here would restore the defect: a
   * repository's `.claude/rules/*.md` entering the system prompt of a consumer who never asked for
   * that dialect.
   */
  readonly declaredCompatKinds?: ReadonlyArray<string>;
  /** Cursor MDC: file paths the LLM has touched this turn (EC-I: empty at send-time). */
  readonly touchedFiles?: ReadonlyArray<string>;
  /** When true, skip `theokit-context` spec — caller already handles the legacy path. */
  readonly skipLegacyTheokitContext?: boolean;
  /**
   * The root an `@import` may not escape. Defaults to `gitRoot ?? cwd` — the same value
   * this runner already uses to keep absolute paths out of `<source name="">`.
   *
   * Present so an embedder with a trust boundary narrower than the repository can declare
   * it. Absent, the repository IS the boundary, which is the honest default for a document
   * discovered by walking the repository.
   */
  readonly importRoot?: string;
}

/**
 * Find, read and parse every context file the specs describe, and return them ready for the
 * aggregator.
 *
 * Specs are processed in the order given — `opts.specs` when supplied, otherwise
 * `DEFAULT_DISCOVERY_SPECS` — and within a spec, in the order its scope resolves paths. The
 * returned array carries `priority` on each source; it is NOT sorted here, so the aggregator is
 * what applies the ordering.
 *
 * A path already emitted is skipped, across specs as well as within one. Paths arrive resolved
 * through `realpath`, so two specs pointing at the same physical file through a symlink produce
 * one source rather than two.
 *
 * Missing and unreadable files are not errors: a file that does not exist is simply not matched,
 * and one that fails to read or parse is dropped and the run continues. A frontmatter file whose
 * activation conditions do not hold — `enabled: false`, or a scope that no touched file matches —
 * is dropped the same way. So a shorter result than expected means "nothing qualified", and this
 * function will not tell you which of those it was.
 *
 * Reads the filesystem and nothing else. No network, no writes, and no mutation of `opts`.
 *
 * Privacy: `<source name="">` is built from the path RELATIVE to the git root (or `cwd` when
 * there is no git root), never an absolute path, so a home directory never reaches the prompt.
 * `@import` resolution is bounded by `opts.importRoot`, defaulting to that same root — a document
 * cannot pull in a file from outside the repository.
 *
 * @public — re-exported from `@theokit/sdk/context`, and therefore under semver.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: per-spec dispatch ladder + cross-spec dedup is a flat orchestrator; splitting would obscure the priority-merge invariant.
export async function runDiscovery(opts: DiscoveryRunnerOptions): Promise<AggregatorSource[]> {
  const gitRoot = findGitRoot(opts.cwd);
  const specs = admittedSpecs(opts.specs ?? DEFAULT_DISCOVERY_SPECS, opts.declaredCompatKinds);
  const out: AggregatorSource[] = [];
  const seenReal = new Set<string>();

  for (const spec of specs) {
    if (opts.skipLegacyTheokitContext && spec.id === "theokit-context") continue;
    const paths = await resolvePathsForSpec(spec, opts.cwd, gitRoot);
    for (const path of paths) {
      if (seenReal.has(path)) continue;
      seenReal.add(path);
      const source = await loadOneSource(spec, path, opts, gitRoot);
      if (source !== undefined) out.push(source);
    }
  }
  return out;
}

async function resolvePathsForSpec(
  spec: DiscoverySpec,
  cwd: string,
  gitRoot: string | undefined,
): Promise<string[]> {
  if (spec.scope === "cwd-only") {
    return walkUpForFile(cwd, spec.pattern, cwd);
  }
  if (spec.scope === "git-root-walk") {
    return walkUpForFile(cwd, spec.pattern, gitRoot ?? cwd);
  }
  // globbed
  return walkUpForGlob(cwd, spec.pattern);
}

async function loadOneSource(
  spec: DiscoverySpec,
  path: string,
  opts: DiscoveryRunnerOptions,
  gitRoot: string | undefined,
): Promise<AggregatorSource | undefined> {
  // EC-E privacy: name uses relative-to-git-root for disambiguation;
  // NEVER absolute paths in the public `<source name="">` attribute.
  // For cwd-only specs (THEO.md), no disambiguation is needed because
  // the scope can only ever match a single file.
  const relPath = relative(gitRoot ?? opts.cwd, dirname(path));
  const needsSuffix = spec.scope !== "cwd-only" && relPath !== "" && relPath !== ".";
  const id = needsSuffix ? `${spec.id}@${relPath}` : spec.id;

  if (spec.parser === "mdc") {
    return loadMdcSource(spec, path, id, opts);
  }
  if (spec.parser === "rules-frontmatter") {
    return loadRulesSource(spec, path, id, opts);
  }
  if (spec.parser === "frontmatter-zod") {
    // Legacy `.theokit/context/*.md` — handled by `loadContextConfig` in
    // `context-manager.ts` for backward compat. We skip here unless caller
    // explicitly wants us to load it (currently always skipped).
    return undefined;
  }
  // plain-markdown
  return loadPlainMarkdownSource(spec, path, id, opts, gitRoot);
}

/**
 * Shared read → parse → activation-gate → source pipeline for the frontmatter
 * discovery parsers (mdc, rules). Binds the parser + the activation predicate so
 * the mdc and rules loaders differ only in those two, not in the surrounding
 * read/guard/shape boilerplate (DRY).
 */
async function loadParsedSource<F>(
  spec: DiscoverySpec,
  path: string,
  id: string,
  parse: (raw: string) => { frontmatter: F; body: string } | undefined,
  isActive: (frontmatter: F) => boolean,
): Promise<AggregatorSource | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  const parsed = parse(raw);
  if (parsed === undefined || !isActive(parsed.frontmatter)) return undefined;
  return { id, source: path, content: parsed.body, priority: spec.priority, truncated: false };
}

function loadMdcSource(
  spec: DiscoverySpec,
  path: string,
  id: string,
  opts: DiscoveryRunnerOptions,
): Promise<AggregatorSource | undefined> {
  return loadParsedSource(spec, path, id, parseMdc, (fm) =>
    shouldActivate(fm, opts.touchedFiles ?? []),
  );
}

function loadRulesSource(
  spec: DiscoverySpec,
  path: string,
  id: string,
  opts: DiscoveryRunnerOptions,
): Promise<AggregatorSource | undefined> {
  return loadParsedSource(spec, path, id, parseRules, (fm) =>
    shouldActivateRule(fm, opts.touchedFiles ?? []),
  );
}

async function loadPlainMarkdownSource(
  spec: DiscoverySpec,
  path: string,
  id: string,
  opts: DiscoveryRunnerOptions,
  gitRoot: string | undefined,
): Promise<AggregatorSource | undefined> {
  const loaded = await loadPlainMarkdown(path, { maxBytesPerFile: opts.maxBytesPerFile });
  if (loaded === undefined) return undefined;
  let content = loaded.content;
  if (spec.followImports) {
    content = await resolveImports(content, path, {
      visited: new Set([path]),
      depth: 0,
      maxBytesPerFile: opts.maxBytesPerFile,
      // The document carrying the import is repository-controlled, so the repository is the
      // boundary it may not cross. Without this, `CLAUDE.md` / `GEMINI.md` — the two specs
      // with `followImports: true` — could name any absolute or `~/` path and have it
      // inlined into the system prompt.
      projectRoot: opts.importRoot ?? gitRoot ?? opts.cwd,
    });
  }
  return {
    id,
    source: path,
    content,
    priority: spec.priority,
    truncated: loaded.truncated,
  };
}
