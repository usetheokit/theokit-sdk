import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createWebSearchTool } from "../src/web-search.js";
import { createSearxngWebSearchAdapter } from "../src/web-search-searxng.js";
import { textHandler } from "./text-handler.js";

const BASE = "https://sx.example/";

/** Build a stub `fetch` that records the request and returns a canned JSON body. */
function stubFetch(body: unknown, init?: { ok?: boolean; status?: number }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string, reqInit?: RequestInit): Promise<Response> => {
    calls.push({ url, init: reqInit });
    return {
      ok: init?.ok ?? true,
      status: init?.status ?? 200,
      json: async () => body,
    } as Response;
  };
  return { fetchImpl, calls };
}

const row = (n: number) => ({ title: `T${n}`, url: `https://a.example/${n}`, content: `c${n}` });

let savedBase: string | undefined;
beforeEach(() => {
  savedBase = process.env.SEARXNG_BASE_URL;
  delete process.env.SEARXNG_BASE_URL;
});
afterEach(() => {
  if (savedBase === undefined) delete process.env.SEARXNG_BASE_URL;
  else process.env.SEARXNG_BASE_URL = savedBase;
});

describe("createSearxngWebSearchAdapter — request and mapping", () => {
  it("sends a GET with q and format=json and no Authorization header", async () => {
    const { fetchImpl, calls } = stubFetch({ results: [row(1)] });
    await createSearxngWebSearchAdapter({ baseUrl: BASE, fetchImpl })("cats", 2);
    expect(calls[0]?.url).toBe("https://sx.example/search?q=cats&format=json");
    const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain("authorization");
  });

  it("keeps a base path prefix", async () => {
    const { fetchImpl, calls } = stubFetch({ results: [] });
    await createSearxngWebSearchAdapter({ baseUrl: "https://sx.example/searx", fetchImpl })("q", 1);
    expect(calls[0]?.url).toBe("https://sx.example/searx/search?q=q&format=json");
  });

  it("maps content to snippet and slices to max results", async () => {
    const { fetchImpl } = stubFetch({ results: [row(1), row(2), row(3)] });
    const results = await createSearxngWebSearchAdapter({ baseUrl: BASE, fetchImpl })("q", 2);
    expect(results).toEqual([
      { title: "T1", url: "https://a.example/1", snippet: "c1" },
      { title: "T2", url: "https://a.example/2", snippet: "c2" },
    ]);
  });

  it("encodes a query with special characters in one q parameter", async () => {
    const { fetchImpl, calls } = stubFetch({ results: [] });
    await createSearxngWebSearchAdapter({ baseUrl: BASE, fetchImpl })("a b&c", 1);
    const url = new URL(calls[0]?.url ?? "");
    expect(url.searchParams.getAll("q")).toEqual(["a b&c"]);
    expect(url.searchParams.get("c")).toBeNull();
  });
});

describe("createSearxngWebSearchAdapter — base url", () => {
  it("reads the base url from the environment", async () => {
    process.env.SEARXNG_BASE_URL = "https://env.example";
    const { fetchImpl, calls } = stubFetch({ results: [] });
    await createSearxngWebSearchAdapter({ fetchImpl })("q", 1);
    expect(calls[0]?.url).toBe("https://env.example/search?q=q&format=json");
  });

  it("throws no_base_url when unset or invalid", () => {
    for (const baseUrl of [undefined, "not a url"]) {
      try {
        createSearxngWebSearchAdapter({ baseUrl });
        expect.unreachable("expected a ConfigurationError");
      } catch (err) {
        expect((err as { code?: string }).code).toBe("no_base_url");
        expect((err as Error).message).toMatch(/SEARXNG_BASE_URL/);
      }
    }
  });
});

describe("createSearxngWebSearchAdapter — failure", () => {
  it("rejects on a non-OK status", async () => {
    const { fetchImpl } = stubFetch({}, { ok: false, status: 403 });
    const adapter = createSearxngWebSearchAdapter({ baseUrl: BASE, fetchImpl });
    await expect(adapter("q", 5)).rejects.toThrow("searxng_search_failed: HTTP 403");
  });

  it("maps an odd body to an empty list", async () => {
    for (const body of [null, {}, { results: {} }]) {
      const { fetchImpl } = stubFetch(body);
      expect(await createSearxngWebSearchAdapter({ baseUrl: BASE, fetchImpl })("q", 5)).toEqual([]);
    }
  });

  it("fills createWebSearchTool and reports search_failed on a rejection", async () => {
    const { fetchImpl } = stubFetch({}, { ok: false, status: 500 });
    const tool = createWebSearchTool({
      search: createSearxngWebSearchAdapter({ baseUrl: BASE, fetchImpl }),
    });
    const parsed = JSON.parse(await textHandler(tool)({ query: "q" }));
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("search_failed");
  });
});
