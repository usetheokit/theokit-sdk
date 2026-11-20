import type { AgentOptions } from "../../types/agent.js";
import type { SendOptions } from "../../types/run.js";

const SEND_DEFAULT_KEYS = ["toolResultGuard", "pruneToolResults", "perToolTimeoutMs"] as const;

/**
 * Merge `AgentOptions.sendDefaults` under the call's options, per key. A call key set to
 * `undefined` does not remove the default.
 */
export function applySendDefaults(
  defaults: AgentOptions["sendDefaults"],
  callOptions: SendOptions,
): SendOptions {
  if (defaults === undefined) return callOptions;
  const merged: SendOptions = { ...callOptions };
  for (const key of SEND_DEFAULT_KEYS) {
    if (merged[key] === undefined && defaults[key] !== undefined) {
      (merged as Record<string, unknown>)[key] = defaults[key];
    }
  }
  return merged;
}
