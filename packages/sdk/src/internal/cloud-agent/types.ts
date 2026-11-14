/**
 * Canonical JSON contract that the SDK posts to TheoCloud at
 * `POST /v1/agents/{id}/runs`. PaaS reads this to reconstruct the agent's
 * tool catalog server-side (skills, plugins, hooks rules, MCP HTTP servers,
 * subagents, providers, memory, context).
 *
 * Locked at `schemaVersion: "1.0"`. Adding fields is forward-compatible;
 * removing or renaming requires a v2 ADR (see ADR D15).
 *
 * @internal
 */

export interface CloudAgentPayload {
  schemaVersion: "1.0";
  cloud: CloudPayloadCloud;
  agentId?: string;
  model?: { id: string };
  systemPrompt?: string;
  skills?: { enabled: ReadonlyArray<string> };
  plugins?: { enabled: ReadonlyArray<string> };
  hooks?: ReadonlyArray<HookRule>;
  mcpServers?: Record<string, McpHttpRedacted | McpStdioRedacted>;
  agents?: Record<string, SubagentRef>;
  providers?: ProvidersRedacted;
  memory?: MemoryPayload;
}

export interface CloudPayloadCloud {
  repos: ReadonlyArray<{ url: string; startingRef?: string }>;
  autoCreatePR?: boolean;
}

export interface HookRule {
  event: string;
  command?: string;
  reject?: string;
}

export interface McpHttpRedacted {
  type: "http";
  url: string;
  tools?: { include?: string[]; exclude?: string[] };
}

export interface McpStdioRedacted {
  type: "stdio";
  command: string;
  args?: ReadonlyArray<string>;
  tools?: { include?: string[]; exclude?: string[] };
}

export interface SubagentRef {
  description?: string;
  systemPrompt?: string;
  model?: { id: string };
}

export interface ProvidersRedacted {
  routes?: ReadonlyArray<{ provider: string; model?: string }>;
  fallback?: ReadonlyArray<string>;
}

export interface MemoryPayload {
  enabled: boolean;
  index?: {
    backend: "sqlite-vec" | "lance";
    embedding?: { provider: string; model?: string };
  };
}
