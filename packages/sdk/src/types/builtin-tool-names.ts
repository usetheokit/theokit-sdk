/**
 * Owner: `src/` (3 of 3 importers). Derived from the import graph, not declared.
 *
 * The names of the tools the SDK declares on its own initiative. This is a type only, because
 * `src/types/` holds no runtime values and may not import a runtime module. The runtime list,
 * `BUILTIN_TOOL_NAMES` in `src/builtin-tools.ts`, is annotated with {@link BuiltinToolNameList}, so a
 * name added to one and not the other fails typecheck; {@link BuiltinToolName} is derived from this
 * tuple, so there is no second union to maintain.
 */
export type BuiltinToolNameList = readonly ["shell", "memory_search", "memory_get"];

/** @public */
export type BuiltinToolName = BuiltinToolNameList[number];
