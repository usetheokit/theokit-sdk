import { describe, expect, it } from "vitest";
import { NetworkError } from "../../../src/errors.js";
import { OpenAIClient } from "../../../src/internal/llm/openai.js";

const neverResolves: typeof fetch = (_url, init) =>
  new Promise((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  });

async function drain(client: OpenAIClient, signal: AbortSignal): Promise<unknown> {
  try {
    const it = client.stream({ model: "m", messages: [] } as never, signal);
    while (!(await it.next()).done) {
      /* drain */
    }
  } catch (e) {
    return e;
  }
  return undefined;
}

describe("response headers timeout", () => {
  it("fails a never-answering fetch with a retryable NetworkError", async () => {
    const client = new OpenAIClient({
      apiKey: "k",
      fetch: neverResolves,
      responseHeadersTimeoutMs: 20,
    });
    const err = await drain(client, new AbortController().signal);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).code).toBe("response_headers_timeout");
    expect((err as NetworkError).isRetryable).toBe(true);
  });

  it("propagates the caller's abort instead of the timeout error", async () => {
    const client = new OpenAIClient({
      apiKey: "k",
      fetch: neverResolves,
      responseHeadersTimeoutMs: 5_000,
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 10);
    const err = await drain(client, ac.signal);
    expect((err as Error).message).not.toMatch(/headers/);
  });
});
