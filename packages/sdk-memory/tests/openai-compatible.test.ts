/**
 * sdk-memory `openai-compatible` adapter unit test (iter 73).
 *
 * Validates the iter 73 hybrid copy of
 * `internal/memory/adapters/openai-compatible.ts` + the inlined
 * `internal/errors/mappers/openai-compatible.ts` mapper. sdk-memory now
 * ships its own self-contained adapter runtime that future
 * provider-specific moves (openai-embedding, mistral-embedding, etc.)
 * will compose with.
 *
 * sdk-core retains its copies for v1.x adapter back-compat.
 * Both copies byte-equivalent at runtime (same EC-2 embeddingsPath
 * REPLACES not concatenates, same EC-4 unknown-model rejection, same
 * linear-backoff 50ms × attempt × MAX_RETRIES=2, same hashKey =
 * sha256(model + " " + text), same status-code → typed-error mapping
 * per ADR D67).
 *
 * Uses a stub fetch (no real provider calls) — adapter math is pure
 * given deterministic input/output.
 */

import {
  AuthenticationError,
  ConfigurationError,
  NetworkError,
  RateLimitError,
} from "@theokit/sdk/errors";
import {
  buildErrorMetadata,
  createOpenAiCompatibleRuntime,
  mapOpenAICompatibleError,
  type OpenAiCompatibleConfig,
  parseRetryAfter,
  truncateRaw,
} from "@theokit/sdk-memory";
import { describe, expect, it } from "vitest";

const CONFIG: OpenAiCompatibleConfig = {
  id: "test",
  defaultBaseUrl: "https://example.test",
  apiKeyEnv: "TEST_API_KEY",
  defaultModel: "test-embed",
  dimensionByModel: { "test-embed": 4 },
};

