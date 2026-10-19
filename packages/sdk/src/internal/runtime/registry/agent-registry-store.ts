/**
 * Persistent agent registry (ADR D17).
 *
 * Per-cwd JSON file at `.theokit/agents/registry.json`. Atomic writes via
 * `replaceFileAtomic`. Secrets in `options` are stripped before persisting
 * (D17 + reuses the cloud-config-serializer allow-list philosophy).
 *
 * Multi-process write race is the documented limitation: one SDK process per
 * cwd (EC-10).
 *
 * @internal
 */

import { join } from "node:path";

import type { AgentOptions } from "../../../types/agent.js";
import type { ModelSelection } from "../../../types/agent-prims.js";
import { sweepStaleAtomicTemps } from "../../persistence/atomic-write.js";
import { withCwdMutex } from "../../persistence/cwd-mutex.js";
import { theokitConfigRoot } from "../../persistence/paths.js";
import { readVersionedJson, writeVersionedJson } from "../../persistence/schema-version.js";
import { asPluginsSettings } from "../../plugins/enabled-names.js";
import { normalizeModel } from "../model-selection.js";
import type { AgentRuntime, RegisteredAgent } from "./agent-registry-contract.js";

/** Current numeric schema version for the agent registry (ADR D62). */
const SCHEMA_VERSION = 1;
const LEGACY_SCHEMA_VERSION_STRING = "1.0";
// Kept as a project-relative SUFFIX: theokitConfigRoot(cwd) supplies the cwd-anchored root.
const REGISTRY_RELATIVE_SUFFIX = join("agents", "registry.json");

/** Legacy on-disk shape (pre-D62 — `schemaVersion` string field + flat `agents`). */
interface LegacyRegistryFile {
  schemaVersion?: string;
  agents?: Record<string, SerializedAgent>;
}

interface SerializedAgent {
  agentId: string;
  runtime: AgentRuntime;
  name?: string;
  summary?: string;
  model?: RegisteredAgent["model"];
  createdAt: number;
  lastModified: number;
  archived: boolean;
  options: SerializedAgentOptions;
  cwd?: string;
  repos?: string[];
  status?: RegisteredAgent["status"];
}

/**
 * Strips secrets from AgentOptions before persisting. Mirrors the allow-list
 * approach used by the cloud-config-serializer (ADR D15).
 *
 * @internal
 */
export function stripSecretsFromOptions(options: AgentOptions): SerializedAgentOptions {
  // EC-2: apiKey, mcpServers (may contain headers/env secrets), AgentOptions.tools
  // (custom-tool handlers are closures and cannot be serialized), hooks closures —
  // all explicitly NOT forwarded. The agent loop re-resolves these from env on
  // rehydration; custom tools must be re-passed via Agent.resume(id, { tools: [...] }).
  return assignDefined<SerializedAgentOptions>({
    name: options.name,
    model: (() => {
      const m = normalizeModel(options.model);
      return m !== undefined ? { id: m.id } : undefined;
    })(),
    systemPrompt: typeof options.systemPrompt === "string" ? options.systemPrompt : undefined,
    local: serializeLocal(options.local),
    cloud: serializeCloud(options.cloud),
    memory: serializeMemory(options.memory),
    // SE22 — a SkillsResolver function isn't serializable; persist only the static form.
    skills: serializeEnabledList(typeof options.skills === "function" ? undefined : options.skills),
    // Code-`Plugin` objects are closures and cannot be persisted (like custom
    // tools); only the named-enable settings form is serialized.
    plugins: serializeEnabledList(asPluginsSettings(options.plugins)),
    context: serializeContext(options.context),
    providers: serializeProviders(options.providers),
    agents: serializeAgents(options.agents),
  });
}

/** Drops `undefined` entries from a partial object, preserving the field shape. */
function assignDefined<T extends object>(partial: { [K in keyof T]?: T[K] | undefined }): T {
  const result = {} as T;
  for (const key of Object.keys(partial) as (keyof T)[]) {
    const value = partial[key];
    if (value !== undefined) result[key] = value as T[typeof key];
  }
  return result;
}

function serializeEnabledList(
  list: { enabled?: ReadonlyArray<string> } | undefined,
): { enabled?: ReadonlyArray<string> } | undefined {
  if (list === undefined) return undefined;
  return list.enabled !== undefined ? { enabled: [...list.enabled] } : {};
}

function serializeLocal(local: AgentOptions["local"]): SerializedAgentOptions["local"] | undefined {
  if (local === undefined) return undefined;
  const out: SerializedAgentOptions["local"] = {};
  if (typeof local.cwd === "string") out.cwd = local.cwd;
  if (Array.isArray(local.settingSources)) out.settingSources = [...local.settingSources];
  // #578 — same reason as `settingSources` beside it: the declaration is the operator's, and a
  // resume that forgets it degrades the agent without anybody having asked for that.
  if (Array.isArray(local.compatSources)) out.compatSources = [...local.compatSources];
  // Sandbox config — not a secret; needs to survive resume so that
  // safe-by-default doesn't silently regress to unsandboxed on restart.
  if (local.sandboxOptions !== undefined) {
    out.sandboxOptions = { enabled: local.sandboxOptions.enabled === true };
  }
  return out;
}

