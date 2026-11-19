import type { AgentOptions } from "../../types/agent.js";
import type { SendOptions } from "../../types/run.js";

/**
 * `AgentOptions.sendDefaults`: per key, the call's value wins; an explicit `undefined` keeps the
 * default.
 */
export function applySendDefaults(
  defaults: AgentOptions["sendDefaults"],
  options: SendOptions,
): SendOptions {
  if (defaults === undefined) return options;
  return {
    ...options,
    toolResultGuard: options.toolResultGuard ?? defaults.toolResultGuard,
    pruneToolResults: options.pruneToolResults ?? defaults.pruneToolResults,
    perToolTimeoutMs: options.perToolTimeoutMs ?? defaults.perToolTimeoutMs,
  };
}
