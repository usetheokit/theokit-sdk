import { describe, expect, it } from "vitest";
import type { BuiltinToolName } from "../src/index.js";
import { BUILTIN_TOOL_NAMES, effectiveToolNames, isBuiltinToolName } from "../src/index.js";
import type { AgentOptions } from "../src/types/agent.js";

// Mutual assignability: a missing or extra name fails `pnpm typecheck`.
type Derived = (typeof BUILTIN_TOOL_NAMES)[number];
const _toDerived = (n: BuiltinToolName): Derived => n;
const _toUnion = (n: Derived): BuiltinToolName => n;
void _toDerived;
void _toUnion;

describe("BUILTIN_TOOL_NAMES", () => {
  it("is every tool a local agent registers when not withheld", () => {
    const opts = { tools: [], memory: { enabled: true } } as unknown as AgentOptions;
    expect([...effectiveToolNames(opts).names].sort()).toEqual([...BUILTIN_TOOL_NAMES].sort());
  });

  it("recognises each builtin", () => {
    for (const name of BUILTIN_TOOL_NAMES) expect(isBuiltinToolName(name)).toBe(true);
  });

  it("rejects a name that is not a builtin", () => {
    expect(isBuiltinToolName("read_file")).toBe(false);
  });
});
