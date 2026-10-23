/**
 * Dispatcher logic: covers EC-2 (filter throw fallback), EC-3 (onHandoff
 * throw aborts), EC-4 (empty inputJson), EC-5 (disposed receiver), EC-10
 * (empty filter history still dispatches).
 *
 * Uses fake agents (no LLM); validates dispatch flow + error paths.
 */

import {
  AuthenticationError,
  type SDKAgent,
  TheokitAgentError,
  UnknownAgentError,
} from "@theokit/sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Handoff } from "../src/handoff.js";
import { dispatchHandoff } from "../src/internal/dispatcher.js";
import { createChainState } from "../src/internal/registry.js";
import { HandoffReceiverDisposedError } from "../src/types/handoff.js";

function fakeAgent(name: string, opts: { disposed?: boolean; reply?: string } = {}): SDKAgent {
  const sendSpy = vi.fn(async (_msg: string) => ({
    wait: async () => ({
      id: "r1",
      status: "finished" as const,
      result: opts.reply ?? `[${name}] response`,
    }),
  }));
  const agent = {
    agentId: `agent-${name}`,
    name,
    disposed: opts.disposed ?? false,
    send: sendSpy,
    close: () => undefined,
    dispose: async () => undefined,
    reload: async () => undefined,
    listArtifacts: async () => [],
    downloadArtifact: async () => Buffer.alloc(0),
    [Symbol.asyncDispose]: async () => undefined,
  } as unknown as SDKAgent;
  return agent;
}

describe("dispatchHandoff", () => {
  it("dispatches to receiver and returns its reply", async () => {
    const receiver = fakeAgent("billing", { reply: "Your bill is paid." });
    const descriptor = Handoff.create(receiver);
    const chainState = createChainState("sender", 5);
    const { reply, result } = await dispatchHandoff({
      descriptor,
      senderAgentId: "sender",
      chainState,
      rawInputJson: { reason: "billing question" },
      history: { messages: [] },
      messageOverride: "What is my balance?",
    });
    expect(reply).toBe("Your bill is paid.");
    expect(result.to).toBe("agent-billing");
    expect(result.depth).toBe(1);
  });

  it("EC-5 — throws HandoffReceiverDisposedError when receiver is disposed", async () => {
    const dead = fakeAgent("dead", { disposed: true });
    const descriptor = Handoff.create(dead);
    const chainState = createChainState("sender", 5);
    await expect(
      dispatchHandoff({
        descriptor,
        senderAgentId: "sender",
        chainState,
        rawInputJson: {},
        history: { messages: [] },
        messageOverride: "hi",
      }),
    ).rejects.toThrow(HandoffReceiverDisposedError);
  });

  it("EC-3 / D227 — onHandoff throw aborts the handoff", async () => {
    const receiver = fakeAgent("billing");
    const descriptor = Handoff.create(receiver, {
      onHandoff: () => {
        throw new Error("validation failed");
      },
    });
    const chainState = createChainState("sender", 5);
    await expect(
      dispatchHandoff({
        descriptor,
        senderAgentId: "sender",
        chainState,
        rawInputJson: {},
        history: { messages: [] },
        messageOverride: "hi",
      }),
    ).rejects.toThrow(/validation failed/);
  });

  it("EC-2 / D228 — inputFilter throw falls back to full history", async () => {
    const receiver = fakeAgent("billing", { reply: "ok" });
    const descriptor = Handoff.create(receiver, {
      inputFilter: () => {
        throw new Error("filter blew up");
      },
    });
    const chainState = createChainState("sender", 5);
    const { reply } = await dispatchHandoff({
      descriptor,
      senderAgentId: "sender",
      chainState,
      rawInputJson: {},
      history: { messages: [{ type: "user", message: { role: "user", content: "original" } }] },
      messageOverride: "hi",
    });
    expect(reply).toBe("ok"); // dispatch succeeded despite filter throw
  });

  it("EC-10 — empty inputFilter history still dispatches", async () => {
    const receiver = fakeAgent("billing", { reply: "ok" });
    const descriptor = Handoff.create(receiver, {
      inputFilter: () => ({ messages: [] }),
    });
    const chainState = createChainState("sender", 5);
    const { reply } = await dispatchHandoff({
      descriptor,
      senderAgentId: "sender",
      chainState,
      rawInputJson: {},
      history: { messages: [] },
      messageOverride: "hi",
    });
    expect(reply).toBe("ok");
  });

  it("EC-4 / D229 — empty/null input is accepted when inputType undefined", async () => {
    const receiver = fakeAgent("billing", { reply: "ok" });
    const descriptor = Handoff.create(receiver);
    const chainState = createChainState("sender", 5);
    // null + undefined + {} all accepted without throw
    for (const raw of [null, undefined, {}]) {
      const cs = createChainState("sender", 5);
      const { reply } = await dispatchHandoff({
        descriptor,
        senderAgentId: "sender",
        chainState: cs,
        rawInputJson: raw,
        history: { messages: [] },
        messageOverride: "hi",
      });
      expect(reply).toBe("ok");
    }
    void chainState;
  });

  it("D229 — empty input parses as {} before Zod refinements when inputType defined", async () => {
    const receiver = fakeAgent("billing", { reply: "ok" });
    const descriptor = Handoff.create(receiver, {
      inputType: z.object({ reason: z.string().optional() }),
    });
    const chainState = createChainState("sender", 5);
    const { reply } = await dispatchHandoff({
      descriptor,
      senderAgentId: "sender",
      chainState,
      rawInputJson: null, // null → parsed as {} → optional reason OK
      history: { messages: [] },
      messageOverride: "hi",
    });
    expect(reply).toBe("ok");
  });

  it("D229 — required field still throws on empty input", async () => {
    const receiver = fakeAgent("billing");
    const descriptor = Handoff.create(receiver, {
      inputType: z.object({ reason: z.string().min(1) }),
    });
    const chainState = createChainState("sender", 5);
    await expect(
      dispatchHandoff({
        descriptor,
        senderAgentId: "sender",
        chainState,
        rawInputJson: {},
        history: { messages: [] },
        messageOverride: "hi",
      }),
    ).rejects.toThrow(/validation failed/i);
  });

  it("isEnabled false rejects the handoff", async () => {
    const receiver = fakeAgent("billing");
    const descriptor = Handoff.create(receiver, { isEnabled: false });
    const chainState = createChainState("sender", 5);
    await expect(
      dispatchHandoff({
        descriptor,
        senderAgentId: "sender",
        chainState,
        rawInputJson: {},
        history: { messages: [] },
        messageOverride: "hi",
      }),
    ).rejects.toThrow(/disabled/);
  });

  it("isEnabled predicate is called with HandoffContext", async () => {
    const receiver = fakeAgent("billing");
    const predicate = vi.fn(() => false);
    const descriptor = Handoff.create(receiver, { isEnabled: predicate });
    const chainState = createChainState("sender", 5);
    await expect(
      dispatchHandoff({
        descriptor,
        senderAgentId: "sender",
        chainState,
        rawInputJson: {},
        history: { messages: [] },
        messageOverride: "hi",
      }),
    ).rejects.toThrow(/disabled/);
    expect(predicate).toHaveBeenCalled();
    // biome-ignore lint/suspicious/noExplicitAny: vi.fn mock-calls inference loses the typed arg
    const ctx = (predicate.mock.calls as any)[0]?.[0];
    expect(ctx?.senderAgentId).toBe("sender");
    expect(ctx?.receiverAgentId).toBe("agent-billing");
  });
});

