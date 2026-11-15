import type { McpTool, McpToolCallResult } from "./types.js";

/** JSON-RPC helpers shared by the stdio and http MCP clients. @internal */
export type RpcRequester = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export async function rpcInitialize(request: RpcRequester): Promise<void> {
  await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: { tools: {} },
    clientInfo: { name: "theokit-sdk", version: "0.0.0" },
  });
}

export async function rpcListTools(request: RpcRequester): Promise<McpTool[]> {
  const response = await request("tools/list", {});
  return (response as { result?: { tools?: McpTool[] } }).result?.tools ?? [];
}

export async function rpcCallTool(
  request: RpcRequester,
  name: string,
  args: Record<string, unknown>,
): Promise<McpToolCallResult> {
  const response = await request("tools/call", { name, arguments: args });
  const result = (response as { result?: McpToolCallResult }).result;
  if (result === undefined) {
    return { content: [{ type: "text", text: "MCP returned empty result" }], isError: true };
  }
  return result;
}
