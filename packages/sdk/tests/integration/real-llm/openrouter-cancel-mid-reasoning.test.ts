/**
 * Case C-OR-CANCEL-MID-REASONING (real-LLM): `run.cancel()` mid-reasoning stops OpenRouter.
 *
 * Env-gated by OPENROUTER_API_KEY. A loop-surface-closure audit saw `cancel()` resolve and
 * `wait()` return `cancelled` while 92 `thinking-delta` updates kept reaching `onDelta` over the
 * next 5 s, and OpenRouter billed the generation as not cancelled. The hermetic file
 * `tests/run-cancel-aborts-the-provider-stream.test.ts` proves the mechanism against a local stub;
 * only a live run shows that the real provider stream actually stops.
 *
 * The instrument wraps `globalThis.fetch` and, for the chat request only, hands the SDK a body that
 * pulls from the real one and records the first terminal event it reaches: EOF, a read failure
 * (how an aborted fetch surfaces), or a cancel by its consumer. It is installed before
 * `Agent.create`, because the LLM client binds `globalThis.fetch` when it is constructed.
 */

import { afterEach, describe, expect, it } from "vitest";

import { Agent } from "../../../src/index.js";
import { pollUntil } from "../../helpers/poll-until.js";
import { useTempCwd } from "../../helpers/temp-workspace.js";
import { resolveRealLlmEnv } from "./_helpers/real-llm-env.js";

useTempCwd();

const env = resolveRealLlmEnv("openrouter", { model: "deepseek/deepseek-r1-0528" });

const FIRST_THINKING_DEADLINE_MS = 60_000;
const BODY_STOP_DEADLINE_MS = 1_000;
const POST_CANCEL_WINDOW_MS = 5_000;

type BodyTerminalEvent = "eof" | "read-error" | "consumer-cancel";

interface ChatBodyObserver {
  chatRequests: number;
  bodyTerminatedAt: number | undefined;
  bodyTerminatedBy: BodyTerminalEvent | undefined;
}

/** Records the first terminal event of a body, then forwards everything unchanged. */
function observeBody(body: ReadableStream<Uint8Array>, observer: ChatBodyObserver) {
  const reader = body.getReader();
  const terminate = (by: BodyTerminalEvent): void => {
    if (observer.bodyTerminatedAt !== undefined) return;
    observer.bodyTerminatedAt = Date.now();
    observer.bodyTerminatedBy = by;
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          terminate("eof");
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (cause) {
        terminate("read-error");
        controller.error(cause);
      }
    },
    async cancel(reason) {
      terminate("consumer-cancel");
      await reader.cancel(reason);
    },
  });
}

/** Wraps `globalThis.fetch` so the chat request's response body is observed. */
function installChatBodyObserver(observer: ChatBodyObserver): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await realFetch(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.endsWith("/chat/completions") || response.body === null) return response;
    observer.chatRequests += 1;
    return new Response(observeBody(response.body, observer), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  return () => {
    globalThis.fetch = realFetch;
  };
}

describe.skipIf(env.shouldSkip)(
  `real-llm: openrouter cancel mid-reasoning (${env.provider})`,
  () => {
    let restoreFetch: (() => void) | undefined;
    afterEach(() => {
      restoreFetch?.();
      restoreFetch = undefined;
    });

    it("stops OpenRouter reasoning deltas and the response body after cancel", async () => {
      const observer: ChatBodyObserver = {
        chatRequests: 0,
        bodyTerminatedAt: undefined,
        bodyTerminatedBy: undefined,
      };
      restoreFetch = installChatBodyObserver(observer);
      const agent = await Agent.create({
        apiKey: env.apiKey,
        model: { id: env.model, params: [{ id: "thinking", value: "high" }] },
        providers: { routes: [{ capability: "chat", provider: "openrouter" }] },
      });
      try {
        let cancelled = false;
        let thinkingBeforeCancel = 0;
        let updatesAfterCancel = 0;
        const run = await agent.send("List the prime numbers below 500, reasoning step by step.", {
          onDelta: ({ update }) => {
            if (cancelled) updatesAfterCancel += 1;
            else if (update.type === "thinking-delta") thinkingBeforeCancel += 1;
          },
        });
        // A refused model (404, 401, 402) sends no delta: this names a provider problem.
        await pollUntil(() => thinkingBeforeCancel > 0, {
          deadlineMs: FIRST_THINKING_DEADLINE_MS,
          message: "no thinking-delta before cancel",
        });
        // EC-1: the instrument saw the one chat request, so its timing is about this turn.
        expect(observer.chatRequests).toBe(1);

        const terminatedBeforeCancel = observer.bodyTerminatedAt !== undefined;
        cancelled = true;
        const cancelledAt = Date.now();
        await run.cancel();
        expect(terminatedBeforeCancel).toBe(false);

        // Holds at the deadline too, so a body that never terminates fails on the expect below.
        await pollUntil(
          () =>
            observer.bodyTerminatedAt !== undefined ||
            Date.now() >= cancelledAt + BODY_STOP_DEADLINE_MS,
          { deadlineMs: BODY_STOP_DEADLINE_MS + 1_000 },
        );
        const bodyTerminatedAt = observer.bodyTerminatedAt;
        expect(bodyTerminatedAt).toBeDefined();
        // A body that ended on its own (EOF) after cancel would satisfy the timing without the abort.
        expect(observer.bodyTerminatedBy).not.toBe("eof");
        const bodyStoppedAfterMs = (bodyTerminatedAt ?? Number.POSITIVE_INFINITY) - cancelledAt;
        expect(bodyStoppedAfterMs).toBeLessThanOrEqual(1000);

        // The window itself is the behaviour under test: zero updates must hold for the 5 s the
        // audit observed after cancel, so this timed wait is deliberate (rules/testing.md § 3).
        await pollUntil(() => Date.now() >= cancelledAt + POST_CANCEL_WINDOW_MS, {
          deadlineMs: POST_CANCEL_WINDOW_MS + 1_000,
        });
        console.info(
          `[C-OR-CANCEL-MID-REASONING] thinking before cancel=${String(thinkingBeforeCancel)} updates after cancel=${String(updatesAfterCancel)} body stopped after ${String(bodyStoppedAfterMs)} ms by ${String(observer.bodyTerminatedBy)}`,
        );
        expect(updatesAfterCancel).toBe(0);
        expect((await run.wait()).status).toBe("cancelled");
      } finally {
        await agent.dispose();
      }
    }, 90_000);
  },
);
