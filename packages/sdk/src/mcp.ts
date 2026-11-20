/**
 * Public MCP connection: `connectMcpServer` hands an app a connected client for a server's tools,
 * resources and prompts. Nothing is injected into an agent's context; the app decides what to use.
 *
 * @packageDocumentation
 */
import { ConfigurationError, NetworkError } from "./errors.js";
import {
  createMcpClient,
  type McpClient,
  type McpTool,
  type McpToolCallResult,
  SUPPORTED_MCP_PROTOCOL_VERSIONS,
} from "./internal/mcp/client.js";
import type { McpServerConfig } from "./types/mcp.js";

export type { McpTool, McpToolCallResult };

/** A resource a server publishes. */
export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/** One content block of a resource read: `text` or base64 `blob`. */
export interface McpResourceContents {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

/** A named prompt template a server publishes. */
export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

/** One message of a rendered prompt. */
export interface McpPromptMessage {
  role: "user" | "assistant";
  content: unknown;
}

/** A connected, initialized MCP server. */
export interface McpConnection {
  /** The protocol revision agreed in `initialize` (the offered one when the server named none). */
  readonly protocolVersion: string;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult>;
  /** Lists every resource, following `nextCursor` until exhausted. */
  listResources(): Promise<McpResource[]>;
  readResource(uri: string): Promise<McpResourceContents[]>;
  /** Lists every prompt, following `nextCursor` until exhausted. */
  listPrompts(): Promise<McpPrompt[]>;
  getPrompt(
    name: string,
    args?: Record<string, string>,
  ): Promise<{ description?: string; messages: McpPromptMessage[] }>;
  close(): Promise<void>;
}

type Capability = "resources" | "prompts";

function rpcResult(serverName: string, response: unknown): Record<string, unknown> {
  const msg = (response ?? {}) as {
    result?: Record<string, unknown>;
    error?: { message?: string };
  };
  if (msg.error !== undefined) {
    throw new NetworkError(
      `MCP ${serverName} returned an error: ${msg.error.message ?? "unknown error"}`,
      { code: "mcp_rpc_error" },
    );
  }
  return msg.result ?? {};
}

class Connection implements McpConnection {
  constructor(
    private readonly name: string,
    private readonly client: McpClient,
  ) {}

  get protocolVersion(): string {
    return this.client.protocolVersion ?? SUPPORTED_MCP_PROTOCOL_VERSIONS[0];
  }

  private async rpc(
    capability: Capability,
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (this.client.serverCapabilities?.[capability] === undefined) {
      throw new ConfigurationError(
        `MCP server "${this.name}" does not advertise the ${capability} capability`,
        { code: "mcp_capability_missing" },
      );
    }
    return rpcResult(this.name, await this.client.call?.(method, params));
  }

  private async paged<T>(capability: Capability, method: string, key: string): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.rpc(capability, method, cursor === undefined ? {} : { cursor });
      items.push(...((result[key] as T[] | undefined) ?? []));
      cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
    } while (cursor !== undefined);
    return items;
  }

  listTools(): Promise<McpTool[]> {
    return this.client.listTools();
  }

  callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    return this.client.callTool(name, args);
  }

  listResources(): Promise<McpResource[]> {
    return this.paged<McpResource>("resources", "resources/list", "resources");
  }

  async readResource(uri: string): Promise<McpResourceContents[]> {
    const result = await this.rpc("resources", "resources/read", { uri });
    return (result.contents as McpResourceContents[] | undefined) ?? [];
  }

  listPrompts(): Promise<McpPrompt[]> {
    return this.paged<McpPrompt>("prompts", "prompts/list", "prompts");
  }

  async getPrompt(
    name: string,
    args?: Record<string, string>,
  ): Promise<{ description?: string; messages: McpPromptMessage[] }> {
    const result = await this.rpc("prompts", "prompts/get", {
      name,
      ...(args === undefined ? {} : { arguments: args }),
    });
    const messages = (result.messages as McpPromptMessage[] | undefined) ?? [];
    return typeof result.description === "string"
      ? { description: result.description, messages }
      : { messages };
  }

  close(): Promise<void> {
    return this.client.close();
  }
}

/**
 * Connects to one MCP server (same timeouts, reconnect, OAuth and env policy as the agent loop) and
 * runs `initialize`. Close the connection when done.
 */
export async function connectMcpServer(
  name: string,
  config: McpServerConfig,
): Promise<McpConnection> {
  const client = createMcpClient(name, config);
  try {
    await client.initialize();
  } catch (err) {
    await client.close().catch(() => undefined);
    throw err;
  }
  return new Connection(name, client);
}