function serializeCloud(cloud: AgentOptions["cloud"]): SerializedAgentOptions["cloud"] | undefined {
  if (cloud === undefined) return undefined;
  return {
    repos: (cloud.repos ?? []).map((r) => ({
      url: r.url,
      ...(typeof r.startingRef === "string" ? { startingRef: r.startingRef } : {}),
    })),
    ...(cloud.autoCreatePR === true ? { autoCreatePR: true } : {}),
  };
}

function serializeMemory(
  memory: AgentOptions["memory"],
): SerializedAgentOptions["memory"] | undefined {
  if (memory === undefined) return undefined;
  const out: SerializedAgentOptions["memory"] = { enabled: memory.enabled === true };
  if (memory.namespace !== undefined) out.namespace = memory.namespace;
  if (memory.userId !== undefined) out.userId = memory.userId;
  if (memory.scope !== undefined) out.scope = memory.scope;
  if (memory.activeRecall !== undefined) out.activeRecall = { ...memory.activeRecall };
  if (memory.index !== undefined) out.index = serializeMemoryIndex(memory.index);
  // A count, not a secret. Without it a resumed agent comes back with no ceiling (B-380). Not
  // re-validated here: `Agent.resume` validates the merged value before the agent exists.
  if (memory.maxFacts !== undefined) out.maxFacts = memory.maxFacts;
  // A path, not a secret, kept as declared (a `~/` stays unexpanded and resolves against the home
  // of the process that resumes). Without it a resumed agent wrote, and counted its ceiling, in
  // the default store instead of the one it was created with (B-380).
  if (memory.directory !== undefined) out.directory = memory.directory;
  return out;
}

function serializeMemoryIndex(
  index: NonNullable<AgentOptions["memory"]>["index"],
): NonNullable<SerializedAgentOptions["memory"]>["index"] {
  const out: NonNullable<SerializedAgentOptions["memory"]>["index"] = {};
  if (index === undefined) return out;
  if (index.tools !== undefined) out.tools = index.tools;
  if (index.backend !== undefined) out.backend = index.backend;
  if (index.embedding !== undefined) {
    out.embedding = {
      provider: index.embedding.provider,
      ...(index.embedding.model !== undefined ? { model: index.embedding.model } : {}),
    };
  }
  return out;
}

function serializeContext(
  context: AgentOptions["context"],
): SerializedAgentOptions["context"] | undefined {
  if (context === undefined) return undefined;
  // Context manager config — no secrets, persists for Agent.resume rehydration.
  const out: NonNullable<SerializedAgentOptions["context"]> = {};
  if (context.manager !== undefined) out.manager = context.manager;
  if (context.maxTokens !== undefined) out.maxTokens = context.maxTokens;
  return out;
}

function serializeProviders(
  providers: AgentOptions["providers"],
): SerializedAgentOptions["providers"] | undefined {
  if (providers === undefined) return undefined;
  // Provider routing — capability/provider/model are public catalog entries.
  return {
    routes: providers.routes.map((r) => ({
      capability: r.capability,
      provider: r.provider,
      ...(r.model !== undefined ? { model: r.model } : {}),
    })),
    ...(providers.fallback !== undefined ? { fallback: [...providers.fallback] } : {}),
  };
}

function serializeAgents(
  agents: AgentOptions["agents"],
): SerializedAgentOptions["agents"] | undefined {
  if (agents === undefined) return undefined;
  // Subagents (inline `AgentDefinition` map) — persist description + prompt + model (WITH its params, so
  // per-subagent reasoning effort survives resume) + the security-relevant `tools` whitelist and
  // `sandbox` toggle. Dropping `tools`/`sandbox` was a default-open on resume: a confined child came back
  // unconfined. Subagent `mcpServers` MAY carry headers/env secrets, so they stay stripped.
  const out: NonNullable<SerializedAgentOptions["agents"]> = {};
  for (const [name, def] of Object.entries(agents)) {
    out[name] = {
      description: def.description,
      prompt: def.prompt,
      ...(def.model !== undefined ? { model: def.model } : {}),
      ...(def.tools !== undefined ? { tools: def.tools } : {}),
      ...(def.sandbox !== undefined ? { sandbox: def.sandbox } : {}),
    };
  }
  return out;
}

