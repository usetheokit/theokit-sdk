/**
 * Owner: `src/` (4 of 9 importers). Derived from the import graph, not declared —
 * `tests/lint/types-name-their-owner.test.ts` re-derives it.
 *
 * Capability slot a provider can fulfill.
 *
 * @public
 */
export type ProviderCapability = "chat" | "web_search" | "image" | "embedding";

/**
 * A single user-declared routing rule. Maps a capability to a provider, and
 * optionally pins a specific model.
 *
 * @public
 */
export interface ProviderRoute {
  capability: ProviderCapability;
  provider: string;
  model?: string;
  /**
   * Opt-in leaked-dialect safe-parse for this route's provider (theokit#58
   * follow-up). When `true`, a `chat_completions` finish that carries ZERO
   * native `tool_calls` has its assistant text scanned for the Hermes
   * `<function=…></tool_call>` dialect, and any recovered calls are surfaced as
   * real `tool_calls` so the loop executes them — for models (qwen3-coder via
   * OpenRouter) that intermittently leak tool calls as text. Default `false`;
   * fail-open (a partial/unclosed block never fabricates a call). Scoped to the
   * resolved chat chain, so a non-leaking route is unaffected.
   */
  extractToolCallsFromContent?: boolean;
}

/**
 * Provider routing configuration accepted by `Agent.create()` via
 * {@link AgentOptions.providers}.
 *
 * @public
 */
export interface ProviderRoutingSettings {
  /** Explicit `{ capability → provider }` map. First match wins per capability. */
  routes: ProviderRoute[];
  /** Provider names to try in order when a route has no provider available. */
  fallback?: string[];
  /**
   * Multiple API keys per provider for same-provider key rotation
   * (credential pool — ADRs D123-D133). When a key hits HTTP 429, 402,
   * or 401, the SDK rotates to the next entry transparently before
   * falling back to a different provider.
   *
   * Example:
   * ```ts
   * apiKeys: { openrouter: ["sk-or-...", "sk-or-..."], anthropic: ["..."] }
   * ```
   *
   * Empty arrays and empty strings are filtered out. If a provider has
   * exactly 1 effective key, the pool is transparent (no rotation behavior).
   *
   * Conflicts with the single-key shape `AgentOptions.apiKey: "..."` —
   * use one OR the other, not both.
   *
   * @public
   */
  apiKeys?: Record<string, string[]>;
  /**
   * Rotation strategy per provider for the credential pool. Default is
   * `"fill_first"` (use entries[0] until exhausted). Only consulted when
   * `apiKeys[provider]` has ≥2 entries.
   *
   * @public
   */
  credentialPoolStrategy?: Record<string, "fill_first" | "round_robin" | "least_used" | "random">;
  /**
   * Settings for the `meta/<model>` provider, which runs turns through Meta's Muse Code CLI
   * (`muse serve`). Muse owns the loop and sandbox; the caller keeps approvals.
   *
   * @public
   */
  muse?: {
    /**
     * Decides a Muse tool-permission request. Resolve `true` to allow, `false` to deny. Absent,
     * every request is denied.
     */
    onApproval?: (request: {
      id: string;
      tool: string;
      input: Record<string, unknown>;
    }) => boolean | Promise<boolean>;
  };
}

/**
 * Plugins configuration accepted by `Agent.create()` via
 * {@link AgentOptions.plugins}.
 *
 * @public
 */
export interface PluginsSettings {
  /** Plugin names to enable. Plugin discovery is plugin-provider specific. */
  enabled?: string[];
}

/**
 * Resolved routing decision returned by `agent.providers.routes()`. Public and
 * secret-free by design — safe to log.
 *
 * @public
 */
export interface ResolvedProviderRoute {
  capability: string;
  provider: string;
  model?: string;
  /** Why the runtime picked this provider (e.g. `"explicit-model-provider"`). */
  reason: string;
}

/**
 * Public providers manager handle exposed as `agent.providers`.
 *
 * @public
 */
export interface SDKProvidersManager {
  /** Inspect which provider serves each capability for this agent. */
  routes(): Promise<ResolvedProviderRoute[]>;
}

/**
 * Provider catalog entry returned by `Theokit.providers.list()`.
 *
 * @public
 */
export interface SDKProvider {
  name: string;
  displayName: string;
  capabilities: string[];
  isAvailable: boolean;
  /** JSON Schema describing the env vars / fields needed to enable this provider. */
  setupSchema: object;
}
