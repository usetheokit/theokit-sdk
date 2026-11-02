import { describe, expect, it } from "vitest";

import { createGithubLinkPreviewTool } from "../src/github-link-preview.js";
import { textHandler } from "./text-handler.js";

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function fakeFetch(answer: (url: string) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return answer(url);
  };
  return { calls, fetchImpl: fetchImpl as typeof fetch };
}

function abortable(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => {
      reject(new DOMException("The operation was aborted.", "AbortError"));
    });
  });
}

async function preview(
  url: string,
  options: Parameters<typeof createGithubLinkPreviewTool>[0],
): Promise<Record<string, unknown>> {
  const tool = createGithubLinkPreviewTool(options);
  return JSON.parse(await textHandler(tool)({ url })) as Record<string, unknown>;
}

const ISSUE = { title: "Crash on start", state: "open", body: "Steps to reproduce" };

describe("createGithubLinkPreviewTool — previews", () => {
  it("previews_an_issue_with_the_exact_api_url_and_one_call", async () => {
    const fake = fakeFetch(() => jsonResponse(ISSUE));
    const result = await preview("https://github.com/theokit/sdk/issues/12", {
      fetchImpl: fake.fetchImpl,
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.url).toBe("https://api.github.com/repos/theokit/sdk/issues/12");
    expect(fake.calls[0]?.init?.method).toBe("GET");
    expect(fake.calls[0]?.init?.redirect).toBe("manual");
    expect(result).toEqual({
      ok: true,
      kind: "issue",
      url: "https://github.com/theokit/sdk/issues/12",
      title: "Crash on start",
      state: "open",
      summary: "Steps to reproduce",
    });
  });

  it("previews_a_pull_request_open_closed_and_merged", async () => {
    const cases = [
      { body: { title: "Fix", state: "open", merged: false, body: "Why" }, state: "open" },
      { body: { title: "Fix", state: "closed", merged: false, body: "Why" }, state: "closed" },
      { body: { title: "Fix", state: "closed", merged: true, body: "Why" }, state: "merged" },
    ];
    for (const c of cases) {
      const fake = fakeFetch(() => jsonResponse(c.body));
      const result = await preview("https://github.com/theokit/sdk/pull/7/", {
        fetchImpl: fake.fetchImpl,
      });
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]?.url).toBe("https://api.github.com/repos/theokit/sdk/pulls/7");
      expect(result).toEqual({
        ok: true,
        kind: "pull_request",
        url: "https://github.com/theokit/sdk/pull/7",
        title: "Fix",
        state: c.state,
        summary: "Why",
      });
    }
  });

  it("previews_a_repository_active_and_archived_and_cuts_the_summary", async () => {
    const active = fakeFetch(() =>
      jsonResponse({ full_name: "theokit/sdk", description: "abcdefghij", archived: false }),
    );
    const activeResult = await preview("https://github.com/theokit/sdk", {
      fetchImpl: active.fetchImpl,
      maxSummaryChars: 4,
    });
    expect(active.calls).toHaveLength(1);
    expect(active.calls[0]?.url).toBe("https://api.github.com/repos/theokit/sdk");
    expect(activeResult).toEqual({
      ok: true,
      kind: "repository",
      url: "https://github.com/theokit/sdk",
      title: "theokit/sdk",
      state: "active",
      summary: "abcd",
    });

    const archived = fakeFetch(() =>
      jsonResponse({ full_name: "theokit/old", description: null, archived: true }),
    );
    const archivedResult = await preview("https://github.com/theokit/old", {
      fetchImpl: archived.fetchImpl,
    });
    expect(archivedResult.state).toBe("archived");
    expect(archivedResult.summary).toBe("");
  });

  it("names_the_tool_github_link_preview_and_honours_a_name_override", () => {
    expect(createGithubLinkPreviewTool().name).toBe("github_link_preview");
    expect(createGithubLinkPreviewTool({ name: "gh_preview" }).name).toBe("gh_preview");
    expect(createGithubLinkPreviewTool({ description: "custom" }).description).toBe("custom");
  });

  it("tolerates_a_trailing_slash_a_query_and_a_fragment_and_www", async () => {
    const urls = [
      "https://github.com/theokit/sdk/issues/12/",
      "https://github.com/theokit/sdk/issues/12?foo=bar",
      "https://github.com/theokit/sdk/issues/12#issuecomment-1",
      "https://www.github.com/theokit/sdk/issues/12",
    ];
    for (const url of urls) {
      const fake = fakeFetch(() => jsonResponse(ISSUE));
      const result = await preview(url, { fetchImpl: fake.fetchImpl });
      expect(fake.calls.map((c) => c.url)).toEqual([
        "https://api.github.com/repos/theokit/sdk/issues/12",
      ]);
      expect(result.url).toBe("https://github.com/theokit/sdk/issues/12");
    }
  });

  it("refuses_unsupported_urls_without_calling_fetch", async () => {
    const urls = [
      "not a url",
      "http://github.com/theokit/sdk",
      "https://gitlab.com/theokit/sdk",
      "https://github.com.evil.example/theokit/sdk",
      "https://user:pass@github.com/theokit/sdk", // trufflehog:ignore -- userinfo fixture the parser must refuse
      "https://github.com:8443/theokit/sdk",
      "https://github.com/theokit/sdk/blob/main/README.md",
      "https://github.com/theokit/sdk/issues/0",
      "https://github.com/theokit/sdk/issues/12ab",
      "https://github.com/theo%2fkit/sdk",
      "https://github.com/theokit/..",
      "https://github.com/theokit",
    ];
    for (const url of urls) {
      const fake = fakeFetch(() => jsonResponse(ISSUE));
      const result = await preview(url, { fetchImpl: fake.fetchImpl });
      expect(result).toEqual({ ok: false, error: "unsupported_url", url });
      expect(fake.calls).toHaveLength(0);
    }
  });
});

