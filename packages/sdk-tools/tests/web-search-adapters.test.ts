import { describe, expect, it } from "vitest";

import * as adapters from "../src/web-search-adapters.js";

describe("@theokit/sdk-tools/web-search-adapters entry", () => {
  it("exports the Tavily and SearXNG adapters", () => {
    expect(typeof adapters.createTavilyWebSearchAdapter).toBe("function");
    expect(typeof adapters.createSearxngWebSearchAdapter).toBe("function");
  });
});
