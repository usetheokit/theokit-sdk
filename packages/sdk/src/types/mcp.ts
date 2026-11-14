/**
 * Owner: `internal/mcp/` (2 of 5 importers). Derived from the import graph, not declared —
 * `tests/lint/types-name-their-owner.test.ts` re-derives it.
 *
 */
import type { EnvPolicy } from "./env-policy.js";

/**
 * MCP server configuration accepted by `Agent.create()` and `agent.send()`.
 *
 * @public
 */
export type McpStdioServerConfig = {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Local agents only. Cloud rejects this field. */
  cwd?: string;
  /**
   * #59 — per-request timeout in ms. A request that gets no reply within this
   * window rejects with a typed `NetworkError` (`code: "mcp_timeout"`) instead
   * of hanging the agent loop forever. Default 30_000.
   */
  requestTimeoutMs?: number;
  /**
   * #54 — env inherit/scrub policy for the spawned MCP server process. Defaults
   * to `"inherit-scrubbed"` (drop secret-like host vars: `*KEY*`/`*SECRET*`/
   * `*TOKEN*`/`*PASSWORD*`/`*_AUTH*`/…) so a third-party MCP server binary cannot
   * exfiltrate host secrets via the environment. `env` above is merged AFTER the
   * policy and always wins. Pass `"all"` to restore full inheritance.
   */
  envPolicy?: EnvPolicy;
  /**
   * Run the calls a model makes to this server's tools in ONE step one at a time, in the order the
   * model listed them, instead of at once. Set it for a stateful server whose tools act on shared
   * state, such as a browser MCP server where a snapshot must wait for the navigation before it.
   * Calls to other servers or non-MCP tools in the same step are not held behind it. Default `false`.
   */
  sequential?: boolean;
  /**
   * Filter the tools this server offers. Names are the server's own (before any SDK prefixing).
   * `include` keeps only those names; `exclude` then removes names. A filtered-out tool is never
   * listed to the model and a call to it is refused before any request reaches the server.
   */
  tools?: {
    /** Only these tool names (as the server lists them) are offered. */
    include?: string[];
    /** These names are never offered. Applied after `include`. */
    exclude?: string[];
  };
};

/**
 * OAuth-style auth bundle for HTTP/SSE MCP servers.
 *
 * @public
 */
export interface McpAuthConfig {
  CLIENT_ID: string;
  CLIENT_SECRET?: string;
  scopes?: string[];
  /**
   * OAuth 2.1 PKCE flow configuration (ADR D41, v1.2+). When present, the
   * SDK runs the PKCE flow on first use and stores tokens via keychain or
   * file. Without this, the SDK relies on `CLIENT_SECRET` + manual headers.
   */
  oauth?: McpOAuthConfig;
}

/**
 * OAuth 2.1 PKCE flow descriptor. See ADR D41.
 *
 * @public
 */
export interface McpOAuthConfig {
  /** Authorization endpoint (e.g. https://api.notion.com/v1/oauth/authorize). */
  authorizationEndpoint: string;
  /** Token endpoint (e.g. https://api.notion.com/v1/oauth/token). */
  tokenEndpoint: string;
  /** Where the OAuth `code` is received. */
  redirectMode: "manual" | "localhost";
  /** Localhost callback port (0 = random free port, default). */
  localhostPort?: number;
  /** Flow timeout in ms (default 300_000 = 5min). */
  timeoutMs?: number;
}

/**
 * HTTP or SSE MCP server.
 *
 * @public
 */
export type McpHttpServerConfig = {
  type?: "http" | "sse";
  url: string;
  /** Passed through. `Authorization` works here. */
  headers?: Record<string, string>;
  auth?: McpAuthConfig;
  /**
   * #59 — per-request timeout in ms, enforced via `AbortSignal.timeout`. A
   * fetch that does not respond within this window rejects with a typed
   * `NetworkError` (`code: "mcp_timeout"`). Default 30_000.
   */
  requestTimeoutMs?: number;
  /**
   * Run the calls a model makes to this server's tools in ONE step one at a time, in the order the
   * model listed them, instead of at once. Set it for a stateful server whose tools act on shared
   * state, such as a browser MCP server where a snapshot must wait for the navigation before it.
   * Calls to other servers or non-MCP tools in the same step are not held behind it. Default `false`.
   */
  sequential?: boolean;
  /**
   * Filter the tools this server offers. Names are the server's own (before any SDK prefixing).
   * `include` keeps only those names; `exclude` then removes names. A filtered-out tool is never
   * listed to the model and a call to it is refused before any request reaches the server.
   */
  tools?: {
    /** Only these tool names (as the server lists them) are offered. */
    include?: string[];
    /** These names are never offered. Applied after `include`. */
    exclude?: string[];
  };
};

/**
 * Union of MCP server configs.
 *
 * @public
 */
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;
