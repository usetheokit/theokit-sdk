import type { AgentOptions } from "../../types/agent.js";
import { diag } from "../diagnostics.js";
import { enabledPluginNames } from "../plugins/enabled-names.js";
import { normalizeModel } from "../runtime/model-selection.js";
import type {
  CloudAgentPayload,
  McpHttpRedacted,
  McpStdioRedacted,
  MemoryPayload,
  ProvidersRedacted,
  SubagentRef,
} from "./types.js";

/**
 * Pure JSON serializer for the cloud-agent payload (ADR D15, T1.1).
 *
 * Per-feature allow-list (EC-2): every field forwarded to PaaS is explicitly
 * picked from `AgentOptions`. Fields containing secrets (`apiKey`,
 * `headers.Authorization`, mcp `env`, provider-route credentials) are NEVER
 * forwarded, even if present in input.
 *
 * Determinism (EC-1): `canonicalize()` recursively sorts object keys before
 * `JSON.stringify`. Identical conceptual inputs produce byte-identical JSON
 * regardless of insertion order.
 *
 * Size guardrail (EC-7): payloads larger than 1 MB emit a stderr warning
 * (no throw — pure observability).
 *
 * @internal
 */

const MAX_PAYLOAD_BYTES = 1_048_576; // 1 MB

export function serializeCloudAgentConfig(options: AgentOptions): CloudAgentPayload {
  if (options.cloud === undefined) {
    throw new Error("serializeCloudAgentConfig called without options.cloud");
  }
  const payload: CloudAgentPayload = {
    schemaVersion: "1.0",
    cloud: serializeCloud(options.cloud),
  };
  if (typeof options.agentId === "string") payload.agentId = options.agentId;
  const cfgModel = normalizeModel(options.model);
  if (cfgModel !== undefined) payload.model = { id: cfgModel.id };
  if (typeof options.systemPrompt === "string") payload.systemPrompt = options.systemPrompt;
  const skills = serializeSkills(options.skills);
  if (skills !== undefined) payload.skills = skills;
  const plugins = serializePlugins(options.plugins);
  if (plugins !== undefined) payload.plugins = plugins;
  const mcp = serializeMcp(options.mcpServers);
  if (mcp !== undefined) payload.mcpServers = mcp;
  const agents = serializeAgents(options.agents);
  if (agents !== undefined) payload.agents = agents;
  const providers = serializeProviders(options.providers);
  if (providers !== undefined) payload.providers = providers;
  const memory = serializeMemory(options.memory);
  if (memory !== undefined) payload.memory = memory;
  return payload;
}

/**
 * Stringify a payload to canonical JSON. Object keys are sorted
 * recursively before stringify (EC-1). Emits a stderr warning when the
 * result exceeds {@link MAX_PAYLOAD_BYTES} (EC-7).
 *
 * @internal
 */
export function stringifyCloudPayload(payload: CloudAgentPayload): string {
  const sorted = canonicalize(payload);
  const json = JSON.stringify(sorted);
  const size = Buffer.byteLength(json, "utf8");
  if (size > MAX_PAYLOAD_BYTES) {
    diag(
      `[theokit-sdk] cloud agent payload is ${size} bytes (>1 MB) — PaaS may reject large payloads. Consider trimming subagents/context.\n`,
    );
  }
  return json;
}

