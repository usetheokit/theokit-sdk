import type { BuiltinToolName, BuiltinToolNameList } from "./types/builtin-tool-names.js";

/**
 * The names of the tools the SDK declares on its own initiative (and reserves against custom tools).
 *
 * A runtime value so a consumer that accepts tool names from configuration can refuse a collision at
 * load time. Annotated with the exact tuple type that {@link BuiltinToolName} is derived from, so a
 * missing, extra or reordered name fails typecheck.
 */
export const BUILTIN_TOOL_NAMES: BuiltinToolNameList = ["shell", "memory_search", "memory_get"];

/** True when `name` is the name of an SDK builtin tool. */
export function isBuiltinToolName(name: string): name is BuiltinToolName {
  return BUILTIN_TOOL_NAMES.includes(name as BuiltinToolName);
}
