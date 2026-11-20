import { BUILTIN_TOOL_NAMES } from "./builtin-tools.js";
import type { BuiltinToolName } from "./types/agent.js";

/** Why a custom tool name is refused. Duplicates need the whole catalog, so they are not here. */
export type ToolNameProblem = "tool_missing_name" | "tool_invalid_name" | "tool_reserved_name";

const TOOL_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

/**
 * Checks a custom tool name against the SDK's rules without throwing, so a framework that compiles
 * tools from configuration can reject a bad name before it constructs an `Agent`. A builtin named
 * in `withheldBuiltins` frees its name; the other builtins and the `mcp_` prefix stay reserved.
 */
export function checkToolName(
  name: string,
  options?: { withheldBuiltins?: readonly BuiltinToolName[] },
): { ok: true } | { ok: false; code: ToolNameProblem; message: string } {
  if (typeof name !== "string" || name.length === 0) {
    return {
      ok: false,
      code: "tool_missing_name",
      message: "Custom tool requires a non-empty name",
    };
  }
  if (!TOOL_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      code: "tool_invalid_name",
      message: `Custom tool name "${name}" must match /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/`,
    };
  }
  const withheld = options?.withheldBuiltins ?? [];
  const reserved = BUILTIN_TOOL_NAMES.some((b) => b === name && !withheld.includes(b));
  if (reserved || name.startsWith("mcp_")) {
    return {
      ok: false,
      code: "tool_reserved_name",
      message: `Custom tool name "${name}" collides with a reserved SDK tool name`,
    };
  }
  return { ok: true };
}
