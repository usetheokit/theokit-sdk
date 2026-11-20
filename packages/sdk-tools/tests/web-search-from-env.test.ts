import { ConfigurationError } from "@theokit/sdk";
import { describe, expect, it, vi } from "vitest";

import * as root from "../src/index.js";
import { resolveWebSearchAdapter } from "../src/web-search-from-env.js";

describe("resolveWebSearchAdapter", () => {
  it("is exported from the root", () => {
    expect(root.resolveWebSearchAdapter).toBe(resolveWebSearchAdapter);
  });

  it("selects by table", () => {
    const off = resolveWebSearchAdapter({});
    expect(off.adapter).toBeUndefined();
    for (const n of [
      "THEOKIT_SEARCH",
      "BRAVE_API_KEY",
      "TAVILY_API_KEY",
      "THEOKIT_SEARCH_API_URL",
    ]) {
      expect(off.offReason).toContain(n);
    }
    const brave = resolveWebSearchAdapter({ BRAVE_API_KEY: "k" });
    expect(brave.provider).toBe("brave");
    expect(brave.secrets).toEqual(["k"]);
    expect(
      resolveWebSearchAdapter({
        THEOKIT_SEARCH: "searxng:http://localhost:8888",
        BRAVE_API_KEY: "k",
      }).provider,
    ).toBe("searxng");
    expect(resolveWebSearchAdapter({ TAVILY_API_KEY: "t" }).provider).toBe("tavily");
    expect(
      resolveWebSearchAdapter({ THEOKIT_SEARCH_API_URL: "https://x", THEOKIT_SEARCH_API_KEY: "g" })
        .provider,
    ).toBe("generic");
    expect(
      resolveWebSearchAdapter({ THEOKIT_SEARCH: "off", BRAVE_API_KEY: "k" }).adapter,
    ).toBeUndefined();
  });

  it("treats blank as unset", () => {
    expect(resolveWebSearchAdapter({ BRAVE_API_KEY: "  " }).adapter).toBeUndefined();
  });

  it("refuses a half-configured generic pair", () => {
    expect(() => resolveWebSearchAdapter({ THEOKIT_SEARCH_API_URL: "https://x" })).toThrow(
      /THEOKIT_SEARCH_API_KEY/,
    );
  });

  it("refuses an explicit choice without its key", () => {
    expect(() => resolveWebSearchAdapter({ THEOKIT_SEARCH: "tavily" })).toThrow(/TAVILY_API_KEY/);
  });

  it("refuses a bad searxng URL without echoing it", () => {
    let err: unknown;
    try {
      resolveWebSearchAdapter({ THEOKIT_SEARCH: "searxng:ftp://x" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigurationError);
    expect((err as Error).message).toContain("THEOKIT_SEARCH");
    expect((err as Error).message).not.toContain("ftp://x");
  });

  it("refuses an unknown value", () => {
    expect(() => resolveWebSearchAdapter({ THEOKIT_SEARCH: "bing" })).toThrow(ConfigurationError);
  });

  it("uses the injected fetch", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ results: [] })));
    const { adapter } = resolveWebSearchAdapter(
      { THEOKIT_SEARCH: "searxng:http://localhost:8888" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    await adapter?.("q", 3);
    expect(fetchImpl).toHaveBeenCalled();
  });
});
