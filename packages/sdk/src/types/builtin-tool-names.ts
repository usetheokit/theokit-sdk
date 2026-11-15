/**
 * Owner: `src/` (3 of 3 importers). Derived from the import graph, not declared.
 *
 * The single declaration of the builtin tool names. `BuiltinToolName` is derived from it, so the two
 * cannot diverge.
 *
 * The array is a binding, not an `export const` line: `src/types/` may not import a runtime module
 * (`types-dont-import-runtime`), so the source of the union has to live beside it. The runtime entry
 * point is `src/builtin-tools.ts`, which re-exports the value; nothing reaches the public `export type *`
 * barrel as a value from here.
 */
const BUILTIN_TOOL_NAMES = ["shell", "memory_search", "memory_get"] as const;

/** @public */
export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

export { BUILTIN_TOOL_NAMES };
