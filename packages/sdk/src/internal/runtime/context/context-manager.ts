import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";

import { ConfigurationError } from "../../../errors.js";
import type {
  ContextBudget,
  ContextSettings,
  ContextSnapshot,
  ContextSource,
  SDKContextManager,
} from "../../../types/context.js";
import { loadMarkdownEntities } from "../../persistence/markdown-config-loader.js";
import { theokitConfigRoot } from "../../persistence/paths.js";
import { insideRoot } from "../../security/path-containment.js";
import {
  adaptersForSurface,
  type CompatSourceDeclaration,
} from "../compat/foreign-config-sources.js";
import { warnOnce } from "../hooks/hooks-source.js";
import {
  type AggregatorSource,
  applyAggregateCap,
  DEFAULT_MAX_BYTES_TOTAL,
} from "./context-aggregator.js";
import { runDiscovery } from "./context-discovery-runner.js";
import { ContextSourceFrontmatterSchema } from "./context-frontmatter.js";
import { DEFAULT_MAX_BYTES_PER_FILE } from "./context-loaders.js";

/**
 * File-based context manager. Reads `.theokit/context.json` from the
 * workspace cwd when `local.settingSources` includes `"project"`, loads each
 * referenced source, applies excludes, and exposes a redacted public
 * snapshot via `snapshot()`. Re-reads via `refresh()`.
 *
 * Public output is secret-free by design — raw absolute paths, .env content,
 * and excluded-file content never appear.
 *
 * @internal
 */

interface FileContextConfig {
  sources: Array<{ name: string; path: string }>;
  exclude?: string[];
  maxTokens?: number;
}

interface InternalState {
  config: FileContextConfig;
  loadedSources: Array<{
    name: string;
    path: string;
    status: ContextSource["status"];
    tokens: string[];
  }>;
}

export class FileContextManager implements SDKContextManager {
  private state: InternalState | undefined;
  /**
   * The in-scope file set used by the most recent `refresh`. Tracked so
   * `applyScope` only touches state when the scope actually changes — a
   * caller that never scopes (the common case) keeps the create-time
   * snapshot untouched, at zero per-send cost.
   */
  private lastScope: ReadonlyArray<string> = [];

  /**
   * @param compatSources - What the consumer declared in `local.compatSources` (or
   * `.theokit/config.json`), as `resolveCompatSources` resolved it. `undefined` means the caller
   * did not thread the declaration through at all and every dialect runs — the pre-#652 behaviour,
   * kept so an internal caller constructing this directly does not silently lose content. An empty
   * ARRAY is different and is the fix: it means the consumer declared no foreign dialect, so
   * `.claude/rules/*.md` does not reach the prompt.
   */
  constructor(
    private readonly cwd: string,
    private readonly settings: ContextSettings,
    private readonly settingSourcesIncludeProject: boolean,
    private readonly compatSources?: readonly CompatSourceDeclaration[],
  ) {}

  /**
   * The dialect kinds granted the `context` surface, or `undefined` when nothing was declared to
   * this instance.
   *
   * Routed through `adaptersForSurface` rather than reading `.kind` off the declarations, so the
   * three fail-closed rules #524 established govern this surface identically to the other four: a
   * bare string admits everything, an object with no `import` admits nothing, and an unrecognised
   * surface name narrows rather than widens.
   */
  private grantedContextDialects(): ReadonlyArray<string> | undefined {
    if (this.compatSources === undefined) return undefined;
    return adaptersForSurface(this.compatSources, "context").map((a) => a.kind);
  }

  async initialize(): Promise<void> {
    // `context.manager: "file"` is itself an opt-in for project-level context
    // loading, even when `local.settingSources` does not include "project".
    if (!this.settingSourcesIncludeProject && this.settings.manager !== "file") {
      this.state = { config: { sources: [] }, loadedSources: [] };
      return;
    }
    await this.refresh();
  }

  /**
   * Re-run discovery for a specific per-send in-scope file set (T3). Path-scoped
   * rules (`.theokit/rules/*.md`, `.cursor/rules/*.mdc` globs) activate iff a
   * pattern matches one of `contextPaths`. Idempotent: unchanged scope is a
   * no-op, and `undefined` scope while never previously scoped never touches
   * state (preserves the create-time snapshot for non-users).
   */
  async applyScope(contextPaths: ReadonlyArray<string> | undefined): Promise<void> {
    const scope = contextPaths ?? [];
    if (scope.length === 0 && this.lastScope.length === 0) return;
    if (sameScope(scope, this.lastScope)) return;
    await this.refresh({ touchedFiles: scope });
  }

