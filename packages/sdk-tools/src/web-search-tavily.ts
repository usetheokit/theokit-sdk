/**
 * Tavily adapter for `createWebSearchTool`.
 *
 * `createTavilyWebSearchAdapter()` returns a `WebSearchCallback` that posts the query to the
 * Tavily Search API with a bearer key (`TAVILY_API_KEY`). The tool is not modified: the adapter
 * plugs into its callback seam like the Brave one. A failed request rejects (`tavily_search_failed`)
 * so the tool reports `search_failed`, and a 200 body without `results` is an empty search. The
 * `fetch` impl is injectable for offline tests; a plain fetch is used because the host is fixed and
 * `screenedFetch` cannot carry the auth header. The message never carries the key.
 */

import { ConfigurationError } from "@theokit/sdk";

import type { WebSearchCallback, WebSearchResult } from "./web-search.js";

const TAVILY_ENDPOINT = "https://api.tavily.com/search";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Options for {@link createTavilyWebSearchAdapter}. */
export interface CreateTavilyWebSearchAdapterOptions {
  /** Tavily API key. Defaults to `process.env.TAVILY_API_KEY`. */
  apiKey?: string;
  /** Injectable fetch (default `globalThis.fetch`) — set in tests for offline runs. */
  fetchImpl?: FetchLike;
  /** Override the Tavily endpoint (proxy / test). */
  endpoint?: string;
}

interface TavilyResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
}

/**
 * Build a `WebSearchCallback` backed by the Tavily Search API. Throws a typed
 * `ConfigurationError` ("no_api_key") at creation when no key is available.
 */
export function createTavilyWebSearchAdapter(
  opts: CreateTavilyWebSearchAdapterOptions = {},
): WebSearchCallback {
  const apiKey = opts.apiKey ?? process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new ConfigurationError(
      "TAVILY_API_KEY is not set (pass { apiKey } or set the env var).",
      { code: "no_api_key" },
    );
  }
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const endpoint = new URL(opts.endpoint ?? TAVILY_ENDPOINT).toString();

  return async (query: string, maxResults: number): Promise<WebSearchResult[]> => {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, max_results: maxResults }),
    });
    if (!res.ok) throw new Error(`tavily_search_failed: HTTP ${res.status}`);
    const json = (await res.json()) as { results?: unknown } | null;
    const results: TavilyResult[] = Array.isArray(json?.results) ? json.results : [];
    return results.slice(0, maxResults).map((r) => ({
      title: String(r?.title ?? ""),
      url: String(r?.url ?? ""),
      snippet: String(r?.content ?? ""),
    }));
  };
}
