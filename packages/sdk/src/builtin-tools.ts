import { BUILTIN_TOOL_NAMES, type BuiltinToolName } from "./types/runtime/builtin-tool-names.js";

/**
 * The names of the tools the SDK declares on its own initiative (and reserves against custom tools).
 *
 * A runtime value so a consumer that accepts tool names from configuration can refuse a collision at
 * load time. {@link BuiltinToolName} is derived from this list.
 */
export { BUILTIN_TOOL_NAMES };

/** True when `name` is the name of an SDK builtin tool. */
export function isBuiltinToolName(name: string): name is BuiltinToolName {
  return (BUILTIN_TOOL_NAMES as readonly string[]).includes(name);
}
