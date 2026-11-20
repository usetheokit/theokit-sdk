import pkg from "../../../package.json" with { type: "json" };
import { NetworkError } from "../../errors.js";
import type { McpProtocolVersion } from "../../types/mcp.js";

/** @internal */
/** MCP revisions this client speaks, newest first. */
export const SUPPORTED_MCP_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const satisfies readonly McpProtocolVersion[];
export type { McpProtocolVersion };

type RpcRequester = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/**
 * Run the `initialize` handshake and return the version the server agreed to.
 * A server that answers a version outside the supported list is refused. A reply that names no
 * version at all (a non-conforming server) is tolerated and yields `undefined`.
 */
export async function rpcInitialize(
  request: RpcRequester,
  offered: McpProtocolVersion,
): Promise<McpProtocolVersion | undefined> {
  const response = await request("initialize", {
    protocolVersion: offered,
    capabilities: { tools: {} },
    clientInfo: { name: "theokit-sdk", version: pkg.version },
  });
  const answered = (response as { result?: { protocolVersion?: unknown } } | undefined)?.result
    ?.protocolVersion;
  if (answered === undefined) return undefined;
  if (SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(answered as McpProtocolVersion)) {
    return answered as McpProtocolVersion;
  }
  throw new NetworkError(
    `MCP server answered protocol version ${String(answered)}, which this client does not support (offered ${offered}; supported: ${SUPPORTED_MCP_PROTOCOL_VERSIONS.join(", ")})`,
    { code: "mcp_protocol_unsupported" },
  );
}