  async refresh(opts?: { touchedFiles?: ReadonlyArray<string> }): Promise<void> {
    const touchedFiles = opts?.touchedFiles ?? [];
    // Defensive copy — never alias the caller's array, so a caller reusing +
    // mutating the same `contextPaths` array between sends cannot corrupt the
    // `sameScope` short-circuit in `applyScope`.
    this.lastScope = [...touchedFiles];
    const config = await loadContextConfig(this.cwd);
    const legacy = await loadSources(config, this.cwd);

    // Phase 5 (ADRs D150-D156): multi-format discovery for AGENTS.md,
    // CLAUDE.md, GEMINI.md, .cursor/rules/*.mdc, .theokit/THEO.md.
    // Existing `.theokit/context/*.md` legacy sources keep working via
    // the path above; we feed them into the aggregator alongside the
    // newly-discovered sources.
    const maxBytesPerFile = this.settings.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE;
    const maxBytesTotal = this.settings.maxBytesTotal ?? DEFAULT_MAX_BYTES_TOTAL;
    const granted = this.grantedContextDialects();
    const discovered = await runDiscovery({
      cwd: this.cwd,
      maxBytesPerFile,
      skipLegacyTheokitContext: true,
      touchedFiles,
      // #652 — the grant this path never consulted. Without it, a consumer who enabled project
      // scope for its OWN `.theokit/` also received a cloned repository's `.claude/rules/*.md`,
      // through a door the hooks/skills/subagents/plugins gate does not cover.
      ...(granted === undefined ? {} : { declaredCompatKinds: granted }),
    });

    // An excluded source must NOT be resurrected here. `loadSources` marks a source `excluded` when
    // it resolves outside the project root (or matches `exclude`), and this mapping used to carry
    // EVERY legacy source into the aggregator — after which `loadedSources` below stamps
    // `"included"` on everything the budget kept. The containment verdict was computed and then
    // discarded three statements later, so `snapshot()` reported an excluded source as included.
    // The content was empty, so nothing leaked through this path; the STATUS was a lie, and a
    // consumer auditing "what is in my context" got the wrong answer.
    const legacyAsAggregator: AggregatorSource[] = legacy
      .filter((src) => src.status !== "excluded")
      .map((src) => ({
        id: src.name,
        source: src.path,
        content: src.tokens.join(""),
        priority: 50, // matches DEFAULT_DISCOVERY_SPECS theokit-context
        truncated: false,
      }));

    const { kept } = applyAggregateCap([...discovered, ...legacyAsAggregator], maxBytesTotal);

    // Materialize kept sources as InternalState entries. Public type
    // `ContextSourceStatus` uses `"summarized"` for "trimmed to fit budget".
    const loadedSources: InternalState["loadedSources"] = kept.map((s) => ({
      name: s.id,
      path: s.source,
      status: s.truncated ? "summarized" : "included",
      tokens: [s.content],
    }));

    this.state = { config, loadedSources };
  }

  snapshot(): Promise<ContextSnapshot> {
    const state = this.state ?? { config: { sources: [] }, loadedSources: [] };
    const sources: ContextSource[] = state.loadedSources.map((src) => ({
      name: src.name,
      path: src.path,
      status: src.status,
    }));
    const allTokens = state.loadedSources.flatMap((src) => src.tokens);
    const budget: ContextBudget = {};
    const maxTokens = this.settings.maxTokens ?? state.config.maxTokens;
    if (maxTokens !== undefined) budget.maxTokens = maxTokens;
    budget.usedTokens = allTokens;
    return Promise.resolve({ runtime: "local", sources, budget });
  }

  /**
   * Internal-only — returns per-source token slices so the system-prompt
   * `ContextPromptProvider` can format the `<source>` body. The public
   * `snapshot()` flattens tokens across sources for the budget summary,
   * which is the wrong shape for prompt assembly.
   *
   * @internal
   */
  internalAssemblySnapshot(): {
    sources: Array<{ name: string; status: ContextSource["status"]; tokens: string[] }>;
    maxTokens: number | undefined;
  } {
    const state = this.state ?? { config: { sources: [] }, loadedSources: [] };
    const maxTokens = this.settings.maxTokens ?? state.config.maxTokens;
    return {
      sources: state.loadedSources.map((src) => ({
        name: src.name,
        status: src.status,
        tokens: [...src.tokens],
      })),
      maxTokens,
    };
  }
}

/**
 * Load context config with MD-first fallback (ADR D77, T2.2).
 *
 *   1. `.theokit/context/<name>.md` (preferred).
 *   2. `.theokit/context.json` (deprecated; emits warn).
 *   3. Neither → empty sources.
 *
 * @internal
 */
