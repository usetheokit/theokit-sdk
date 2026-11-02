---
'@theokit/sdk-tools': minor
---

`@theokit/sdk-tools/web-search-adapters` adds two providers for `createWebSearchTool`:
`createTavilyWebSearchAdapter` (a bearer-key POST; the key comes from `{ apiKey }` or
`TAVILY_API_KEY`) and `createSearxngWebSearchAdapter` (a keyless GET against your own instance;
the base URL comes from `{ baseUrl }` or `SEARXNG_BASE_URL`, and the instance must have the json
format enabled). Both reject on a non-OK status, so the tool reports `search_failed`, and return an
empty list for a 200 body without results. They ship from their own subpath so the root bundle
stays inside its size budget. The request and response shapes follow each provider's public
documentation and were not exercised against a live service.
