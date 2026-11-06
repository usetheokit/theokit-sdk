import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createWebSearchTool } from "../src/web-search.js";
import { createTavilyWebSearchAdapter } from "../src/web-search-tavily.js";
import { textHandler } from "./text-handler.js";

const KEY = "tvly-test-key";

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

const SAMPLE = { results: [{ title: "T1", url: "https://a.example", content: "snippet one" }] };

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.TAVILY_API_KEY;
  delete process.env.TAVILY_API_KEY;
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = savedKey;
});

describe("createTavilyWebSearchAdapter — request and mapping", () => {
  it("sends a POST with a bearer key and a JSON body", async () => {
    const { fetchImpl, calls } = stubFetch(SAMPLE);
    await createTavilyWebSearchAdapter({ apiKey: KEY, fetchImpl })("cats", 2);
    const call = calls[0];
    expect(call?.url).toBe("https://api.tavily.com/search");
    expect(call?.init?.method).toBe("POST");
    const headers = call?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(call?.init?.body))).toEqual({ query: "cats", max_results: 2 });
  });

  it("maps content to snippet", async () => {
    const { fetchImpl } = stubFetch(SAMPLE);
    const results = await createTavilyWebSearchAdapter({ apiKey: KEY, fetchImpl })("q", 5);
    expect(results).toEqual([{ title: "T1", url: "https://a.example", snippet: "snippet one" }]);
  });

  it("slices to max results", async () => {
    const row = (n: number) => ({ title: `T${n}`, url: `https://a.example/${n}`, content: "c" });
    const { fetchImpl } = stubFetch({ results: [row(1), row(2), row(3)] });
    const results = await createTavilyWebSearchAdapter({ apiKey: KEY, fetchImpl })("q", 2);
    expect(results.map((r) => r.title)).toEqual(["T1", "T2"]);
  });

  it("coerces missing fields to empty strings", async () => {
    const { fetchImpl } = stubFetch({ results: [{ url: "https://x" }] });
    const [r] = await createTavilyWebSearchAdapter({ apiKey: KEY, fetchImpl })("q", 5);
    expect(r).toEqual({ title: "", url: "https://x", snippet: "" });
  });
});

describe("createTavilyWebSearchAdapter — key", () => {
  it("reads the key from the environment", async () => {
    process.env.TAVILY_API_KEY = "from-env";
    const { fetchImpl, calls } = stubFetch(SAMPLE);
    await createTavilyWebSearchAdapter({ fetchImpl })("q", 1);
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer from-env");
  });

  it("throws no_api_key at creation when no key is available", () => {
    expect(() => createTavilyWebSearchAdapter({})).toThrowError(/TAVILY_API_KEY/);
    try {
      createTavilyWebSearchAdapter({});
    } catch (err) {
      expect((err as { code?: string }).code).toBe("no_api_key");
    }
  });
});

describe("createTavilyWebSearchAdapter — failure", () => {
  it("rejects on a non-OK status without leaking the key", async () => {
    const { fetchImpl } = stubFetch({}, { ok: false, status: 401 });
    const adapter = createTavilyWebSearchAdapter({ apiKey: KEY, fetchImpl });
    const err = await adapter("q", 5).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toBe("tavily_search_failed: HTTP 401");
    expect(err?.message.includes(KEY)).toBe(false);
  });

  it("maps an odd body to an empty list", async () => {
    for (const body of [null, {}, { results: "x" }]) {
      const { fetchImpl } = stubFetch(body);
      expect(await createTavilyWebSearchAdapter({ apiKey: KEY, fetchImpl })("q", 5)).toEqual([]);
    }
  });

  it("fills createWebSearchTool and reports search_failed on a rejection", async () => {
    const { fetchImpl } = stubFetch({}, { ok: false, status: 503 });
    const tool = createWebSearchTool({
      search: createTavilyWebSearchAdapter({ apiKey: KEY, fetchImpl }),
    });
    const parsed = JSON.parse(await textHandler(tool)({ query: "q" }));
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("search_failed");
  });
});
