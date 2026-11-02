/**
 * `@theokit/sdk-tools/web-search-adapters` — the Tavily and SearXNG web search adapters.
 *
 * Kept out of the package barrel on purpose: the root `dist/index.js` has a gzip budget
 * (`.bundle-budget.json`) that exporting both adapters from it exceeds (32084 of 32000 bytes),
 * and a consumer that searches with another provider should not load them.
 */
export {
  type CreateSearxngWebSearchAdapterOptions,
  createSearxngWebSearchAdapter,
} from "./web-search-searxng.js";
export {
  type CreateTavilyWebSearchAdapterOptions,
  createTavilyWebSearchAdapter,
} from "./web-search-tavily.js";
