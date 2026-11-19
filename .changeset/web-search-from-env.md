---
"@theokit/sdk-tools": minor
---

Add `resolveWebSearchAdapter(env, { fetchImpl })`, which picks the Brave, SearXNG, Tavily or generic HTTP web search adapter from an environment record (`THEOKIT_SEARCH`, `BRAVE_API_KEY`, `TAVILY_API_KEY`, `THEOKIT_SEARCH_API_URL` + `THEOKIT_SEARCH_API_KEY`) and returns the credentials to mask (#1046).