async function loadContextConfig(cwd: string): Promise<FileContextConfig> {
  const mdDir = join(theokitConfigRoot(cwd), "context");
  const jsonPath = join(theokitConfigRoot(cwd), "context.json");

  const mdEntities = await loadMarkdownEntities({
    dir: mdDir,
    schema: ContextSourceFrontmatterSchema,
    pattern: "flat",
    errorCodePrefix: "context",
  });

  if (mdEntities.length > 0) {
    if (existsSync(jsonPath)) {
      warnOnce(
        "context-both-present",
        "[theokit-sdk] both .theokit/context/ and .theokit/context.json detected — using markdown; remove context.json",
      );
    }
    return {
      sources: mdEntities
        .filter((e) => e.frontmatter.enabled !== false)
        .map((e) => ({ name: e.frontmatter.name ?? e.slug, path: e.frontmatter.path })),
    };
  }

  // Fallback: JSON
  if (!existsSync(jsonPath)) return { sources: [] };

  warnOnce(
    "context-json-deprecated",
    // Names no command: `theokit-migrate-config` was unpublished with the `bin` entry, and a warning
    // that tells you to run something the package does not ship is worse than one that tells you
    // what the target looks like.
    "[theokit-sdk] .theokit/context.json is deprecated; move each entry to its own file under .theokit/context/<name>.md",
  );

  let raw: string;
  try {
    raw = await readFile(jsonPath, "utf8");
  } catch (cause) {
    throw new ConfigurationError(`Failed to read context config: ${jsonPath}`, {
      code: "context_read_error",
      cause,
    });
  }
  return parseConfig(raw, jsonPath);
}

function parseConfig(raw: string, configPath: string): FileContextConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ConfigurationError(`Invalid JSON in context config: ${configPath}`, {
      code: "context_json_invalid",
      cause,
    });
  }
  if (!parsed || typeof parsed !== "object") {
    throw new ConfigurationError(`Context config must be an object: ${configPath}`, {
      code: "context_config_shape",
    });
  }
  const record = parsed as Record<string, unknown>;
  const sources = readSources(record.sources, configPath);
  const exclude = Array.isArray(record.exclude)
    ? record.exclude.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  const maxTokens = typeof record.maxTokens === "number" ? record.maxTokens : undefined;
  const result: FileContextConfig = { sources };
  if (exclude !== undefined) result.exclude = exclude;
  if (maxTokens !== undefined) result.maxTokens = maxTokens;
  return result;
}

function readSources(
  sourcesRaw: unknown,
  configPath: string,
): Array<{ name: string; path: string }> {
  if (!Array.isArray(sourcesRaw)) {
    throw new ConfigurationError(`Context config sources must be an array: ${configPath}`, {
      code: "context_sources_shape",
    });
  }
  return sourcesRaw
    .filter(
      (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object",
    )
    .map((entry) => {
      const name = typeof entry.name === "string" ? entry.name : "";
      const path = typeof entry.path === "string" ? entry.path : "";
      return { name, path };
    })
    .filter((entry) => entry.name.length > 0 && entry.path.length > 0);
}

async function loadSources(
  config: FileContextConfig,
  cwd: string,
): Promise<InternalState["loadedSources"]> {
  const results: InternalState["loadedSources"] = [];
  for (const source of config.sources) {
    if (isExcluded(source.path, config.exclude)) {
      results.push({ ...source, status: "excluded", tokens: [] });
      continue;
    }
    const absolute = resolvePath(cwd, source.path);
    // The path comes from `.theokit/context/*.md` frontmatter — repository-controlled, so untrusted.
    // This was `absolute.startsWith(resolvePath(cwd))`, which admitted a sibling directory whose
    // name extends the project's (`<cwd>-evil`) and any symlink resolving outside the root.
    if (!insideRoot(absolute, cwd)) {
      results.push({ ...source, status: "excluded", tokens: [] });
      continue;
    }
    try {
      // The `await stat(absolute)` that used to sit here checked existence and threw its result
      // away — and `readFile` below already fails when the file is gone. So the only thing the
      // extra lookup added was a window in which the path could resolve to a different file
      // between the check and the read (CodeQL js/file-system-race #20). One lookup has no
      // window: parsimony ladder rung 1, the cheapest fix is the operation nobody needed.
      const content = await readFile(absolute, "utf8");
      const tokens = tokenizeContent(content);
      results.push({ ...source, status: "included", tokens });
    } catch {
      results.push({ ...source, status: "excluded", tokens: [] });
    }
  }
  return results;
}

function isExcluded(path: string, excludes: string[] | undefined): boolean {
  if (excludes === undefined) return false;
  return excludes.some((pattern) => matchesGlob(pattern, path));
}

function matchesGlob(pattern: string, path: string): boolean {
  // Simple glob: "**/.env" → path ends with ".env"; "**/secrets/**" → contains "/secrets/"
  if (pattern === path) return true;
  if (pattern.startsWith("**/") && pattern.endsWith("/**")) {
    const middle = pattern.slice(3, -3);
    return path.includes(middle);
  }
  if (pattern.startsWith("**/")) {
    return path.endsWith(pattern.slice(3));
  }
  if (pattern.endsWith("/**")) {
    return path.startsWith(pattern.slice(0, -3));
  }
  return false;
}

function tokenizeContent(content: string): string[] {
  return content.split(/\s+/).filter((token) => token.length > 0);
}

function sameScope(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}
