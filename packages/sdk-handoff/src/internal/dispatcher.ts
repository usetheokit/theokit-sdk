/**
 * Handoff dispatch orchestration.
 *
 * Pragmatic v1: when a handoff fires, the sender calls `receiver.send()`
 * with the (optionally filtered) history. The receiver's reply is returned
 * to the sender, which captures it as the answer to the user's question.
 *
 * NOTE: this is NOT pure peer-to-peer (the sender stays on the call stack
 * until the receiver returns). Pure intercept-and-swap requires deeper
 * agent-loop refactor; deferred to v2. v1 still validates the user-facing
 * value: "agent A reasoned about routing, agent B answered."
 *
 * @internal
 */

import type { SDKAgent } from "@theokit/sdk";
import { z } from "zod";
import type {
  HandoffContext,
  HandoffDescriptor,
  HandoffHistory,
  HandoffResult,
} from "../types/handoff.js";
import { HandoffReceiverDisposedError } from "../types/handoff.js";
import { type HandoffChainState, recordHop } from "./registry.js";
import { startHandoffSpan } from "./telemetry.js";

/**
 * EC-2 / D228 — `safeFilter` wraps `inputFilter`. On exception, falls back
 * to the un-filtered history and warns to stderr once per process.
 */
let warnedFilterOnce = false;
async function safeFilter(
  filter: ((h: HandoffHistory) => HandoffHistory | Promise<HandoffHistory>) | undefined,
  history: HandoffHistory,
): Promise<HandoffHistory> {
  if (filter === undefined) return history;
  try {
    const result = filter(history);
    return result instanceof Promise ? await result : result;
  } catch (err) {
    if (!warnedFilterOnce) {
      warnedFilterOnce = true;
      process.stderr.write(
        `[handoff] inputFilter threw, falling back to full history: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    return history;
  }
}

/**
 * EC-4 / D229 — parse the LLM-provided JSON args. Returns undefined when
 * no `inputType` set; returns parsed value otherwise (default to `{}` on
 * empty/null input before Zod refinements).
 */
function parseHandoffInput(descriptor: HandoffDescriptor, raw: unknown): unknown {
  const inputType = descriptor.options.inputType;
  if (inputType === undefined) return undefined;
  const candidate = raw === null || raw === undefined ? {} : raw;
  return inputType.parse(candidate);
}

function isAgentDisposed(agent: SDKAgent): boolean {
  // SDKAgent doesn't expose `disposed` publicly; check via duck-typing on
  // a known internal flag. Safe fallback: if we can't tell, assume alive.
  const maybe = agent as unknown as { disposed?: boolean };
  return maybe.disposed === true;
}

/**
 * Run a single handoff hop. Returns the receiver's reply text.
 *
 * Algorithm:
 *   1. EC-5: refuse if receiver disposed.
 *   2. Build HandoffContext.
 *   3. Check isEnabled() — if false, refuse with a clear error message.
 *   4. Parse inputType (D229).
 *   5. Run onHandoff(ctx, parsed) — throw aborts (D227).
 *   6. Apply inputFilter (safeFilter — D228).
 *   7. Record hop in chain state (depth + pair guards).
 *   8. Open OTel span (D220).
 *   9. Receiver: build the user-facing message and `await receiver.send(msg).then(wait)`.
 *  10. Close span + return reply.
 */
async function assertHandoffEnabled(
  descriptor: HandoffDescriptor,
  ctx: HandoffContext,
  receiverAgentId: string,
): Promise<void> {
  const opt = descriptor.options.isEnabled;
  let enabled = true;
  if (typeof opt === "boolean") enabled = opt;
  else if (typeof opt === "function") {
    const r = opt(ctx);
    enabled = r instanceof Promise ? await r : r;
  }
  if (!enabled) {
    throw new Error(`Handoff to ${receiverAgentId} is disabled (isEnabled returned false)`);
  }
}

function parseAndValidate(descriptor: HandoffDescriptor, rawInputJson: unknown): unknown {
  try {
    return parseHandoffInput(descriptor, rawInputJson);
  } catch (err) {
    const detail =
      err instanceof z.ZodError
        ? (err.issues[0]?.message ?? "schema_invalid")
        : err instanceof Error
          ? err.message
          : String(err);
    throw new Error(`Handoff input validation failed: ${detail}`);
  }
}

async function runOnHandoff(
  descriptor: HandoffDescriptor,
  ctx: HandoffContext,
  parsedInput: unknown,
): Promise<void> {
  const onHandoff = descriptor.options.onHandoff;
  if (onHandoff === undefined) return;
  // biome-ignore lint/suspicious/noExplicitAny: parsedInput is typed unknown by design.
  const result = onHandoff(ctx, parsedInput as any);
  if (result instanceof Promise) await result;
}

function extractUserText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((c): c is { type: "text"; text: string } => (c as { type?: string })?.type === "text")
    .map((c) => c.text)
    .join("\n");
  return text.length > 0 ? text : undefined;
}

/**
 * The user turn's text, for either transcript shape reaching this function.
 *
 * `HandoffHistory.messages` is `unknown[]` by design (it must not import the message types), and
 * two real shapes arrive through it: the SDK's flat `ToolContextMessage` (`{ role, content }`),
 * which is what a tool handler's `ctx.messages` carries, and the nested `SDKMessage`
 * (`{ type: "user", message: { role, content } }`). Reading only the nested one is half of why
 * #354 went unnoticed — the flat shape would have been skipped even had it been passed.
 */
function userTextOf(entry: unknown): string | undefined {
  const m = entry as {
    type?: string;
    role?: string;
    content?: unknown;
    message?: { role?: string; content?: unknown };
  };
  if (m?.type === "user" && m.message?.role === "user") return extractUserText(m.message.content);
  if (m?.role === "user") return extractUserText(m.content);
  return undefined;
}

function extractLastUserMessage(history: HandoffHistory, senderAgentId: string): string {
  for (let i = history.messages.length - 1; i >= 0; i -= 1) {
    const text = userTextOf(history.messages[i]);
    if (text !== undefined) return text;
  }
  return `(Handoff from ${senderAgentId} — no prior user message in history.)`;
}

export async function dispatchHandoff(args: {
  descriptor: HandoffDescriptor;
  senderAgentId: string;
  chainState: HandoffChainState;
  rawInputJson: unknown;
  /** The conversation so far (history wrapper). v1: just the LAST user message. */
  history: HandoffHistory;
  /** Override the message text sent to the receiver. Used by `Agent.handoffTo` imperative. */
  messageOverride?: string;
}): Promise<{ reply: string; result: HandoffResult }> {
  const { descriptor, senderAgentId, chainState, rawInputJson, history, messageOverride } = args;
  const receiver = descriptor.target;

  if (isAgentDisposed(receiver)) {
    throw new HandoffReceiverDisposedError(receiver.agentId);
  }

  const depthAfterThisHop = chainState.chain.length;
  const ctx: HandoffContext = {
    senderAgentId,
    receiverAgentId: receiver.agentId,
    currentDepth: depthAfterThisHop,
    chain: [...chainState.chain, receiver.agentId],
  };

  await assertHandoffEnabled(descriptor, ctx, receiver.agentId);
  const parsedInput = parseAndValidate(descriptor, rawInputJson);
  await runOnHandoff(descriptor, ctx, parsedInput);

  // Filter history (D228 — resilient)
  const filteredHistory = await safeFilter(descriptor.options.inputFilter, history);

  // Record hop — may throw HandoffLoopError or HandoffPairLoopError
  recordHop(chainState, senderAgentId, receiver.agentId);

  const lastUserMessage = messageOverride ?? extractLastUserMessage(filteredHistory, senderAgentId);
  const reason = extractReason(parsedInput);

  const span = startHandoffSpan({
    from: senderAgentId,
    to: receiver.agentId,
    reason,
    depth: depthAfterThisHop,
    toolName: descriptor.resolvedToolName,
  });

  try {
    // #356 — `HandoffOptions.tools` was presented as an allowlist and read by nothing, so a caller
    // who set it got no restriction and no warning. It is wired to `SendOptions.activeTools`, the
    // same `withToolWhitelist` path `Agent.fork`'s `allowedTools` uses. An empty list means the
    // empty set (fail-closed), matching that contract; omitting the option means no restriction.
    const toolAllowlist = descriptor.options.tools;
    const run = await receiver.send(
      lastUserMessage,
      toolAllowlist !== undefined ? { activeTools: [...toolAllowlist] } : {},
    );
    const result = await waitOrMapThrowOnError(run);
    const reply = buildReply(result, receiver.agentId);
    return {
      reply,
      result: {
        from: senderAgentId,
        to: receiver.agentId,
        depth: depthAfterThisHop,
        toolName: descriptor.resolvedToolName,
        ...(reason !== "" ? { reasonFromLlm: reason } : {}),
      },
    };
  } finally {
    span.end();
  }
}

function extractReason(parsedInput: unknown): string {
  if (typeof parsedInput !== "object" || parsedInput === null) return "";
  if (!("reason" in parsedInput)) return "";
  return String((parsedInput as { reason: unknown }).reason ?? "");
}

/**
 * B-498 — a receiver created with `throwOnError: true` rejects `run.wait()` on a failed run. The
 * sender's model still gets the error reply a resolved error run produces. The rejection is
 * recognised by the run's own status, so a rejection from a run that did not fail (an output
 * processor throwing) propagates out of `dispatchHandoff` unchanged.
 */
async function waitOrMapThrowOnError(run: {
  status: string;
  wait(): Promise<{ status: string; result?: string; error?: { message: string } }>;
}): Promise<{ status: string; result?: string; error?: { message: string } }> {
  try {
    return await run.wait();
  } catch (err) {
    if (run.status !== "error") throw err;
    return {
      status: "error",
      error: { message: err instanceof Error ? err.message : String(err) },
    };
  }
}

function buildReply(
  result: { status: string; result?: string; error?: { message: string } },
  receiverAgentId: string,
): string {
  if (result.status === "finished" && result.result !== undefined) return result.result;
  const suffix = result.error !== undefined ? `: ${result.error.message}` : "";
  return `(Handoff target ${receiverAgentId} returned status=${result.status}${suffix})`;
}
