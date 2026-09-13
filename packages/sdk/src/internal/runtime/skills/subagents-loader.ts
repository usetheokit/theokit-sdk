import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ConfigurationError } from "../../../errors.js";
import type { AgentDefinition } from "../../../types/agent.js";
import type { ModelSelection } from "../../../types/agent-prims.js";
import { diag } from "../../diagnostics.js";
import { projectConfigRoots } from "../../persistence/paths.js";
import type { CompatSourceDeclaration } from "../compat/foreign-config-sources.js";
import { readWorkspaceDir } from "../config/workspace-dir.js";
import { type FrontmatterValue, parseSimpleYaml } from "../context/yaml-frontmatter.js";
import { pluginBundleDirs } from "../plugin-loader/plugin-bundles.js";

/**
 * Load file-based subagents from `.theokit/agents/*.md` and merge with
 * inline definitions. Inline overrides file-based on name conflict.
 *
 * Each markdown file has YAML frontmatter (description + optional model)
 * and a body that becomes the subagent prompt.
 *
 * @internal
 */
export async function loadSubagents(
  cwd: string,
  settingSourcesIncludeProject: boolean,
  inline: Record<string, AgentDefinition> | undefined,
  /** Declared foreign dialects (#524). Empty reads `.theokit/` only. */
  compatSources: readonly CompatSourceDeclaration[] = [],
): Promise<Record<string, AgentDefinition>> {
  const result: Record<string, AgentDefinition> = {};
  if (settingSourcesIncludeProject) {
    const projectAgents = await readProjectSubagents(cwd, compatSources);
    for (const [name, definition] of Object.entries(projectAgents)) {
      result[name] = definition;
    }
  }
  if (inline !== undefined) {
    for (const [name, definition] of Object.entries(inline)) {
      result[name] = definition;
    }
  }
  return result;
}

/**
 * Read agent declarations from every project config root (`.theokit`, then `.claude`).
 *
 * FIRST occurrence of a name wins, which is what makes `projectConfigRoots`' order a contract rather
 * than a detail: a project declaring the same agent in both means the explicit namespace.
 */
async function readProjectSubagents(
  cwd: string,
  compatSources: readonly CompatSourceDeclaration[],
): Promise<Record<string, AgentDefinition>> {
  const subagents: Record<string, AgentDefinition> = {};
  for (const configRoot of projectConfigRoots(cwd, compatSources, "subagents")) {
    await readSubagentsFrom(join(configRoot, "agents"), subagents);
  }
  // A Claude Code plugin is a BUNDLE, and its `agents/` is what it exists to contribute. Read after
  // the project's own, so a project can shadow an agent a plugin ships without editing the plugin.
  for (const bundle of await pluginBundleDirs(cwd, compatSources)) {
    await readSubagentsFrom(join(bundle, "agents"), subagents);
  }
  return subagents;
}

async function readSubagentsFrom(
  root: string,
  subagents: Record<string, AgentDefinition>,
): Promise<void> {
  const entries = await readWorkspaceDir(root, "subagents_read_error", "subagents directory");
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const path = join(root, entry.name);
    const raw = await readFile(path, "utf8");
    // A markdown file with NO frontmatter is not an agent declaration — a directory of agents
    // written for the Claude Code CLI conventionally carries documentation beside them, and
    // `.claude/agents/README.md` exists in this repository. Throwing on it made ONE such file stop
    // every agent in the directory from loading.
    //
    // Skipped with a warn rather than in silence, and ONLY for the no-frontmatter case: a file that
    // HAS frontmatter and gets it wrong is a broken agent and still fails loudly, which is what
    // keeps a typo'd `sandbox` from returning as a silent gate through this door.
    if (!hasFrontmatter(raw)) {
      diag(`[theokit-sdk] ${entry.name} has no frontmatter — not an agent declaration, skipping`);
      continue;
    }
    const definition = parseSubagentMarkdown(raw, entry.name);
    if (subagents[definition.name] === undefined) {
      // `path` is computed above to read the file and was then dropped. Keeping it is the whole
      // visibility fix (#524): without it a listing cannot say which root an agent came from.
      subagents[definition.name] = { ...definition.definition, source: path };
    }
  }
}