// B-498, D4: a receiver created with `throwOnError: true` hands back a run whose `wait()`
// rejects on a failed run. The dispatcher replies as it does for a resolved error run, and
// rethrows a rejection from a run that did not fail.
describe("dispatchHandoff — a receiver run whose wait() rejects", () => {
  function rejectingReceiver(name: string, status: string, error: unknown): SDKAgent {
    const agent = fakeAgent(name);
    (agent as unknown as { send: unknown }).send = vi.fn(async () => ({
      status,
      wait: async () => {
        throw error;
      },
    }));
    return agent;
  }

  function dispatchTo(receiver: SDKAgent) {
    return dispatchHandoff({
      descriptor: Handoff.create(receiver),
      senderAgentId: "sender",
      chainState: createChainState("sender", 5),
      rawInputJson: {},
      history: { messages: [] },
      messageOverride: "hi",
    });
  }

  it("replies_with_the_error_when_the_receiver_run_rejects", async () => {
    const failure = new AuthenticationError("bad key", { code: "openrouter_auth_failed" });
    const receiver = rejectingReceiver("billing", "error", failure);

    const { reply } = await dispatchTo(receiver);

    expect(reply).toBe("(Handoff target agent-billing returned status=error: bad key)");
  });

  it("replies_with_the_error_when_a_codeless_run_failure_rejects", async () => {
    const receiver = rejectingReceiver("cloud", "error", new UnknownAgentError("cloud run failed"));

    const { reply } = await dispatchTo(receiver);

    expect(reply).toBe("(Handoff target agent-cloud returned status=error: cloud run failed)");
  });

  it("propagates_a_wait_failure_from_a_run_that_did_not_fail", async () => {
    const failure = new TheokitAgentError("output processor exploded", {
      code: "processor_failed",
    });
    const receiver = rejectingReceiver("billing", "finished", failure);

    await expect(dispatchTo(receiver)).rejects.toBe(failure);
  });
});
