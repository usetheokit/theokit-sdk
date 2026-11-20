import type { AgentOptions } from "../../types/agent.js";
import type { SendOptions } from "../../types/run.js";
import { validatePruneToolResults } from "../agent-loop/prune-tool-results.js";
import { validateSendOptions } from "../runtime/validation/validate-agent-options.js";

const SEND_DEFAULT_KEYS = ["toolResultGuard", "pruneToolResults", "perToolTimeoutMs"] as const;

/**
 * Merge `AgentOptions.sendDefaults` under the call's options, per key. A call key set to
 * `undefined` does not remove the default.
 */
function applySendDefaults(
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

/**
 * The effective options of one send: `sendDefaults` merged under the call's options, then the
 * creation-time checks (with the agent's withhold list; also `doomLoop.window`) and the pruning
 * check, so an invalid override fails before the run is queued.
 */
export function resolveSendOptions(
  agentOptions: AgentOptions,
  callOptions: SendOptions,
): SendOptions {
  const options = applySendDefaults(agentOptions.sendDefaults, callOptions);
  validatePruneToolResults(options.pruneToolResults);
  validateSendOptions(options, agentOptions.withheldBuiltinTools);
  return options;
}