/**
 * Recursively sort object keys for deterministic stringify (EC-1).
 *
 * @internal
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function serializeCloud(cloud: NonNullable<AgentOptions["cloud"]>): CloudAgentPayload["cloud"] {
  const repos = (cloud.repos ?? []).map((r) => {
    const entry: { url: string; startingRef?: string } = { url: r.url };
    if (typeof r.startingRef === "string") entry.startingRef = r.startingRef;
    return entry;
  });
  const result: CloudAgentPayload["cloud"] = { repos };
  if (cloud.autoCreatePR === true) result.autoCreatePR = true;
  return result;
}

function serializeSkills(skills: AgentOptions["skills"]): CloudAgentPayload["skills"] | undefined {
  // SE22 — a SkillsResolver function is rejected for cloud upstream
  // (validateCloudToolParity); guard here too so the type narrows cleanly.
  if (typeof skills === "function") return undefined;
  if (skills?.enabled === undefined || skills.enabled.length === 0) return undefined;
  return { enabled: [...skills.enabled] };
}

function serializePlugins(
  plugins: AgentOptions["plugins"],
): CloudAgentPayload["plugins"] | undefined {
  const enabled = enabledPluginNames(plugins);
  if (enabled.length === 0) return undefined;
  return { enabled: [...enabled] };
}

function serializeMcp(
  mcpServers: AgentOptions["mcpServers"],
): CloudAgentPayload["mcpServers"] | undefined {
  if (mcpServers === undefined) return undefined;
  const result: Record<string, McpHttpRedacted | McpStdioRedacted> = {};
  for (const [name, raw] of Object.entries(mcpServers)) {
    const entry = serializeMcpEntry(raw);
    if (entry !== undefined) result[name] = entry;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function toolsField(tools: McpHttpRedacted["tools"]): Pick<McpHttpRedacted, "tools"> {
  if (!tools) return {};
  const picked: NonNullable<McpHttpRedacted["tools"]> = {};
  if (tools.include) picked.include = [...tools.include];
  if (tools.exclude) picked.exclude = [...tools.exclude];
  return { tools: picked };
}

function serializeMcpEntry(raw: unknown): McpHttpRedacted | McpStdioRedacted | undefined {
  const config = raw as {
    type?: string;
    url?: string;
    command?: string;
    args?: unknown;
    tools?: McpHttpRedacted["tools"];
  };
  if (config.type === "http" && typeof config.url === "string") {
    // EC-2: only `url` + `type` cross to PaaS. Drop headers (Authorization),
    // any other caller-side fields.
    return { type: "http", url: config.url, ...toolsField(config.tools) };
  }
  if (
    (config.type === "stdio" || config.type === undefined) &&
    typeof config.command === "string"
  ) {
    // EC-2: drop env entirely (TOKEN, SECRET, etc.). Drop cwd (caller FS).
    const entry: McpStdioRedacted = { type: "stdio", command: config.command };
    if (Array.isArray(config.args)) entry.args = config.args.map((a) => String(a));
    Object.assign(entry, toolsField(config.tools));
    return entry;
  }
  return undefined;
}

function serializeAgents(agents: AgentOptions["agents"]): CloudAgentPayload["agents"] | undefined {
  if (agents === undefined) return undefined;
  const result: Record<string, SubagentRef> = {};
  for (const [name, def] of Object.entries(agents)) {
    if (def === undefined || def === null) continue;
    result[name] = buildSubagentRef(def);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function buildSubagentRef(def: NonNullable<AgentOptions["agents"]>[string]): SubagentRef {
  const ref: SubagentRef = {};
  if (typeof def.description === "string") ref.description = def.description;
  if (typeof def.prompt === "string") ref.systemPrompt = def.prompt;
  if (def.model !== undefined && def.model !== "inherit" && typeof def.model.id === "string") {
    ref.model = { id: def.model.id };
  }
  return ref;
}

function serializeProviders(providers: AgentOptions["providers"]): ProvidersRedacted | undefined {
  if (providers === undefined) return undefined;
  const result: ProvidersRedacted = {};
  if (Array.isArray(providers.routes)) {
    // EC-2: route entries strip any credential field; only provider/model cross.
    result.routes = providers.routes.map((r) => {
      const route: { provider: string; model?: string } = { provider: r.provider };
      if (typeof r.model === "string") route.model = r.model;
      return route;
    });
  }
  if (Array.isArray(providers.fallback)) {
    result.fallback = [...providers.fallback];
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function serializeMemory(memory: AgentOptions["memory"]): MemoryPayload | undefined {
  if (memory === undefined) return undefined;
  const result: MemoryPayload = { enabled: memory.enabled === true };
  if (memory.index?.backend !== undefined || memory.index?.embedding !== undefined) {
    const index: MemoryPayload["index"] = { backend: memory.index?.backend ?? "sqlite-vec" };
    if (memory.index?.embedding !== undefined) {
      // EC-2: embedding config only forwards provider + model. Adapter
      // credentials live in the PaaS-side keystore, never in the payload.
      const emb: { provider: string; model?: string } = {
        provider: memory.index.embedding.provider,
      };
      if (typeof memory.index.embedding.model === "string") {
        emb.model = memory.index.embedding.model;
      }
      index.embedding = emb;
    }
    result.index = index;
  }
  return result;
}
