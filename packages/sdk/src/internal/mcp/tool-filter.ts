/**
 * Per-server MCP tool include/exclude filter.
 *
 * Kept apart from `client.ts` so the client stays small. The filter wraps an `McpClient`: it trims
 * the `tools/list` result and refuses a call to a filtered-out name before any request is sent.
 * Names are the server's own, before any SDK prefixing.
 *
 * @internal
 */
import { ConfigurationError } from "../../errors.js";
import type { McpServerConfig } from "../../types/mcp.js";
import { diag } from "../diagnostics.js";
import type { McpClient, McpTool, McpToolCallResult } from "./client.js";

export type McpToolFilter = NonNullable<McpServerConfig["tools"]>;

function checkList(serverName: string, field: string, list: unknown): void {
  const ok =
    list === undefined ||
    (Array.isArray(list) && list.every((n) => typeof n === "string" && n.length > 0));
  if (ok) return;
  throw new ConfigurationError(
    `MCP server "${serverName}": tools.${field} must be an array of non-empty strings`,
    { code: "invalid_mcp_tool_filter" },
  );
}

/** Throws `invalid_mcp_tool_filter` when a server's `tools` filter is malformed. */
export function validateMcpToolFilter(serverName: string, config: McpServerConfig): void {
  const tools = (config as { tools?: unknown }).tools;
  if (tools === undefined) return;
  if (typeof tools !== "object" || tools === null || Array.isArray(tools)) {
    throw new ConfigurationError(`MCP server "${serverName}": tools must be an object`, {
      code: "invalid_mcp_tool_filter",
    });
  }
  checkList(serverName, "include", (tools as McpToolFilter).include);
  checkList(serverName, "exclude", (tools as McpToolFilter).exclude);
}

/** Wraps `client` so only the tools the filter allows are listed or callable. */
export function withToolFilter(
  client: McpClient,
  serverName: string,
  filter: McpToolFilter | undefined,
): McpClient {
  if (filter === undefined) return client;
  const include = filter.include === undefined ? undefined : new Set(filter.include);
  const exclude = new Set(filter.exclude ?? []);
  const allowed = (name: string): boolean =>
    (include === undefined || include.has(name)) && !exclude.has(name);
  let warned = false;
  return {
    get name() {
      return client.name;
    },
    get sequential() {
      return client.sequential;
    },
    initialize: () => client.initialize(),
    close: () => client.close(),
    ...(client.call === undefined ? {} : { call: client.call.bind(client) }),
    async listTools(): Promise<McpTool[]> {
      const listed = await client.listTools();
      if (include !== undefined && !warned) {
        warned = true;
        const present = new Set(listed.map((t) => t.name));
        for (const name of include) {
          if (!present.has(name)) {
            diag(
              `[theokit-sdk] mcp server "${serverName}": tools.include names "${name}", which the server does not list\n`,
            );
          }
        }
      }
      return listed.filter((t) => allowed(t.name));
    },
    async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
      if (!allowed(name)) {
        return {
          content: [
            { type: "text", text: `Tool "${name}" is not available on MCP server "${serverName}"` },
          ],
          isError: true,
        };
      }
      return client.callTool(name, args);
    },
  };
}
