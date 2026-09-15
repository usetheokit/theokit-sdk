/**
 * `@theokit/sdk/context` — context assembly, as a SANCTIONED PUBLIC surface.
 *
 * Everything re-exported here is under semver. That is the whole difference from the
 * `internal/*` subpaths (`internal/persistence`, `internal/security`, `internal/memory-adapters`),
 * which the package documents as "internal API — semver-exempt" and is retiring:
 * `internal/persistence` is `@deprecated` in favour of the sanctioned `@theokit/sdk/persistence`,
 * and `internal/plugins` + `internal/observability` were deleted as dead public surface in July.
 *
 * **The list is explicit and there is no `export *`.** The tree behind it holds 13 files, including
 * YAML shims and parser internals a consumer never needs. Publishing the directory would commit
 * this package to every file in it; widening this list is a deliberate act.
 *
 * @public
 */

import {
  type ResolveImportsOptions,
  resolveImports as resolveImportsInternal,
} from "../internal/runtime/context/context-import-resolver.js";

export type {
  DiscoveryParser,
  DiscoveryScope,
  DiscoverySpec,
} from "../internal/runtime/context/context-discovery.js";
/**
 * The seven conventions {@link runDiscovery} looks for when `specs` is omitted — `AGENTS.md`,
 * `GEMINI.md`, `CLAUDE.md`, `.cursor/rules/*.mdc`, `.theokit/rules/*.md`, `.theokit/context/*.md`
 * and `.theokit/THEO.md`.
 *
 * Exported because `specs` REPLACES this list rather than extending it. Without the constant, a
 * consumer registering one convention of its own silently loses every built-in one, and the loss is
 * invisible — discovery simply returns fewer sources. Spread it to extend:
 *
 * ```ts
 * await runDiscovery({ cwd, maxBytesPerFile, specs: [...DEFAULT_DISCOVERY_SPECS, mySpec] });
 * ```
 *
 * @public
 */
export { DEFAULT_DISCOVERY_SPECS } from "../internal/runtime/context/context-discovery.js";
export {
  type DiscoveryRunnerOptions,
  runDiscovery,
} from "../internal/runtime/context/context-discovery-runner.js";
export {
  parseRules,
  shouldActivateRule,
} from "../internal/runtime/context/context-rules-frontmatter.js";

/**
 * Options for {@link resolveContextImports}.
 *
 * `projectRoot` is REQUIRED here and OPTIONAL on the internal `resolveImports`, and the asymmetry
 * is the point rather than an oversight.
 *
 * Internally the field has to be optional: it was added in 4.41.1 to close a defect where a
 * repository-supplied `CLAUDE.md` could name `@~/.ssh/id_rsa` and have that file inlined into the
 * agent's system prompt, and making it required would have broken every caller that predates it.
 *
 * As a PUBLIC contract the same optionality inverts into a trap. The obvious call omits the field,
 * compiles, and silently restores the un-contained behaviour — so the easiest way to use the API
 * would be the unsafe one, published under semver and therefore unfixable without a breaking
 * change. Requiring it makes the safe call the only call.
 *
 * @public
 */
export interface ResolveContextImportsOptions {
  /**
   * The directory an `@import` may not escape, compared after symlink resolution.
   *
   * A document carrying imports is repository-controlled — untrusted input whenever the repository
   * came from somewhere else — so the boundary is not optional.
   */
  readonly projectRoot: string;
  /** Per-import file cap, forwarded to the loader. */
  readonly maxBytesPerFile: number;
  /** Absolute paths already resolved, for cycle detection. Defaults to an empty set. */
  readonly visited?: Set<string>;
  /** Current recursion depth. Defaults to 0; the resolver caps at 5 hops. */
  readonly depth?: number;
}

/**
 * Expand `@path` import directives in `content`, confined to `options.projectRoot`.
 *
 * A line that is exactly `@some/path` is replaced with that file's content, recursively, with cycle
 * detection and a 5-hop cap. A target resolving outside the root — by `..`, by an absolute path, by
 * `~/`, or through a symlink — is replaced with a refusal placeholder rather than its bytes, and the
 * placeholder echoes the path as the author wrote it rather than as resolved, so a refusal does not
 * leak the layout of the machine back into the same untrusted document.
 *
 * @public
 */
export function resolveContextImports(
  content: string,
  basePath: string,
  options: ResolveContextImportsOptions,
): Promise<string> {
  const internalOptions: ResolveImportsOptions = {
    visited: options.visited ?? new Set<string>(),
    depth: options.depth ?? 0,
    maxBytesPerFile: options.maxBytesPerFile,
    projectRoot: options.projectRoot,
  };
  return resolveImportsInternal(content, basePath, internalOptions);
}
export { withheldSpecs } from "../internal/runtime/context/context-discovery.js";