function jsonResponse(status: number, body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

describe("sdk-memory adapter-http-error (iter 73)", () => {
  describe("parseRetryAfter", () => {
    it("test_returns_undefined_when_headers_or_header_missing", () => {
      expect(parseRetryAfter(undefined)).toBeUndefined();
      expect(parseRetryAfter(new Headers())).toBeUndefined();
    });
    it("test_parses_numeric_seconds", () => {
      const h = new Headers({ "retry-after": "30" });
      expect(parseRetryAfter(h)).toBe(30);
    });
    it("test_ceils_fractional_seconds", () => {
      const h = new Headers({ "retry-after": "1.4" });
      expect(parseRetryAfter(h)).toBe(2);
    });
    it("test_returns_undefined_for_http_date_form", () => {
      const h = new Headers({ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" });
      expect(parseRetryAfter(h)).toBeUndefined();
    });
  });

  describe("truncateRaw + redaction", () => {
    it("test_passes_short_string_through_unchanged_after_redaction", () => {
      expect(truncateRaw("ok")).toBe("ok");
    });
    it("test_returns_undefined_for_null_undefined", () => {
      expect(truncateRaw(null)).toBeUndefined();
      expect(truncateRaw(undefined)).toBeUndefined();
    });
    it("test_truncates_at_2048_with_ellipsis", () => {
      const long = "a".repeat(3000);
      const out = truncateRaw(long) as string;
      expect(out.length).toBe(2048 + 1); // 2048 chars + 1-char ellipsis
      expect(out.endsWith("…")).toBe(true);
    });
    it("test_redacts_known_credential_patterns", () => {
      const FAKE = "sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      const out = truncateRaw(`{"token": "${FAKE}"}`) as string;
      expect(out).not.toContain(FAKE);
    });
  });

  describe("buildErrorMetadata", () => {
    it("test_includes_only_defined_fields", () => {
      const m = buildErrorMetadata({
        provider: "test",
        endpoint: "/v1/embeddings",
        code: "rate_limit",
        status: 429,
        headers: new Headers({ "retry-after": "5" }),
        body: { error: { code: "rate_limit" } },
      });
      expect(m.retryAfter).toBe(5);
      expect(m.statusCode).toBe(429);
      expect(m.code).toBe("rate_limit");
    });
    it("test_omits_retryAfter_when_header_absent", () => {
      const m = buildErrorMetadata({
        provider: "test",
        endpoint: "/v1/embeddings",
        code: "auth_failed",
        status: 401,
        headers: undefined,
        body: null,
      });
      expect("retryAfter" in m).toBe(false);
    });
  });

  describe("mapOpenAICompatibleError — status → typed-error matrix", () => {
    it("test_401_403_AuthenticationError", () => {
      const err = mapOpenAICompatibleError({
        providerId: "p",
        status: 401,
        body: null,
        headers: undefined,
        endpoint: "/e",
      });
      expect(err).toBeInstanceOf(AuthenticationError);
    });
    it("test_429_RateLimitError", () => {
      const err = mapOpenAICompatibleError({
        providerId: "p",
        status: 429,
        body: null,
        headers: undefined,
        endpoint: "/e",
      });
      expect(err).toBeInstanceOf(RateLimitError);
    });
    it("test_400_ConfigurationError", () => {
      const err = mapOpenAICompatibleError({
        providerId: "p",
        status: 400,
        body: null,
        headers: undefined,
        endpoint: "/e",
      });
      expect(err).toBeInstanceOf(ConfigurationError);
    });
    it("test_5xx_NetworkError_server_error", () => {
      const err = mapOpenAICompatibleError({
        providerId: "p",
        status: 503,
        body: null,
        headers: undefined,
        endpoint: "/e",
      });
      expect(err).toBeInstanceOf(NetworkError);
      expect(err.metadata?.code).toBe("server_error");
    });
    it("test_402_or_insufficient_quota_body_maps_to_quota_exceeded", () => {
      const err = mapOpenAICompatibleError({
        providerId: "p",
        status: 402,
        body: null,
        headers: undefined,
        endpoint: "/e",
      });
      expect(err.metadata?.code).toBe("quota_exceeded");
      const err2 = mapOpenAICompatibleError({
        providerId: "p",
        status: 400,
        body: { error: { code: "insufficient_quota" } },
        headers: undefined,
        endpoint: "/e",
      });
      expect(err2.metadata?.code).toBe("quota_exceeded");
    });
    it("test_context_window_body_code_maps_to_context_too_long", () => {
      const err = mapOpenAICompatibleError({
        providerId: "p",
        status: 400,
        body: { error: { code: "context_length_exceeded" } },
        headers: undefined,
        endpoint: "/e",
      });
      expect(err.metadata?.code).toBe("context_too_long");
    });
  });
});

describe("sdk-memory openai-compatible runtime (iter 73)", () => {
  it("test_missing_api_key_throws_AuthenticationError", async () => {
    delete process.env.TEST_API_KEY;
    await expect(
      createOpenAiCompatibleRuntime(CONFIG, { model: "test-embed" }),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("test_unknown_model_throws_ConfigurationError_EC4", async () => {
    await expect(
      createOpenAiCompatibleRuntime(CONFIG, {
        model: "not-in-table",
        apiKey: "sk-test",
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("is not in the dimension table"),
    });
  });

  it("test_embed_uses_stub_fetch_and_returns_vectors", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const stubFetch = async (url: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
      });
      return jsonResponse(200, {
        data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }, { embedding: [0.5, 0.6, 0.7, 0.8] }],
      });
    };
    const runtime = await createOpenAiCompatibleRuntime(CONFIG, {
      apiKey: "sk-test",
      fetch: stubFetch as typeof fetch,
    });
    const vectors = await runtime.embed(["hello", "world"]);
    expect(vectors.length).toBe(2);
    expect(vectors[0]).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(vectors[1]).toEqual([0.5, 0.6, 0.7, 0.8]);
    expect(calls.length).toBe(1);
    // EC-2: embeddingsPath default `/v1/embeddings` REPLACES.
    expect(calls[0]?.url).toBe("https://example.test/v1/embeddings");
  });

  it("test_empty_text_short_circuits_to_zero_vector_without_http", async () => {
    let httpCalls = 0;
    const stubFetch = async () => {
      httpCalls++;
      return jsonResponse(200, { data: [{ embedding: [0, 0, 0, 0] }] });
    };
    const runtime = await createOpenAiCompatibleRuntime(CONFIG, {
      apiKey: "sk-test",
      fetch: stubFetch as typeof fetch,
    });
    const [vec] = await runtime.embed(["   "]);
    expect(vec).toEqual([0, 0, 0, 0]);
    expect(httpCalls).toBe(0); // empty-text branch short-circuits before HTTP
  });

  it("test_429_response_retries_then_succeeds", async () => {
    let attempt = 0;
    const stubFetch = async () => {
      attempt++;
      if (attempt < 2) return jsonResponse(429, { error: { code: "rate_limit" } });
      return jsonResponse(200, { data: [{ embedding: [1, 2, 3, 4] }] });
    };
    const runtime = await createOpenAiCompatibleRuntime(CONFIG, {
      apiKey: "sk-test",
      fetch: stubFetch as typeof fetch,
    });
    const [vec] = await runtime.embed(["retry me"]);
    expect(vec).toEqual([1, 2, 3, 4]);
    expect(attempt).toBe(2);
    expect(runtime.stats().retries).toBe(1);
  });

  it("test_persistent_429_after_max_retries_throws_RateLimitError", async () => {
    const stubFetch = async () => jsonResponse(429, { error: { code: "rate_limit" } });
    const runtime = await createOpenAiCompatibleRuntime(CONFIG, {
      apiKey: "sk-test",
      fetch: stubFetch as typeof fetch,
    });
    await expect(runtime.embed(["never succeeds"])).rejects.toBeInstanceOf(RateLimitError);
  });

  it("test_embeddingsPath_override_REPLACES_default_EC2", async () => {
    const calls: string[] = [];
    const stubFetch = async (url: string | URL) => {
      calls.push(String(url));
      return jsonResponse(200, { data: [{ embedding: [0, 0, 0, 0] }] });
    };
    const runtime = await createOpenAiCompatibleRuntime(
      { ...CONFIG, embeddingsPath: "/v1/openai/embeddings" },
      { apiKey: "sk-test", fetch: stubFetch as typeof fetch },
    );
    await runtime.embed(["x"]);
    // Verify the configured path REPLACES the default.
    expect(calls[0]).toBe("https://example.test/v1/openai/embeddings");
    expect(calls[0]).not.toContain("/v1/embeddings/");
  });

  it("test_caches_repeated_texts_skipping_http", async () => {
    let httpCalls = 0;
    const stubFetch = async () => {
      httpCalls++;
      return jsonResponse(200, { data: [{ embedding: [1, 2, 3, 4] }] });
    };
    const runtime = await createOpenAiCompatibleRuntime(CONFIG, {
      apiKey: "sk-test",
      fetch: stubFetch as typeof fetch,
    });
    await runtime.embed(["same"]);
    await runtime.embed(["same"]);
    expect(httpCalls).toBe(1); // second call served from LRU cache
    const stats = runtime.stats();
    expect(stats.cacheHits).toBeGreaterThanOrEqual(1);
  });
});

describe("mapOpenAICompatibleError — provider text (B-539)", () => {
  const call = (status: number, body: unknown) =>
    mapOpenAICompatibleError({
      providerId: "test",
      status,
      body,
      headers: undefined,
      endpoint: "https://example.test/v1/embeddings",
    });

  it("carries the provider's text on a 400", () => {
    const err = call(400, {
      error: { code: "invalid_value", message: "dimensions must be <= 1536" },
    });
    expect(err.message).toContain("dimensions must be <= 1536");
  });

  it("carries the model text on an OpenRouter 404 and maps it to model_unavailable", () => {
    const err = call(404, { error: { code: 404, message: "No endpoints found for acme/foo" } });
    expect(err).toBeInstanceOf(ConfigurationError);
    expect(err.message).toContain("model_unavailable");
    expect(err.message).toContain("acme/foo");
  });

  it("redacts secrets and bounds the text", () => {
    const err = call(400, {
      error: { message: `bad key sk-${"a".repeat(40)} ${"x".repeat(2000)}` },
    });
    expect(err.message).not.toContain("a".repeat(40));
    expect(err.message.length).toBeLessThan(700);
  });
});
