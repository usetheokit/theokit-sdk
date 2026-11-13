/**
 * The names of the tools the SDK declares on its own initiative.
 *
 * A runtime value so a consumer that accepts tool names from configuration can refuse a collision
 * at load time instead of failing `Agent.create` later. {@link BuiltinToolName} is derived from it,
 * so the type and the list cannot diverge. Lives outside `src/types/`, which holds types only.
 */
export const BUILTIN_TOOL_NAMES = ["shell", "memory_search", "memory_get"] as const;

/**
 * A tool the SDK declares to the model itself (see `AgentOptions.withheldBuiltinTools`).
 *
 * @public
 */
export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

/** True when `name` is the name of an SDK builtin tool. */
export function isBuiltinToolName(name: string): name is BuiltinToolName {
  return (BUILTIN_TOOL_NAMES as readonly string[]).includes(name);
}