// The frontmatter keys a disk subagent may declare. Any other key is a typed load
// error rather than a silent drop — a dropped `sandbox` an operator wrote believing
// it confines the child is exactly the silent-gate failure class this guards against.
const ACCEPTED_FIELDS = new Set([
  "name",
  "description",
  "model",
  "tools",
  "reasoning_effort",
  "mcp",
  "sandbox",
]);

// Fields the Claude Code CLI writes that carry NO behaviour for this runtime. Accepted and ignored,
// so an agent authored for the CLI loads here unchanged — measured 2026-08-26 across the 59 agent
// files on one machine, where `color` appeared in 38 of them and made every one of those a
// `subagent_unknown_field` load error.
//
// Named explicitly instead of loosening the check above, because that check's reason is sound: a
// dropped `sandbox` an operator wrote believing it confines the child is a silent gate. A field that
// COULD change behaviour must still fail loudly. This set is the difference between "we know this
// one and it does nothing" and "we have never heard of this" — two facts a bare allow-everything
// would collapse into one.
//
// Anything added here needs the same justification: inert for THIS runtime, not merely unfamiliar.
const INERT_CLAUDE_CODE_FIELDS = new Set([
  /** The CLI's label colour for the agent. Presentation only. */
  "color",
]);

function parseSubagentMarkdown(
  raw: string,
  filename: string,
): { name: string; definition: AgentDefinition } {
  const { frontmatter, body } = splitFrontmatter(raw, filename);
  const fields = parseFrontmatterFields(frontmatter);
  rejectUnknownFields(fields, filename);
  rejectMcp(fields, filename);

  const definition: AgentDefinition = {
    description: asString(fields.description) ?? "",
    prompt: body,
  };
  const model = resolveModel(fields, filename);
  if (model !== undefined) definition.model = model;
  const tools = toStringList(fields.tools);
  if (tools.length > 0) definition.tools = tools;
  const sandbox = resolveSandbox(fields, filename);
  if (sandbox !== undefined) definition.sandbox = sandbox;

  const name = asString(fields.name) ?? filename.replace(/\.md$/, "");
  return { name, definition };
}

/**
 * Frontmatter keys that Claude Code documents for a subagent and this runtime does not accept.
 *
 * Not an allow-list — every one of these still fails the load. It exists so the FAILURE can say
 * which kind of unknown it met. A user migrating a `.claude/agents/` tree used to learn one key per
 * round trip: fix `memory`, meet `permissionMode`, fix that, meet `maxTurns` — with nothing saying
 * the set was finite or that the tree was simply written for another runtime.
 *
 * The distinction this file already draws for `INERT_CLAUDE_CODE_FIELDS` is the same one: "the
 * difference between 'we know this one and it does nothing' and 'we have never heard of this' — two
 * facts a bare allow-everything would collapse into one." This is the third fact beside them —
 * "another runtime's field" — and it changes only the message, never the verdict.
 */
const KNOWN_CLAUDE_CODE_FIELDS = new Set([
  "disallowedTools",
  "permissionMode",
  "maxTurns",
  "skills",
  "memory",
  "background",
  "effort",
  "isolation",
  "initialPrompt",
  "hooks",
  "experimental",
  "mcpServers",
]);

function rejectUnknownFields(
  fields: Record<string, FrontmatterValue | undefined>,
  filename: string,
): void {
  for (const key of Object.keys(fields)) {
    if (INERT_CLAUDE_CODE_FIELDS.has(key)) continue;
    if (!ACCEPTED_FIELDS.has(key)) {
      const siblings = [...KNOWN_CLAUDE_CODE_FIELDS].filter((f) => f !== key);
      const origin = KNOWN_CLAUDE_CODE_FIELDS.has(key)
        ? ` — "${key}" is a Claude Code subagent field that this runtime does not support. ` +
          `The same applies to: ${siblings.join(", ")}. Removing them one at a time will meet each ` +
          `in turn; the tree is written for another runtime`
        : "";
      throw new ConfigurationError(
        `Subagent ${filename}: unknown frontmatter field "${key}" (accepted: ${[...ACCEPTED_FIELDS].join(", ")})${origin}`,
        { code: "subagent_unknown_field" },
      );
    }
  }
}

