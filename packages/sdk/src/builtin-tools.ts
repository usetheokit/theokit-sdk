import type { BuiltinToolName } from "./types/agent.js";

/**
 * The names of the tools the SDK declares on its own initiative (and reserves against custom tools).
 *
 * A runtime value so a consumer that accepts tool names from configuration can refuse a collision at
 * load time. `satisfies` refuses a name that is not a {@link BuiltinToolName}; the type test in
 * `tests/builtin-tool-names.test.ts` refuses a {@link BuiltinToolName} missing from the list.
 *
 * @public
 */
export const BUILTIN_TOOL_NAMES = [
  "shell",
  "memory_search",
  "memory_get",
] as const satisfies readonly BuiltinToolName[];

/** True when `name` is the name of an SDK builtin tool. */
export function isBuiltinToolName(name: string): name is BuiltinToolName {
  return (BUILTIN_TOOL_NAMES as readonly string[]).includes(name);
}
