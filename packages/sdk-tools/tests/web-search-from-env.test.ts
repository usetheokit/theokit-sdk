import { ConfigurationError } from "@theokit/sdk";
import { describe, expect, it, vi } from "vitest";
import { resolveWebSearchAdapter } from "../src/web-search-from-env.js";

describe("resolveWebSearchAdapter", () => {
  it("is off with a reason naming the variables when nothing is set", () => {
    const r = resolveWebSearchAdapter({});
    expect(r.adapter).toBeUndefined();
    expect(r.secrets).toEqual([]);
    for (const v of [
      "THEOKIT_SEARCH",
      "BRAVE_API_KEY",
      "TAVILY_API_KEY",
      "THEOKIT_SEARCH_API_URL",
    ]) {
      expect(r.offReason).toContain(v);
    }
  });

  it.each([
    [{ BRAVE_API_KEY: "k" }, "brave", ["k"]],
    [{ TAVILY_API_KEY: "t" }, "tavily", ["t"]],
    [{ BRAVE_API_KEY: "k", TAVILY_API_KEY: "t" }, "brave", ["k"]],
    [{ THEOKIT_SEARCH_API_URL: "https://x", THEOKIT_SEARCH_API_KEY: "g" }, "generic", ["g"]],
    [{ THEOKIT_SEARCH: "searxng:http://localhost:8888", BRAVE_API_KEY: "k" }, "searxng", []],
    [{ THEOKIT_SEARCH: "tavily", BRAVE_API_KEY: "k", TAVILY_API_KEY: "t" }, "tavily", ["t"]],
  ])("resolves %j", (env, provider, secrets) => {
    const r = resolveWebSearchAdapter(env);
    expect(r.provider).toBe(provider);
    expect(r.secrets).toEqual(secrets);
    expect(typeof r.adapter).toBe("function");
  });

  it("counts blank values as unset", () => {
    expect(resolveWebSearchAdapter({ BRAVE_API_KEY: "  " }).adapter).toBeUndefined();
  });

  it("honours THEOKIT_SEARCH=off", () => {
    const r = resolveWebSearchAdapter({ THEOKIT_SEARCH: "off", BRAVE_API_KEY: "k" });
    expect(r.adapter).toBeUndefined();
    expect(r.secrets).toEqual([]);
  });

  it("refuses a half-configured generic pair, naming the missing variable", () => {
    expect(() => resolveWebSearchAdapter({ THEOKIT_SEARCH_API_URL: "https://x" })).toThrow(
      /THEOKIT_SEARCH_API_KEY/,
    );
    expect(() => resolveWebSearchAdapter({ THEOKIT_SEARCH_API_KEY: "s3cret" })).toThrow(
      /THEOKIT_SEARCH_API_URL/,
    );
    expect(() => resolveWebSearchAdapter({ THEOKIT_SEARCH_API_URL: "https://x" })).toThrow(
      ConfigurationError,
    );
  });

  it("refuses tavily without its key", () => {
    expect(() => resolveWebSearchAdapter({ THEOKIT_SEARCH: "tavily" })).toThrow(/TAVILY_API_KEY/);
  });

  it("refuses an invalid searxng URL without echoing it", () => {
    for (const bad of ["searxng:ftp://x", "searxng:nonsense"]) {
      let err: unknown;
      try {
        resolveWebSearchAdapter({ THEOKIT_SEARCH: bad });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ConfigurationError);
      const msg = (err as Error).message;
      expect(msg).toContain("THEOKIT_SEARCH");
      expect(msg).not.toContain("ftp://x");
      expect(msg).not.toContain("nonsense");
    }
  });

  it("refuses an unknown THEOKIT_SEARCH value without echoing it", () => {
    let err: unknown;
    try {
      resolveWebSearchAdapter({ THEOKIT_SEARCH: "bogus-provider" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigurationError);
    expect((err as Error).message).toContain("THEOKIT_SEARCH");
    expect((err as Error).message).not.toContain("bogus-provider");
  });

  it("builds an adapter that calls the injected fetch", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ web: { results: [] } })));
    const r = resolveWebSearchAdapter({ BRAVE_API_KEY: "k" }, { fetchImpl });
    await r.adapter?.("hello");
    expect(fetchImpl).toHaveBeenCalled();
  });
});
