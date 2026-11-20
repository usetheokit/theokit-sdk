import packageJson from "../../../package.json" with { type: "json" };
import { NetworkError } from "../../errors.js";

export const SUPPORTED_MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export type McpProtocolVersion = (typeof SUPPORTED_MCP_PROTOCOL_VERSIONS)[number];

function isSupportedVersion(value: unknown): value is McpProtocolVersion {
  return (SUPPORTED_MCP_PROTOCOL_VERSIONS as readonly unknown[]).includes(value);
}

type RpcRequester = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/** Sends `initialize`, checks the answered revision and returns it. @internal */
export async function rpcInitialize(
  request: RpcRequester,
  name: string,
  offered: McpProtocolVersion,
): Promise<McpProtocolVersion | undefined> {
  const response = await request("initialize", {
    protocolVersion: offered,
    capabilities: { tools: {} },
    clientInfo: { name: "theokit-sdk", version: packageJson.version },
  });
  const answered = (response as { result?: { protocolVersion?: unknown } } | undefined)?.result
    ?.protocolVersion;
  // A reply with no version at all (a minimal or legacy server) is tolerated: nothing is negotiated
  // and no header is sent. Only an explicit answer outside the supported list is refused.
  if (answered === undefined) return undefined;
  if (!isSupportedVersion(answered)) {
    throw new NetworkError(
      `MCP ${name} answered protocol version ${String(answered)}, which this client does not support (offered ${offered})`,
      { code: "mcp_protocol_unsupported" },
    );
  }
  return answered;
}
