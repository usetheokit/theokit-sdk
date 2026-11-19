/**
 * `resolveWebSearchAdapter` — pick a web search adapter from an environment record.
 *
 * Precedence: `THEOKIT_SEARCH` (explicit) > `BRAVE_API_KEY` > `TAVILY_API_KEY` >
 * `THEOKIT_SEARCH_API_URL` + `THEOKIT_SEARCH_API_KEY`. The env is passed in; `process.env` is never read.
 * Errors name variables, never their values.
 */
import { ConfigurationError } from "@theokit/sdk";
import type { WebSearchCallback } from "./web-search.js";
import { createBraveWebSearchAdapter } from "./web-search-brave.js";
import { createGenericHttpSearchAdapter } from "./web-search-http.js";
import { createSearxngWebSearchAdapter } from "./web-search-searxng.js";
import { createTavilyWebSearchAdapter } from "./web-search-tavily.js";

/** Which web search adapter {@link resolveWebSearchAdapter} chose. */
export type WebSearchProvider = "brave" | "searxng" | "tavily" | "generic";

/** Outcome of {@link resolveWebSearchAdapter}: the adapter, or why search is off. */
export interface ResolvedWebSearch {
  /** Undefined when search is off. */
  adapter?: WebSearchCallback;
  provider?: WebSearchProvider;
  /** Values that are credentials, for the caller's output mask. */
  secrets: string[];
  /** Why search is off, naming the variables that would turn it on. */
  offReason?: string;
}

type Env = Readonly<Record<string, string | undefined>>;
type Fetch = typeof fetch;

const OFF_REASON =
  "web search is off: set THEOKIT_SEARCH (brave, tavily, searxng:<url>, generic), " +
  "BRAVE_API_KEY, TAVILY_API_KEY, or THEOKIT_SEARCH_API_URL with THEOKIT_SEARCH_API_KEY";

function read(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function requireVar(env: Env, name: string, why: string): string {
  const value = read(env, name);
  if (!value) {
    throw new ConfigurationError(`${name} is not set but ${why}.`, { code: "no_api_key" });
  }
  return value;
}

function keyed(
  provider: "brave" | "tavily",
  apiKey: string,
  fetchImpl: Fetch | undefined,
): ResolvedWebSearch {
  const create = provider === "brave" ? createBraveWebSearchAdapter : createTavilyWebSearchAdapter;
  return { adapter: create({ apiKey, fetchImpl }), provider, secrets: [apiKey] };
}

function generic(env: Env, fetchImpl: Fetch | undefined): ResolvedWebSearch {
  const endpoint = read(env, "THEOKIT_SEARCH_API_URL");
  const apiKey = read(env, "THEOKIT_SEARCH_API_KEY");
  if (!endpoint || !apiKey) {
    const missing = endpoint ? "THEOKIT_SEARCH_API_KEY" : "THEOKIT_SEARCH_API_URL";
    const present = endpoint ? "THEOKIT_SEARCH_API_URL" : "THEOKIT_SEARCH_API_KEY";
    throw new ConfigurationError(`${missing} is not set but ${present} is; set both or neither.`, {
      code: "no_api_key",
    });
  }
  const adapter = createGenericHttpSearchAdapter({ apiKey, endpoint, fetchImpl });
  return { adapter, provider: "generic", secrets: [apiKey] };
}

function searxng(choice: string, fetchImpl: Fetch | undefined): ResolvedWebSearch {
  const bad = (): never => {
    throw new ConfigurationError(
      "THEOKIT_SEARCH=searxng:<url> needs an http(s) URL after the colon.",
      { code: "no_base_url" },
    );
  };
  const raw = choice.slice("searxng:".length).trim();
  let protocol = "";
  try {
    protocol = new URL(raw).protocol;
  } catch {
    bad();
  }
  if (protocol !== "http:" && protocol !== "https:") bad();
  return {
    adapter: createSearxngWebSearchAdapter({ baseUrl: raw, fetchImpl }),
    provider: "searxng",
    secrets: [],
  };
}

function explicit(choice: string, env: Env, fetchImpl: Fetch | undefined): ResolvedWebSearch {
  const lower = choice.toLowerCase();
  if (lower === "off") {
    return { secrets: [], offReason: "web search is off: THEOKIT_SEARCH=off." };
  }
  if (lower === "brave") {
    return keyed("brave", requireVar(env, "BRAVE_API_KEY", "THEOKIT_SEARCH=brave"), fetchImpl);
  }
  if (lower === "tavily") {
    return keyed("tavily", requireVar(env, "TAVILY_API_KEY", "THEOKIT_SEARCH=tavily"), fetchImpl);
  }
  if (lower === "generic") return generic(env, fetchImpl);
  if (lower.startsWith("searxng:")) return searxng(choice, fetchImpl);
  throw new ConfigurationError(
    "THEOKIT_SEARCH has an unknown value; use brave, tavily, searxng:<url>, generic or off.",
    { code: "invalid_search_provider" },
  );
}

/** Choose a web search adapter from `env`. Throws `ConfigurationError` on a half-configured setup. */
export function resolveWebSearchAdapter(
  env: Env,
  options: { fetchImpl?: typeof fetch } = {},
): ResolvedWebSearch {
  const { fetchImpl } = options;
  const choice = read(env, "THEOKIT_SEARCH");
  if (choice) return explicit(choice, env, fetchImpl);
  const brave = read(env, "BRAVE_API_KEY");
  if (brave) return keyed("brave", brave, fetchImpl);
  const tavily = read(env, "TAVILY_API_KEY");
  if (tavily) return keyed("tavily", tavily, fetchImpl);
  if (read(env, "THEOKIT_SEARCH_API_URL") || read(env, "THEOKIT_SEARCH_API_KEY")) {
    return generic(env, fetchImpl);
  }
  return { secrets: [], offReason: OFF_REASON };
}