describe("createGithubLinkPreviewTool — failures", () => {
  const ISSUE_URL = "https://github.com/theokit/sdk/issues/12";

  it("maps_each_http_failure_to_its_typed_error", async () => {
    const notFound = await preview(ISSUE_URL, {
      fetchImpl: fakeFetch(() => jsonResponse({ message: "Not Found" }, 404)).fetchImpl,
    });
    expect(notFound).toMatchObject({ ok: false, error: "not_found" });

    const upstream = await preview(ISSUE_URL, {
      fetchImpl: fakeFetch(() => jsonResponse({ message: "boom" }, 500)).fetchImpl,
    });
    expect(upstream).toMatchObject({ ok: false, error: "upstream_error", status: 500 });

    const redirect = await preview(ISSUE_URL, {
      fetchImpl: fakeFetch(
        () =>
          new Response(null, {
            status: 301,
            headers: { location: "https://api.github.com/repositories/1" },
          }),
      ).fetchImpl,
    });
    expect(redirect).toMatchObject({ ok: false, error: "redirect_blocked", status: 301 });
  });

  it("maps_a_rate_limit_and_converts_the_epoch_reset_to_retry_after_seconds", async () => {
    const nowMs = 1_700_000_000_000;
    const reset = String(nowMs / 1000 + 42);
    const limited = await preview(ISSUE_URL, {
      now: () => nowMs,
      fetchImpl: fakeFetch(() =>
        jsonResponse({}, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }),
      ).fetchImpl,
    });
    expect(limited).toEqual({
      ok: false,
      error: "rate_limited",
      url: ISSUE_URL,
      status: 403,
      retry_after_seconds: 42,
    });

    const noReset = await preview(ISSUE_URL, {
      fetchImpl: fakeFetch(() => jsonResponse({}, 429, { "x-ratelimit-remaining": "0" })).fetchImpl,
    });
    expect(noReset).toEqual({ ok: false, error: "rate_limited", url: ISSUE_URL, status: 429 });

    const forbidden = await preview(ISSUE_URL, {
      fetchImpl: fakeFetch(() => jsonResponse({}, 403, { "x-ratelimit-remaining": "3" })).fetchImpl,
    });
    expect(forbidden).toMatchObject({ ok: false, error: "upstream_error", status: 403 });

    const bare429 = await preview(ISSUE_URL, {
      fetchImpl: fakeFetch(() => jsonResponse({}, 429)).fetchImpl,
    });
    expect(bare429).toMatchObject({ ok: false, error: "upstream_error", status: 429 });
  });

  it("uses_retry_after_for_a_secondary_rate_limit", async () => {
    const result = await preview(ISSUE_URL, {
      fetchImpl: fakeFetch(() => jsonResponse({}, 403, { "retry-after": "30" })).fetchImpl,
    });
    expect(result).toMatchObject({ ok: false, error: "rate_limited", retry_after_seconds: 30 });
  });

  it("maps_a_rejecting_fetch_to_fetch_failed_and_a_never_answering_fetch_to_timeout", async () => {
    const failed = await preview(ISSUE_URL, {
      fetchImpl: (async () => {
        throw new TypeError("getaddrinfo ENOTFOUND api.github.com secret-detail");
      }) as typeof fetch,
    });
    expect(failed).toEqual({
      ok: false,
      error: "fetch_failed",
      url: ISSUE_URL,
      error_name: "TypeError",
    });
    expect(JSON.stringify(failed)).not.toContain("secret-detail");

    const timedOut = await preview(ISSUE_URL, {
      timeoutMs: 20,
      fetchImpl: ((_input: string | URL | Request, init?: RequestInit) =>
        abortable(init?.signal)) as typeof fetch,
    });
    expect(timedOut).toEqual({ ok: false, error: "timeout", url: ISSUE_URL, timeout_ms: 20 });
  });

  it("times_out_when_the_body_stalls_after_the_headers", async () => {
    const result = await preview(ISSUE_URL, {
      timeoutMs: 20,
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) =>
        ({
          status: 200,
          headers: new Headers(),
          text: () => abortable(init?.signal),
        }) as unknown as Response) as typeof fetch,
    });
    expect(result).toMatchObject({ ok: false, error: "timeout" });
  });

  it("returns_invalid_response_for_non_json_a_missing_title_and_an_oversize_body", async () => {
    const notJson = await preview(ISSUE_URL, {
      fetchImpl: fakeFetch(() => new Response("<html>", { status: 200 })).fetchImpl,
    });
    expect(notJson).toMatchObject({ ok: false, error: "invalid_response" });

    const noTitle = await preview(ISSUE_URL, {
      fetchImpl: fakeFetch(() => jsonResponse({ state: "open" })).fetchImpl,
    });
    expect(noTitle).toMatchObject({ ok: false, error: "invalid_response" });

    const noState = await preview(ISSUE_URL, {
      fetchImpl: fakeFetch(() => jsonResponse({ title: "t", state: 3 })).fetchImpl,
    });
    expect(noState).toMatchObject({ ok: false, error: "invalid_response" });

    const multibyte = `${JSON.stringify({ ...ISSUE, pad: "" }).slice(0, -2)}${"é".repeat(524_288)}"}`;
    expect(multibyte.length).toBeLessThan(1_048_576);
    expect(Buffer.byteLength(multibyte)).toBeGreaterThan(1_048_576);
    const multibyteOut = await preview(ISSUE_URL, {
      fetchImpl: fakeFetch(() => new Response(multibyte, { status: 200 })).fetchImpl,
    });
    expect(multibyteOut).toMatchObject({ ok: false, error: "invalid_response" });

    const notObject = await preview(ISSUE_URL, {
      fetchImpl: fakeFetch(() => jsonResponse([1, 2])).fetchImpl,
    });
    expect(notObject).toMatchObject({ ok: false, error: "invalid_response" });

    const prefix = JSON.stringify({ ...ISSUE, pad: "" });
    const padTo = (bytes: number) => `${prefix.slice(0, -2)}${"x".repeat(bytes - prefix.length)}"}`;
    const atCap = padTo(1_048_576);
    expect(Buffer.byteLength(atCap)).toBe(1_048_576);
    const parsed = await preview(ISSUE_URL, {
      fetchImpl: fakeFetch(() => new Response(atCap, { status: 200 })).fetchImpl,
    });
    expect(parsed).toMatchObject({ ok: true, title: "Crash on start" });

    const overCap = padTo(1_048_577);
    const refused = await preview(ISSUE_URL, {
      fetchImpl: fakeFetch(() => new Response(overCap, { status: 200 })).fetchImpl,
    });
    expect(refused).toMatchObject({ ok: false, error: "invalid_response" });
  });

  it("refuses_an_oversize_content_length_before_reading_the_body", async () => {
    let bodyRead = false;
    const result = await preview(ISSUE_URL, {
      fetchImpl: (async () =>
        ({
          status: 200,
          headers: new Headers({ "content-length": "1048577" }),
          text: async () => {
            bodyRead = true;
            return JSON.stringify(ISSUE);
          },
        }) as unknown as Response) as typeof fetch,
    });
    expect(result).toMatchObject({ ok: false, error: "invalid_response" });
    expect(bodyRead).toBe(false);
  });

  it("cuts_the_summary_without_splitting_a_surrogate_pair", async () => {
    const result = await preview(ISSUE_URL, {
      maxSummaryChars: 3,
      fetchImpl: fakeFetch(() => jsonResponse({ ...ISSUE, body: "ab😀cd" })).fetchImpl,
    });
    const summary = String(result.summary);
    expect(summary).toBe("ab😀");
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(summary)).toBe(false);
  });
});

