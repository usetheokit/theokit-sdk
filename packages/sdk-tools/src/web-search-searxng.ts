/**
 * SearXNG adapter for `createWebSearchTool`.
 *
 * `createSearxngWebSearchAdapter()` returns a `WebSearchCallback` that queries a self-hosted
 * SearXNG instance (`SEARXNG_BASE_URL`) with `format=json`, which the instance must enable. The
 * call is keyless. A failed request rejects (`searxng_search_failed`) so the tool reports
 * `search_failed`; a 200 body without `results` is an empty search. SearXNG has no count
 * parameter, so the list is sliced here. The base URL is chosen by the consumer, never by the
 * model, so a plain fetch is used (like the Brave adapter's fixed host); `fetchImpl` is injectable
 * for offline tests.
 */

import { ConfigurationError } from "@theokit/sdk";

import type { WebSearchCallback, WebSearchResult } from "./web-search.js";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Options for {@link createSearxngWebSearchAdapter}. */
export interface CreateSearxngWebSearchAdapterOptions {
  /** Instance base URL. Defaults to `process.env.SEARXNG_BASE_URL`. */
  baseUrl?: string;
  /** Injectable fetch (default `globalThis.fetch`) — set in tests for offline runs. */
  fetchImpl?: FetchLike;
}

interface SearxngResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
}

function parseBase(raw: string | undefined): URL {
  const fail = (): never => {
    throw new ConfigurationError(
      "SEARXNG_BASE_URL is not set or not a URL (pass { baseUrl } or set the env var).",
      { code: "no_base_url" },
    );
  };
  if (!raw) return fail();
  try {
    const url = new URL(raw);
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    return url;
  } catch {
    return fail();
  }
}

/**
 * Build a `WebSearchCallback` backed by a SearXNG instance. Throws a typed
 * `ConfigurationError` ("no_base_url") at creation when no valid base URL is available.
 */
export function createSearxngWebSearchAdapter(
  opts: CreateSearxngWebSearchAdapterOptions = {},
): WebSearchCallback {
  const base = parseBase(opts.baseUrl ?? process.env.SEARXNG_BASE_URL);
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  return async (query: string, maxResults: number): Promise<WebSearchResult[]> => {
    const url = new URL("search", base);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    const res = await fetchImpl(url.toString(), { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`searxng_search_failed: HTTP ${res.status}`);
    const json = (await res.json()) as { results?: unknown } | null;
    const results: SearxngResult[] = Array.isArray(json?.results) ? json.results : [];
    return results.slice(0, maxResults).map((r) => ({
      title: String(r?.title ?? ""),
      url: String(r?.url ?? ""),
      snippet: String(r?.content ?? ""),
    }));
  };
}