export interface SerializedAgentOptions {
  name?: string;
  model?: { id: string };
  systemPrompt?: string;
  local?: {
    cwd?: string;
    settingSources?: ReadonlyArray<string>;
    // #578 — a resumed agent must keep reading the foreign configuration surfaces it was created to
    // read. Dropped here ever since #524 introduced the field, so resume silently stopped honouring
    // a declaration the operator made: the agent's `.claude/` hooks, skills and subagents just
    // stopped being visible. Not a secret. Shaped rather than typed, because this is the
    // serialization boundary and the stored JSON outlives any one version of the declaration type.
    compatSources?: ReadonlyArray<unknown>;
    sandboxOptions?: { enabled: boolean };
  };
  cloud?: {
    repos: ReadonlyArray<{ url: string; startingRef?: string }>;
    autoCreatePR?: boolean;
  };
  memory?: {
    enabled: boolean;
    namespace?: string;
    userId?: string;
    scope?: string;
    index?: {
      tools?: boolean;
      backend?: string;
      embedding?: { provider: string; model?: string };
    };
    activeRecall?: Record<string, unknown>;
    maxFacts?: number;
    directory?: string;
  };
  skills?: { enabled?: ReadonlyArray<string> };
  plugins?: { enabled?: ReadonlyArray<string> };
  context?: { manager?: string; maxTokens?: number };
  providers?: {
    routes: ReadonlyArray<{ capability: string; provider: string; model?: string }>;
    fallback?: ReadonlyArray<string>;
  };
  agents?: Record<
    string,
    {
      description: string;
      prompt: string;
      model?: ModelSelection | "inherit";
      tools?: string[];
      sandbox?: boolean;
    }
  >;
}

function registryPath(cwd: string): string {
  return join(theokitConfigRoot(cwd), REGISTRY_RELATIVE_SUFFIX);
}

/**
 * Read the persisted registry from disk. Returns `{}` on missing file OR
 * malformed JSON (EC-4 — never throws on corrupt registry). Emits a stderr
 * warning when corruption is detected.
 *
 * @internal
 */
export async function loadRegistry(cwd: string): Promise<Record<string, SerializedAgent>> {
  // Collect leftover atomic-write temps before reading. A crash — or a test runner killing a worker
  // — between the write and the rename leaves `registry.json.<pid>.<hex>.tmp` behind, and nothing
  // swept them: 1,984 had accumulated in this package's own `.theokit/agents/` over three months.
  // Load is the right moment: it is the one place that already knows this path, it runs before any
  // write that could add another, and it is off the hot path. Failures are ignored by construction
  // — housekeeping must never fail the read it was attached to.
  void sweepStaleAtomicTemps(registryPath(cwd)).catch(() => undefined);
  return readVersionedJson<Record<string, SerializedAgent>>({
    path: registryPath(cwd),
    currentVersion: SCHEMA_VERSION,
    defaultValue: () => ({}),
    // EC-2 fix: `parsed` is the full object so we can detect + migrate legacy
    // shape `{ schemaVersion: "1.0", agents: {...} }` (no `_schemaVersion`,
    // no `data` wrapper).
    migrate: (parsed, _fromVersion) => {
      if (typeof parsed !== "object" || parsed === null) return {};
      const legacy = parsed as LegacyRegistryFile;
      if (legacy.schemaVersion === LEGACY_SCHEMA_VERSION_STRING && legacy.agents) {
        return legacy.agents;
      }
      return {};
    },
  });
}

/**
 * Write the registry to disk via `replaceFileAtomic` under a per-cwd mutex.
 * Coalesces concurrent in-process writes; cross-process writes still race
 * (EC-10 documented limitation).
 *
 * @internal
 */
export async function saveRegistry(
  cwd: string,
  agents: Record<string, RegisteredAgent>,
): Promise<void> {
  const serialized: Record<string, SerializedAgent> = {};
  for (const [id, agent] of Object.entries(agents)) {
    serialized[id] = toSerialized(agent);
  }
  const path = registryPath(cwd);
  await withCwdMutex(`registry:${cwd}`, async () => {
    // writeVersionedJson writes `{ _schemaVersion: N, data: serialized }`
    // atomically (parent dir auto-created via atomicWriteJson).
    await writeVersionedJson(path, serialized, SCHEMA_VERSION);
  });
}

function toSerialized(agent: RegisteredAgent): SerializedAgent {
  const out: SerializedAgent = {
    agentId: agent.agentId,
    runtime: agent.runtime,
    createdAt: agent.createdAt,
    lastModified: agent.lastModified,
    archived: agent.archived,
    options: stripSecretsFromOptions(agent.options),
  };
  if (agent.name !== undefined) out.name = agent.name;
  if (agent.summary !== undefined) out.summary = agent.summary;
  if (agent.model !== undefined) out.model = agent.model;
  if (agent.cwd !== undefined) out.cwd = agent.cwd;
  if (agent.repos !== undefined) out.repos = [...agent.repos];
  if (agent.status !== undefined) out.status = agent.status;
  return out;
}

/**
 * Rehydrate a SerializedAgent from disk into a RegisteredAgent shape.
 * Returns undefined when the persisted options can't be revived (e.g.,
 * `local.cwd` no longer exists — caller throws agent_rehydration_failed).
 *
 * @internal
 */
export function fromSerialized(entry: SerializedAgent): RegisteredAgent {
  return {
    agentId: entry.agentId,
    runtime: entry.runtime,
    name: entry.name,
    summary: entry.summary,
    model: entry.model,
    createdAt: entry.createdAt,
    lastModified: entry.lastModified,
    archived: entry.archived,
    options: entry.options as unknown as AgentOptions,
    cwd: entry.cwd,
    repos: entry.repos,
    status: entry.status,
  };
}
