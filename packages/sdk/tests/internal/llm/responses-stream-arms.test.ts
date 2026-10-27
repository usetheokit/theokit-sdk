/**
 * Characterisation of the five SSE arms of `ResponsesApiClient.stream` that nothing protected.
 *
 * WHY THIS FILE EXISTS, measured rather than assumed. Before touching the generator, each arm of
 * its dispatch was mutated in turn and the two existing responses suites re-run. Three arms killed
 * their mutant (text accumulation, reasoning-item capture, tool-call push). Five did not:
 *
 *   - `response.reasoning_summary_text.delta` / `response.reasoning_text.delta`
 *   - `response.function_call_arguments.delta` (the incremental argument accumulation)
 *   - `response.incomplete` → `max_tokens`
 *   - usage capture on the terminal event (input / reasoning / cache-read / cache-write tokens)
 *   - `response.failed` / `error` → an `error` event AND a typed throw
 *
 * The fourth of those is worth naming. `responses.test.ts:110` asserts in a comment that the
 * streamed argument deltas "are still exercised — the parsed `input` below can only be right if
 * they were accumulated". Deleting the accumulation leaves that suite fully green: the recorded
 * fixture repeats the complete arguments on the `output_item.done` event, so the deltas are dead
 * weight in that path. A comment claiming coverage that does not exist is worse than silence,
 * because it is what stops the next person from adding the test.
 *
 * These are SYNTHETIC streams, deliberately. The recorded fixtures are the right instrument for
 * "does the transport still match what the provider really sends"; they cannot cover a shape the
 * recordings do not contain, and a truncated or failed response is exactly such a shape.
 */
import { describe, expect, it } from "vitest";

import { TheokitAgentError } from "../../../src/errors.js";
import { ResponsesApiClient } from "../../../src/internal/llm/responses.js";
import type { LlmEvent, LlmRequest } from "../../../src/internal/llm/types.js";

/** Serialises records into the `data: {...}` frames `parseSseStream` reads. */
const sse = (...events: unknown[]): string =>
  `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`;