describe("createGithubLinkPreviewTool — token", () => {
  const TOKEN = "ghp_secretTOKEN123";
  const ISSUE_URL = "https://github.com/theokit/sdk/issues/12";

  it("sends_the_token_only_to_the_api_request_and_never_returns_it", async () => {
    const ok = fakeFetch(() => jsonResponse(ISSUE));
    const okOut = await textHandler(
      createGithubLinkPreviewTool({ fetchImpl: ok.fetchImpl, token: TOKEN }),
    )({ url: ISSUE_URL });
    expect(ok.calls).toHaveLength(1);
    expect(ok.calls[0]?.url.startsWith("https://api.github.com/")).toBe(true);
    const headers = new Headers(ok.calls[0]?.init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(okOut).not.toContain(TOKEN);

    const echo = fakeFetch(() => jsonResponse({ message: `bad ${TOKEN}` }, 500));
    const echoOut = await textHandler(
      createGithubLinkPreviewTool({ fetchImpl: echo.fetchImpl, token: TOKEN }),
    )({ url: ISSUE_URL });
    expect(JSON.parse(echoOut)).toMatchObject({ ok: false, error: "upstream_error" });
    expect(echoOut).not.toContain(TOKEN);

    const anonymous = fakeFetch(() => jsonResponse(ISSUE));
    await preview(ISSUE_URL, { fetchImpl: anonymous.fetchImpl });
    expect(new Headers(anonymous.calls[0]?.init?.headers).has("authorization")).toBe(false);
  });

  it("rejects_a_token_with_a_control_character_or_blank_at_construction", () => {
    expect(() => createGithubLinkPreviewTool({ token: "abc\ndef" })).toThrow(RangeError);
    expect(() => createGithubLinkPreviewTool({ token: "   " })).toThrow(RangeError);
    expect(() => createGithubLinkPreviewTool({ token: "" })).toThrow(RangeError);
  });

  it("rejects_a_non_positive_timeout_or_summary_ceiling_at_construction", () => {
    expect(() => createGithubLinkPreviewTool({ timeoutMs: 0 })).toThrow(RangeError);
    expect(() => createGithubLinkPreviewTool({ timeoutMs: 1.5 })).toThrow(RangeError);
    expect(() => createGithubLinkPreviewTool({ maxSummaryChars: -1 })).toThrow(RangeError);
  });
});
