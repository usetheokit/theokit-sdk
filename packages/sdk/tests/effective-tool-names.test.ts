/**
 * #583 — a caller can tell "no tools" from "no tools I declared".
 *
 * `Agent.describe()` reports `(options.tools ?? [])`, so an agent with `tools: []` and an agent that
 * withheld its shell both report `[]` while holding different things. That made the security-relevant
 * question — does this agent have a shell? — unanswerable through the public API.
 */
import { describe, expect, it } from "vitest";

import { SubAgent } from "../src/a2a/subagent.js";
import { effectiveToolNames } from "../src/index.js";
import type { AgentOptions, CustomTool } from "../src/types/agent.js";

const tool = (name: string) =>
  ({ name, description: "d", inputSchema: {}, handler: async () => "" }) as unknown as CustomTool;

describe("effectiveToolNames", () => {
  it("reports the shell an agent holds despite declaring no tools", () => {
    // The exact pair `describe()` cannot distinguish.
    expect(effectiveToolNames({ tools: [] } as AgentOptions).names).toEqual(["shell"]);
  });

  it("reports its absence once withheld", () => {
    const opts = { tools: [], withheldBuiltinTools: ["shell"] } as unknown as AgentOptions;

    expect(effectiveToolNames(opts).names).toEqual([]);
    // And says so completely: nothing else was configured, so [] IS the whole catalog.
    expect(effectiveToolNames(opts).unresolved).toEqual([]);
  });

  it("includes declared custom tools alongside the builtins", () => {
    const opts = { tools: [tool("read_file")] } as AgentOptions;

    expect([...effectiveToolNames(opts).names].sort()).toEqual(["read_file", "shell"]);
  });

  it("adds the memory builtins only when memory is enabled", () => {
    const off = { tools: [] } as AgentOptions;
    const on = { tools: [], memory: { enabled: true } } as unknown as AgentOptions;

    // The control that matters: reporting them unconditionally would overstate the catalog, which is
    // the same defect with the sign flipped.
    expect(effectiveToolNames(off).names).not.toContain("memory_search");
    expect([...effectiveToolNames(on).names].sort()).toEqual([
      "memory_get",
      "memory_search",
      "shell",
    ]);
  });

  it("honours a withholding of a memory builtin", () => {
    const opts = {
      tools: [],
      memory: { enabled: true },
      withheldBuiltinTools: ["memory_get"],
    } as unknown as AgentOptions;

    expect([...effectiveToolNames(opts).names].sort()).toEqual(["memory_search", "shell"]);
  });

  it("names a configured source it cannot enumerate, rather than implying completeness", () => {
    const opts = {
      tools: [],
      mcpServers: { fs: { command: "x" } },
      reasoning: true,
    } as unknown as AgentOptions;

    expect([...effectiveToolNames(opts).unresolved].sort()).toEqual(["mcp", "reasoning"]);
  });

  it("does not report an empty plugin list as unresolved", () => {
    // present-but-empty contributes nothing; calling it unresolved would make `unresolved: []` — the
    // signal that the list is complete — unreachable for anyone who touches the field at all.
    expect(
      effectiveToolNames({ tools: [], plugins: [] } as unknown as AgentOptions).unresolved,
    ).toEqual([]);
  });

  it("refuses a created tool instead of answering confidently about it", () => {
    // Every AgentOptions field is optional, so `SubAgent.create()`'s CustomTool satisfies the type by
    // vacuity — measured: `@ts-expect-error` on that call is reported UNUSED (TS2578). Before the
    // guard it answered `{ names: ["shell"], unresolved: [] }`: an empty `unresolved` claiming
    // completeness about an object it never understood. A caller reads that as "this subagent still
    // announces a shell" and disbelieves a fix that worked.
    const created = SubAgent.create({ name: "analyst", description: "d", instructions: "i" });

    expect(() => effectiveToolNames(created as unknown as AgentOptions)).toThrowError(
      /created tool \("analyst"\), not AgentOptions/,
    );
  });

  it("still accepts ordinary options — the guard needs BOTH tool fields", () => {
    // The control: refusing on `handler` alone would reject an options object that happens to carry
    // some unrelated field, and the detection has to stay exact rather than become a heuristic.
    expect(
      effectiveToolNames({ tools: [], handler: () => {} } as unknown as AgentOptions).names,
    ).toEqual(["shell"]);
  });
});
