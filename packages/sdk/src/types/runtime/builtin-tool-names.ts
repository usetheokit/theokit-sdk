/**
 * The single declaration of the builtin tool names; `BuiltinToolName` is derived from it.
 *
 * It sits in a subdirectory of `src/types/` on purpose: `types/agent.ts` needs the derived type and
 * may import nothing outside `src/types/` (`types-dont-import-runtime`), while the top level of
 * `src/types/` holds no runtime value (`types-are-types-only`). The public runtime entry point is
 * `src/builtin-tools.ts`.
 */
export const BUILTIN_TOOL_NAMES = ["shell", "memory_search", "memory_get"] as const;

/** @public */
export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];
