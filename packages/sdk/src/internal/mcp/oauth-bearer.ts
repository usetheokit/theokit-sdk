/**
 * Resolves the `Authorization` value an HTTP MCP server's `auth.oauth` declares.
 *
 * Stored token still valid -> used. Expired with a refresh token -> refreshed (one refresh in
 * flight per server). Otherwise the PKCE flow runs and its result is stored.
 *
 * @internal
 */
import type { McpAuthConfig, McpOAuthConfig } from "../../types/mcp.js";
import { refreshAccessToken, runPkceFlow } from "./oauth.js";
import { getTokens, lockedRefresh, type OAuthTokens, setTokens } from "./token-storage.js";

/** Slack so a token is not sent in the last moments of its life. */
const EXPIRY_SKEW_MS = 30_000;

async function obtain(
  serverName: string,
  clientId: string,
  scopes: string[] | undefined,
  oauth: McpOAuthConfig,
): Promise<OAuthTokens> {
  const stored = await getTokens(serverName);
  if (stored?.accessToken !== undefined && stored.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
    return stored;
  }
  const refreshToken = stored?.refreshToken;
  if (refreshToken !== undefined) {
    try {
      return await lockedRefresh(serverName, () =>
        refreshAccessToken(serverName, clientId, refreshToken, oauth),
      );
    } catch {
      // Refresh refused (revoked, expired): fall through to a fresh authorization.
    }
  }
  const fresh = await runPkceFlow(serverName, clientId, scopes, oauth);
  await setTokens(serverName, fresh);
  return fresh;
}

/** `Bearer <token>` for the server, obtained through the declared OAuth flow. */
export async function resolveBearer(serverName: string, auth: McpAuthConfig): Promise<string> {
  if (auth.oauth === undefined)
    throw new Error(`MCP server "${serverName}" declares no auth.oauth`);
  const tokens = await obtain(serverName, auth.CLIENT_ID, auth.scopes, auth.oauth);
  return `Bearer ${tokens.accessToken}`;
}