const replay = (body: string): typeof fetch =>
  (async () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as typeof fetch;

const REQUEST: LlmRequest = {
  model: "gpt-5.5",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
};

async function drain(body: string) {
  const client = new ResponsesApiClient({ apiKey: "sk-test", fetch: replay(body) });
  const events: LlmEvent[] = [];
  const gen = client.stream(REQUEST, new AbortController().signal);
  let res = await gen.next();
  while (!res.done) {
    events.push(res.value);
    res = await gen.next();
  }
  return { events, finish: res.value };
}

describe("ResponsesApiClient.stream — the arms the golden fixtures do not reach", () => {
  it("emits a reasoning_delta for each reasoning chunk, and drops the empty ones", async () => {
    const { events } = await drain(
      sse(
        { type: "response.reasoning_summary_text.delta", delta: "think" },
        { type: "response.reasoning_text.delta", delta: "ing" },
        { type: "response.reasoning_text.delta", delta: "" },
        { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
      ),
    );
    const reasoning = events.filter((e) => e.type === "reasoning_delta");
    expect(reasoning.map((e) => (e as { text: string }).text)).toEqual(["think", "ing"]);
    // Reasoning is streamed to the caller and is NOT part of the answer text.
    expect(events.some((e) => e.type === "text_delta")).toBe(false);
  });

  it("accumulates function-call arguments across deltas when the done event carries none", async () => {
    // The shape the recorded fixture hides: `output_item.done` without `arguments`, so the parsed
    // input can only come from the deltas. Delete the accumulation and this is the test that dies.
    const { finish } = await drain(
      sse(
        {
          type: "response.output_item.added",
          item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_weather" },
        },
        { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"city":' },
        { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '"Paris"}' },
        {
          type: "response.output_item.done",
          item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_weather" },
        },
        { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
      ),
    );
    expect(finish.toolCalls).toHaveLength(1);
    expect(finish.toolCalls[0]?.input).toEqual({ city: "Paris" });
    expect(finish.stopReason).toBe("tool_use");
  });

  it("reports a truncated response as max_tokens, not as a normal end of turn", async () => {
    const { finish } = await drain(
      sse(
        { type: "response.output_text.delta", delta: "half a sen" },
        { type: "response.incomplete", response: { usage: { input_tokens: 9, output_tokens: 4 } } },
      ),
    );
    expect(finish.stopReason).toBe("max_tokens");
    expect(finish.text).toBe("half a sen");
  });

  it("carries every usage counter the terminal event reports, not only the two obvious ones", async () => {
    const { finish } = await drain(
      sse({
        type: "response.completed",
        response: {
          usage: {
            input_tokens: 11,
            output_tokens: 22,
            output_tokens_details: { reasoning_tokens: 7 },
            input_tokens_details: { cached_tokens: 3, cache_write_tokens: 5 },
          },
        },
      }),
    );
    // input_tokens INCLUDES both cache buckets; inputTokens is the uncached slice on every client.
    expect(finish.inputTokens).toBe(3);
    expect(finish.outputTokens).toBe(22);
    expect(finish.reasoningTokens).toBe(7);
    expect(finish.cacheReadTokens).toBe(3);
    expect(finish.cacheWriteTokens).toBe(5);
  });

  it("leaves inputTokens absent when the terminal event reports no input_tokens", async () => {
    // Subtracting the cache buckets must not invent a 0 for a field the provider never sent.
    const { finish } = await drain(
      sse({
        type: "response.completed",
        response: { usage: { output_tokens: 4, input_tokens_details: { cached_tokens: 2 } } },
      }),
    );
    expect(finish.inputTokens).toBeUndefined();
    expect(finish.cacheReadTokens).toBe(2);
  });

  it("floors inputTokens at 0 when the cache buckets exceed input_tokens", async () => {
    const { finish } = await drain(
      sse({
        type: "response.completed",
        response: {
          usage: { input_tokens: 4, output_tokens: 1, input_tokens_details: { cached_tokens: 9 } },
        },
      }),
    );
    expect(finish.inputTokens).toBe(0);
  });

  it("reports an in-stream failure as an error event AND a typed throw, never a silent finish", async () => {
    const client = new ResponsesApiClient({
      apiKey: "sk-test",
      fetch: replay(
        sse({ type: "response.failed", response: { error: { message: "upstream exploded" } } }),
      ),
    });
    const events: LlmEvent[] = [];
    const gen = client.stream(REQUEST, new AbortController().signal);
    await expect(
      (async () => {
        let res = await gen.next();
        while (!res.done) {
          events.push(res.value);
          res = await gen.next();
        }
      })(),
    ).rejects.toBeInstanceOf(TheokitAgentError);
    // The event is what a consumer streaming to a UI sees; the throw is what stops the loop. A
    // consumer needs both, so asserting only one would let the other be deleted.
    expect(events).toEqual([{ type: "error", message: "upstream exploded" }]);
  });

  it("keeps the provider's words out of the thrown error, and gives them to the consumer as an event", async () => {
    // Measured, not assumed: the throw carries the mapped classification only — "openai API error:
    // server_error (HTTP 502)" — and never the provider's own string. That is the redaction the
    // production comment claims, and it means the yielded event is the ONLY channel carrying the
    // message. Asserting both halves is what stops either from being deleted as redundant.
    const body = sse({
      type: "error",
      message: "quota for org sk-leak-1234 exhausted",
      response: { error: { message: "quota for org sk-leak-1234 exhausted" } },
    });
    const client = new ResponsesApiClient({ apiKey: "sk-test", fetch: replay(body) });
    const events: LlmEvent[] = [];
    const gen = client.stream(REQUEST, new AbortController().signal);
    const thrown = await gen
      .next()
      .then(async (first) => {
        let res = first;
        while (!res.done) {
          events.push(res.value);
          res = await gen.next();
        }
        return undefined;
      })
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(TheokitAgentError);
    expect((thrown as Error).message).not.toContain("sk-leak-1234");
    expect((thrown as TheokitAgentError).code).toBe("openai_server_error");
    expect(events).toEqual([{ type: "error", message: "quota for org sk-leak-1234 exhausted" }]);
  });

  it("takes the tool name from the item that ANNOUNCED the call when the done event omits it", async () => {
    // `output_item.added` is the only frame carrying the name in this shape, and the production
    // fallback `c.name.length > 0 ? c.name : item.name` exists precisely for it. Without this case
    // the whole `added` arm can be emptied and every other test stays green — measured.
    const { finish } = await drain(
      sse(
        {
          type: "response.output_item.added",
          item: {
            type: "function_call",
            id: "fc_9",
            call_id: "call_9",
            name: "get_weather",
            arguments: '{"city":"Rio"}',
          },
        },
        {
          type: "response.output_item.done",
          item: { type: "function_call", id: "fc_9", call_id: "call_9" },
        },
        { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
      ),
    );
    expect(finish.toolCalls[0]?.name).toBe("get_weather");
    expect(finish.toolCalls[0]?.id).toBe("call_9");
    expect(finish.toolCalls[0]?.input).toEqual({ city: "Rio" });
  });

  it("stops at [DONE] and ignores anything the provider sends after it", async () => {
    // A stream that keeps being read past its terminator is a stream whose result depends on bytes
    // the protocol says are not part of the response.
    const body =
      'data: {"type":"response.output_text.delta","delta":"kept"}\n\n' +
      "data: [DONE]\n\n" +
      'data: {"type":"response.output_text.delta","delta":" IGNORED"}\n\n' +
      'data: {"type":"response.incomplete","response":{"usage":{"input_tokens":9,"output_tokens":9}}}\n\n';
    const { finish } = await drain(body);
    expect(finish.text).toBe("kept");
    expect(finish.stopReason).toBe("end_turn");
    expect(finish.outputTokens).toBeUndefined();
  });
});
