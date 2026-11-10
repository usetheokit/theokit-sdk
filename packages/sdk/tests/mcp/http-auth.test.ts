import { afterEach, describe, expect, it, vi } from "vitest";

import { createMcpClient } from "../../src/internal/mcp/client.js";
import { _resetForTests, setTokens } from "../../src/internal/mcp/token-storage.js";
import { validateAgentOptions } from "../../src/internal/runtime/validation/validate-agent-options.js";
import type { McpAuthConfig } from "../../src/types/mcp.js";

const oauth = {
  authorizationEndpoint: "https://idp.test/authorize",
  tokenEndpoint: "https://idp.test/token",
  redirectMode: "manual" as const,
};
const auth: McpAuthConfig = { CLIENT_ID: "cid", oauth };

function mcpFetch(seen: Array<string | null>): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get("authorization"));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

afterEach(() => {
  _resetForTests();
  vi.unstubAllGlobals();
});

describe("HTTP MCP auth.oauth", () => {
  it("sends a stored valid token as Authorization", async () => {
    await setTokens("srv", {
      accessToken: "tok1",
      expiresAt: Date.now() + 3_600_000,
      obtainedAt: 0,
    });
    const seen: Array<string | null> = [];
    const client = createMcpClient(
      "srv",
      { type: "http", url: "http://x.test", auth },
      mcpFetch(seen),
    );
    await client.initialize();
    expect(seen[0]).toBe("Bearer tok1");
  });

  it("refreshes an expired token through the declared token endpoint", async () => {
    await setTokens("srv", { accessToken: "old", refreshToken: "r1", expiresAt: 1, obtainedAt: 0 });
    const tokenFetch = vi.fn(
      async () => new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600 })),
    );
    vi.stubGlobal("fetch", tokenFetch);
    const seen: Array<string | null> = [];
    const client = createMcpClient(
      "srv",
      { type: "http", url: "http://x.test", auth },
      mcpFetch(seen),
    );
    await client.initialize();
    expect(tokenFetch).toHaveBeenCalledWith(oauth.tokenEndpoint, expect.anything());
    expect(seen[0]).toBe("Bearer fresh");
  });
});

describe("unhonourable MCP auth is refused at create", () => {
  it("names the server when auth has no oauth", () => {
    expect(() =>
      validateAgentOptions({
        local: {},
        model: { id: "m" },
        mcpServers: { notion: { url: "http://x.test", auth: { CLIENT_ID: "c" } } },
      } as never),
    ).toThrow(/"notion"/);
  });

  it("refuses auth.oauth for a cloud agent", () => {
    expect(() =>
      validateAgentOptions({
        cloud: { repos: [] },
        mcpServers: { notion: { url: "http://x.test", auth } },
      } as never),
    ).toThrow(/"notion"/);
  });
});
