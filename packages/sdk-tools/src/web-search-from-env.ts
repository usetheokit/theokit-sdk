/**
 * `resolveWebSearchAdapter(env)` — pick a web search adapter from environment variables.
 *
 * `THEOKIT_SEARCH` (`brave` | `tavily` | `searxng:<url>` | `generic` | `off`) wins; without it the
 * order is `BRAVE_API_KEY`, `TAVILY_API_KEY`, then the `THEOKIT_SEARCH_API_URL` +
 * `THEOKIT_SEARCH_API_KEY` pair. Blank values count as unset. Errors name variables, never values.
 */

import { ConfigurationError } from "@theokit/sdk";
import type { WebSearchCallback } from "./web-search.js";
import { createBraveWebSearchAdapter } from "./web-search-brave.js";
import { createGenericHttpSearchAdapter } from "./web-search-http.js";
import { createSearxngWebSearchAdapter } from "./web-search-searxng.js";
import { createTavilyWebSearchAdapter } from "./web-search-tavily.js";

/** Which adapter `resolveWebSearchAdapter` chose. */
export type WebSearchProvider = "brave" | "searxng" | "tavily" | "generic";

/** Result of `resolveWebSearchAdapter`: the adapter (if any), its provider, secrets and off reason. */
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
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const OFF_REASON =
  "web search is off: set THEOKIT_SEARCH (brave, tavily, searxng:<url>, generic), " +
  "BRAVE_API_KEY, TAVILY_API_KEY, or THEOKIT_SEARCH_API_URL with THEOKIT_SEARCH_API_KEY.";

function val(env: Env, name: string): string | undefined {
  const v = env[name]?.trim();
  return v ? v : undefined;
}

function fail(message: string, code: string): never {
  throw new ConfigurationError(message, { code });
}

function need(env: Env, name: string, why: string): string {
  return val(env, name) ?? fail(`${name} is not set (${why}).`, "web_search_missing_variable");
}

function searxngUrl(spec: string): string {
  const bad = (): never =>
    fail(
      "THEOKIT_SEARCH has an invalid searxng URL (expected searxng:<http(s) url>).",
      "web_search_invalid_url",
    );
  try {
    const url = new URL(spec);
    return url.protocol === "http:" || url.protocol === "https:" ? spec : bad();
  } catch {
    return bad();
  }
}

function build(
  provider: WebSearchProvider,
  env: Env,
  fetchImpl: FetchLike | undefined,
  searxng?: string,
): ResolvedWebSearch {
  const why = `required by THEOKIT_SEARCH or the selected provider`;
  switch (provider) {
    case "brave": {
      const apiKey = need(env, "BRAVE_API_KEY", why);
      return {
        provider,
        secrets: [apiKey],
        adapter: createBraveWebSearchAdapter({ apiKey, fetchImpl }),
      };
    }
    case "tavily": {
      const apiKey = need(env, "TAVILY_API_KEY", why);
      return {
        provider,
        secrets: [apiKey],
        adapter: createTavilyWebSearchAdapter({ apiKey, fetchImpl }),
      };
    }
    case "searxng":
      return {
        provider,
        secrets: [],
        adapter: createSearxngWebSearchAdapter({ baseUrl: searxng, fetchImpl }),
      };
    case "generic": {
      const endpoint = need(env, "THEOKIT_SEARCH_API_URL", "set with THEOKIT_SEARCH_API_KEY");
      const apiKey = need(env, "THEOKIT_SEARCH_API_KEY", "set with THEOKIT_SEARCH_API_URL");
      return {
        provider,
        secrets: [apiKey],
        adapter: createGenericHttpSearchAdapter({ endpoint, apiKey, fetchImpl }),
      };
    }
  }
}

function implicit(env: Env): WebSearchProvider | undefined {
  if (val(env, "BRAVE_API_KEY")) return "brave";
  if (val(env, "TAVILY_API_KEY")) return "tavily";
  if (val(env, "THEOKIT_SEARCH_API_URL") || val(env, "THEOKIT_SEARCH_API_KEY")) return "generic";
  return undefined;
}

/** Choose a web search adapter from `env` (never reads `process.env`). */
export function resolveWebSearchAdapter(
  env: Env,
  options: { fetchImpl?: typeof fetch } = {},
): ResolvedWebSearch {
  const fetchImpl = options.fetchImpl as FetchLike | undefined;
  const choice = val(env, "THEOKIT_SEARCH");
  if (choice === "off") return { secrets: [], offReason: "web search is off: THEOKIT_SEARCH=off." };
  if (choice === undefined) {
    const provider = implicit(env);
    return provider ? build(provider, env, fetchImpl) : { secrets: [], offReason: OFF_REASON };
  }
  if (choice.startsWith("searxng:")) {
    return build("searxng", env, fetchImpl, searxngUrl(choice.slice("searxng:".length).trim()));
  }
  if (choice === "brave" || choice === "tavily" || choice === "generic") {
    return build(choice, env, fetchImpl);
  }
  return fail(
    "THEOKIT_SEARCH has an unknown value (expected brave, tavily, searxng:<url>, generic or off).",
    "web_search_unknown_provider",
  );
}
