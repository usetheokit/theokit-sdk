import type { AgentOptions } from "../../types/agent.js";
import type { SendOptions } from "../../types/run.js";

type SendDefaults = NonNullable<AgentOptions["sendDefaults"]>;

/**
 * Merge `override` over `base` per key. A key that is `undefined` in `override` keeps the
 * base value (unlike a plain spread, which would erase it).
 *
 * @internal
 */
export function mergeDefinedKeys(
  base: SendDefaults | undefined,
  override: SendDefaults | undefined,
): SendDefaults | undefined {
  if (base === undefined) return override;
  if (override === undefined) return base;
  return {
    ...base,
    ...(override.toolResultGuard !== undefined
      ? { toolResultGuard: override.toolResultGuard }
      : {}),
    ...(override.pruneToolResults !== undefined
      ? { pruneToolResults: override.pruneToolResults }
      : {}),
    ...(override.perToolTimeoutMs !== undefined
      ? { perToolTimeoutMs: override.perToolTimeoutMs }
      : {}),
  };
}

/**
 * Apply the agent's `sendDefaults` under one send's options: a key the call passes (not
 * `undefined`) wins, per key.
 *
 * @internal
 */
export function applySendDefaults(
  defaults: AgentOptions["sendDefaults"],
  options: SendOptions,
): SendOptions {
  if (defaults === undefined) return options;
  const merged = mergeDefinedKeys(defaults, {
    toolResultGuard: options.toolResultGuard,
    pruneToolResults: options.pruneToolResults,
    perToolTimeoutMs: options.perToolTimeoutMs,
  });
  return { ...options, ...merged };
}