// mcp: a known field, but not yet honored on the LOCAL delegation path. The frontmatter YAML can only
// express server NAMES (parseSimpleYaml has no nested-object support), while a child's `Agent.create`
// needs `mcpServers` as a Record<name, config>; resolving names→config per-subagent in local delegation
// is its own follow-up. Rather than silently drop it (the M26/M32 silent-gate class), it is a typed load
// error that names the field and points at the alternative.
function rejectMcp(fields: Record<string, FrontmatterValue | undefined>, filename: string): void {
  if (fields.mcp !== undefined) {
    throw new ConfigurationError(
      `Subagent ${filename}: per-subagent "mcp" is not yet supported on the local delegation path; declare MCP servers in .theokit/mcp.json (or the parent) instead`,
      { code: "subagent_mcp_unsupported_local" },
    );
  }
}

// model + reasoning_effort — effort rides inside `model.params[thinking]`, so it requires a concrete
// model id to attach to (a child inheriting the parent's model cannot carry the parent's provider-
// specific effort param safely).
function resolveModel(
  fields: Record<string, FrontmatterValue | undefined>,
  filename: string,
): ModelSelection | "inherit" | undefined {
  const modelId = asString(fields.model);
  const effort = asString(fields.reasoning_effort);
  // reasoning_effort rides in model.params[thinking], so it needs a CONCRETE model id to attach to.
  // Neither an absent model NOR `model: inherit` can carry it (the inherited id is unknown at load), so
  // both are typed errors rather than a silently-dropped effort — the silent-gate class this guards.
  if (effort !== undefined && (modelId === undefined || modelId === "inherit")) {
    throw new ConfigurationError(
      `Subagent ${filename}: reasoning_effort requires a concrete model (effort is a model parameter; an absent model or "inherit" cannot carry it)`,
      { code: "subagent_reasoning_effort_without_model" },
    );
  }
  if (modelId === undefined) return undefined;
  if (modelId === "inherit") return "inherit";
  return effort !== undefined
    ? { id: modelId, params: [{ id: "thinking", value: effort }] }
    : { id: modelId };
}

// sandbox: boolean only. A granular mode string (read-only/…) is unsupported by the SDK runtime and is
// a typed error rather than a silent coercion to a boolean.
function resolveSandbox(
  fields: Record<string, FrontmatterValue | undefined>,
  filename: string,
): boolean | undefined {
  if (fields.sandbox === undefined) return undefined;
  if (typeof fields.sandbox !== "boolean") {
    throw new ConfigurationError(
      `Subagent ${filename}: sandbox must be a boolean (got "${String(fields.sandbox)}"); granular sandbox modes are not supported by the runtime`,
      { code: "subagent_sandbox_not_boolean" },
    );
  }
  return fields.sandbox;
}

function asString(v: FrontmatterValue | undefined): string | undefined {
  if (typeof v !== "string") return undefined;
  // parseSimpleYaml does not strip quotes (documented), and `model`/`reasoning_effort` are fields users
  // habitually quote (`model: "openai/gpt-4o"`). Strip a single matching surrounding quote pair so a
  // quoted id/effort does not slip past validation and fail only at the provider.
  const m = /^(["'])(.*)\1$/.exec(v);
  return m ? m[2] : v;
}

/** Accept a YAML list (`string[]`) or a comma/space-separated scalar; trim + drop empties. */
function toStringList(v: FrontmatterValue | undefined): string[] {
  if (Array.isArray(v)) return v.map((t) => t.trim()).filter((t) => t.length > 0);
  if (typeof v === "string") {
    return v
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }
  return [];
}

/** Does this file open with a frontmatter block at all? Its ABSENCE means "not an agent". */
function hasFrontmatter(raw: string): boolean {
  return /^---\s*\n/.test(raw);
}

function splitFrontmatter(raw: string, filename: string): { frontmatter: string; body: string } {
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/.exec(raw);
  if (match === null) {
    throw new ConfigurationError(`Subagent ${filename} is missing frontmatter`, {
      code: "subagent_missing_frontmatter",
    });
  }
  return { frontmatter: match[1] ?? "", body: (match[2] ?? "").trim() };
}

function parseFrontmatterFields(frontmatter: string): Record<string, FrontmatterValue | undefined> {
  // Preserve the rich YAML value types (boolean/number/string[]): `sandbox: true` and
  // `mcp: [a, b]` are meaningful here, so narrowing everything to string (as the
  // pre-M33 loader did) would drop them. Per-field validation happens in parseSubagentMarkdown.
  return parseSimpleYaml(frontmatter);
}
