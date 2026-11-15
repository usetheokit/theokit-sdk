import type { McpStdioServerConfig } from "../../types/mcp.js";
import { diag } from "../diagnostics.js";
import type { McpTool, McpToolCallResult } from "./types.js";

/** @internal */
export type McpToolFilter = NonNullable<McpStdioServerConfig["tools"]>;

/** `include` (when set) must list the name; `exclude` then removes it. */
export function isToolAllowed(filter: McpToolFilter, name: string): boolean {
  if (filter.include !== undefined && !filter.include.includes(name)) return false;
  return !(filter.exclude ?? []).includes(name);
}

/** One warning per `include` name the server does not list, so a typo is visible. */
function warnUnlistedIncludes(server: string, filter: McpToolFilter, listed: McpTool[]): void {
  const names = new Set(listed.map((tool) => tool.name));
  for (const wanted of new Set(filter.include ?? [])) {
    if (names.has(wanted)) continue;
    diag(
      `[theokit-sdk] mcp tools.include names "${wanted}", which server "${server}" does not list\n`,
    );
  }
}

/** Filters a `tools/list` result by the server's `tools` config. */
export function applyToolFilter(
  server: string,
  filter: McpToolFilter | undefined,
  listed: McpTool[],
): McpTool[] {
  if (filter === undefined) return listed;
  warnUnlistedIncludes(server, filter, listed);
  return listed.filter((tool) => isToolAllowed(filter, tool.name));
}

/** A tool error for a filtered-out call, or `undefined` when the call may go ahead. */
export function refuseFilteredCall(
  server: string,
  filter: McpToolFilter | undefined,
  name: string,
): McpToolCallResult | undefined {
  if (filter === undefined || isToolAllowed(filter, name)) return undefined;
  return {
    content: [
      {
        type: "text",
        text: `MCP tool "${name}" on server "${server}" is filtered out by the server's tools include/exclude config`,
      },
    ],
    isError: true,
  };
}

/** The listed names the filter withholds, so a forced call of one can be refused by name. */
export function filteredToolNames(
  filter: McpToolFilter | undefined,
  listed: McpTool[],
): readonly string[] {
  if (filter === undefined) return [];
  return listed.filter((tool) => !isToolAllowed(filter, tool.name)).map((tool) => tool.name);
}

/** The refusal for a raw `tools/call` request naming a filtered-out tool, else `undefined`. */
export function refuseFilteredRawCall(
  server: string,
  filter: McpToolFilter | undefined,
  method: string,
  params: Record<string, unknown>,
): McpToolCallResult | undefined {
  if (method !== "tools/call") return undefined;
  return refuseFilteredCall(server, filter, String(params.name));
}
