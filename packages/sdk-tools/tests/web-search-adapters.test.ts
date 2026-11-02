import { describe, expect, it } from "vitest";

describe("@theokit/sdk-tools/web-search-adapters entry", () => {
  it("exports the Tavily and SearXNG adapters", async () => {
    const mod = await import("../src/web-search-adapters.js");
    expect(typeof mod.createTavilyWebSearchAdapter).toBe("function");
    expect(typeof mod.createSearxngWebSearchAdapter).toBe("function");
  });
});
