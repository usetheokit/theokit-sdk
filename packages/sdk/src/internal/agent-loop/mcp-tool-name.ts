/** The name the model sees for an MCP server's tool. @internal */
export function mcpModelToolName(server: string, tool: string): string {
  return `mcp_${sanitizeMcpName(server)}_${sanitizeMcpName(tool)}`;
}

function sanitizeMcpName(name: string): string {
  return name.replace(/[^a-zA-Z0-9-]+/g, "_").replace(/^[_-]+|[_-]+$/g, "");
}
