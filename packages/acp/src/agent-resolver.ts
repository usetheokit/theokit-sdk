/**
 * Normalize `serveAcp({ agent })` into a uniform `AgentFactory` (D351).
 *
 * - Function input → passed through as-is. NOT duck-tested: any function is accepted, and a bad
 *   return value only surfaces when the first session is created.
 * - SDKAgent-shaped object → wrapped in a factory that returns that same instance for every session,
 *   plus a one-time warning through `log` (a shared agent defeats per-session isolation).
 * - Anything else → `InvalidAgentError` thrown synchronously.
 *
 * @internal
 */

import type { AgentLike } from "@theokit/sdk";
import type { AgentFactory, AgentOrFactory } from "./types.js";

function looksLikeSDKAgent(value: unknown): value is AgentLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { agentId?: unknown }).agentId === "string" &&
    typeof (value as { send?: unknown }).send === "function"
  );
}

/** Thrown when `serveAcp({ agent })` is neither a function nor an object with `agentId` + `send`. */
export class InvalidAgentError extends Error {
  override readonly name = "InvalidAgentError";
}

interface ResolverOptions {
  log?: (msg: string) => void;
}

/**
 * Normalize `agent` into a factory, or throw before any protocol runs.
 *
 * The warning for the shared-instance case fires once per resolver, on the FIRST session — so a
 * single session is enough to see it, and only a host that opens NO session never does. It is
 * emitted from the returned factory, not from this call: resolving is silent.
 *
 * @throws InvalidAgentError when `input` is neither a function nor SDKAgent-shaped.
 */
export function resolveAgentFactory(
  input: AgentOrFactory,
  options: ResolverOptions = {},
): AgentFactory {
  const log = options.log ?? ((msg: string) => process.stderr.write(`${msg}\n`));

  if (typeof input === "function") {
    return input as AgentFactory;
  }

  if (looksLikeSDKAgent(input)) {
    let warned = false;
    return (_sessionId: string): AgentLike => {
      if (!warned) {
        warned = true;
        log(
          "[acp] WARN: serveAcp received a single SDKAgent instance; sessions will share conversation state. " +
            "Pass a factory (sessionId) => Agent.create(...) for per-session isolation (D351).",
        );
      }
      return input;
    };
  }

  throw new InvalidAgentError(
    "serveAcp({ agent }) must receive an SDKAgent or a factory (sessionId) => SDKAgent | Promise<SDKAgent>",
  );
}
