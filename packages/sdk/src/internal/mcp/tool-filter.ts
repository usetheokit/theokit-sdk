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

/** The slice of `McpClient` the filter needs; structural, so this module does not import `client.ts`. */
interface FilterableClient {
  readonly name: string;
  readonly sequential?: boolean;
  initialize(): Promise<void>;
  listTools(): Promise<Array<{ name: string }>>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
  call?(method: string, params: Record<string, unknown>): Promise<unknown>;
}

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
export function withToolFilter<C extends FilterableClient>(
  client: C,
  serverName: string,
  filter: McpToolFilter | undefined,
): C {
  if (filter === undefined) return client;
  const include = filter.include === undefined ? undefined : new Set(filter.include);
  const exclude = new Set(filter.exclude ?? []);
  const allowed = (name: string): boolean =>
    (include === undefined || include.has(name)) && !exclude.has(name);
  const refusal = (name: string) => ({
    content: [
      {
        type: "text" as const,
        text: `Tool "${name}" is not available on MCP server "${serverName}"`,
      },
    ],
    isError: true,
  });
  let warned = false;
  const filtered = {
    get name() {
      return client.name;
    },
    get sequential() {
      return client.sequential;
    },
    initialize: () => client.initialize(),
    close: () => client.close(),
    ...(client.call === undefined
      ? {}
      : {
          // A raw `tools/call` goes through the same gate; every other method passes untouched.
          call: async (method: string, params: Record<string, unknown>) => {
            const target = method === "tools/call" ? String(params.name) : undefined;
            if (target !== undefined && !allowed(target)) return { result: refusal(target) };
            return client.call?.(method, params);
          },
        }),
    async listTools() {
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
    async callTool(name: string, args: Record<string, unknown>) {
      if (!allowed(name)) return refusal(name);
      return client.callTool(name, args);
    },
  };
  return filtered as unknown as C;
}
