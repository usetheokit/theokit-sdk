import type { BuiltinToolName } from "./types/agent.js";

/**
 * The names of the tools the SDK declares on its own initiative (and reserves against custom tools).
 *
 * A runtime value so a consumer that accepts tool names from configuration can refuse a collision at
 * load time. Lives outside `src/types/`, which holds types only; the `satisfies` clause and the
 * two-way check below keep it identical to the {@link BuiltinToolName} union.
 */
export const BUILTIN_TOOL_NAMES = [
  "shell",
  "memory_search",
  "memory_get",
] as const satisfies readonly BuiltinToolName[];

// Fails typecheck if a union member is missing from the list.
type AssertTrue<T extends true> = T;
export type _AllBuiltinNamesListed = AssertTrue<
  BuiltinToolName extends (typeof BUILTIN_TOOL_NAMES)[number] ? true : false
>;

/** True when `name` is the name of an SDK builtin tool. */
export function isBuiltinToolName(name: string): name is BuiltinToolName {
  return (BUILTIN_TOOL_NAMES as readonly string[]).includes(name);
}
