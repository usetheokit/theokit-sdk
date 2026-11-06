/**
 * G8 T3.2 — REAL-LLM integration: subscription handler streaming Agent.streamObject.
 *
 * Per `real-llm-validation.md` — env-gated by `OPENROUTER_API_KEY`. Honest SKIP
 * when key absent (NOT fixture-mode fallback). Proves G8 composes with the
 * existing LLM streaming surface (`Agent.streamObject` per ADR D39).
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent } from "../../src/agent.js";
import { Subscription } from "../../src/subscription/define-subscription.js";
import { SubscriptionRuntime } from "../../src/subscription/internal/subscription-runtime.js";
import { subscribe } from "../../src/subscription/theokit-subscribe.js";
import { useTempCwd } from "../helpers/temp-workspace.js";

// Agent.streamObject below names no cwd, so it defaulted to process.cwd(), which during a test run
// is the package itself: every keyed run left a session file in packages/sdk/.theokit/memory/ and
// the global teardown failed the whole suite for it.
useTempCwd();

const SKIP =
  process.env.OPENROUTER_API_KEY === undefined ||
  process.env.OPENROUTER_API_KEY.length === 0 ||
  process.env.OPENROUTER_API_KEY.startsWith("theo_test_");

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let runtime: SubscriptionRuntime;

beforeAll(async () => {
  if (SKIP) return;
  runtime = new SubscriptionRuntime();
  runtime.register(
    "haiku-stream",
    Subscription.create({
      input: z.object({ topic: z.string() }),
      output: z.object({ kind: z.enum(["partial", "complete"]), text: z.string() }),
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: integration test handler streams partial/complete envelopes with abort + flush semantics
      async *handler(input, ctx) {
        let counter = 0;
        const iter = Agent.streamObject({
          schema: z.object({ text: z.string() }),
          prompt: `Write a haiku about ${input.topic} and stop.`,
          model: { id: "openrouter/openai/gpt-4o-mini" },
          local: { settingSources: [] },
          apiKey: process.env.OPENROUTER_API_KEY ?? "",
        });
        for await (const evt of iter) {
          if (ctx.signal.aborted) return;
          if (evt.type === "partial") {
            yield ctx.tracked(String(++counter), {
              kind: "partial" as const,
              text: JSON.stringify(evt.partial),
            });
          } else if (evt.type === "complete") {
            yield ctx.tracked(String(++counter), {
              kind: "complete" as const,
              text: evt.object.text,
            });
          }
        }
      },
    }),
  );

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: test server multiplexes routing + SSE framing for integration scenarios
  server = createServer(async (req, res) => {
    if (!req.url?.startsWith("/api/subscriptions/")) {
      res.writeHead(404);
      res.end();
      return;
    }
    const u = new URL(req.url, "http://localhost");
    const name = decodeURIComponent(u.pathname.split("/").pop() as string);
    const rawInput = JSON.parse(u.searchParams.get("input") ?? "null");
    const ac = new AbortController();
    req.on("close", () => ac.abort());
    const result = runtime.dispatch({
      name,
      rawInput,
      transport: "sse",
      connectionId: "llm-test",
      signal: ac.signal,
      disconnect: () => ac.abort(),
    });
    if (result.transport !== "sse") {
      res.writeHead(500);
      res.end();
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const reader = result.stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) res.write(value);
    }
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe.skipIf(SKIP)("G8 subscription real-LLM composition", () => {
  it("subscription handler streams Agent.streamObject partial+complete events", async () => {
    const collected: Array<{ kind: string; text: string }> = [];
    for await (const v of subscribe<
      { topic: string },
      { kind: "partial" | "complete"; text: string }
    >(
      "haiku-stream",
      { topic: "robots" },
      { baseUrl, transport: "sse", maxReconnectAttempts: 0 },
    )) {
      collected.push(v);
    }
    const partials = collected.filter((c) => c.kind === "partial");
    const completes = collected.filter((c) => c.kind === "complete");
    expect(partials.length).toBeGreaterThanOrEqual(1);
    expect(completes.length).toBeGreaterThanOrEqual(1);
    expect(completes[0]?.text).toBeTypeOf("string");
    expect((completes[0]?.text ?? "").length).toBeGreaterThan(0);
  }, 60_000);
});

// The whole describe used to hold one test asserting `SKIP === true` — inside `skipIf(!SKIP)`, so it
// could not fail either way: skipped when SKIP is false, true by construction when it is not. It
// printed a PASSED line named "honest skip", which is the one line a reader would take as evidence
// that the honest-skip policy had been checked. The instinct was right — make the skip VISIBLE — and
// vitest already does that: it reports a skipped describe by name, and the name below says why.
describe.skipIf(!SKIP)(
  "G8 subscription real-LLM composition (skipped — no OPENROUTER_API_KEY)",
  () => {
    it.todo("real-LLM composition, per docs/real-llm-validation.md");
  },
);
