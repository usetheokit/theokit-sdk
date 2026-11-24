/**
 * #580 — a delegated child cannot recover a builtin its parent withheld.
 *
 * A `shell` tool is always registered on a local agent, including when `tools: []` is passed
 * (`types/agent.ts` § LocalOptions), so withholding is the only mechanism that removes it. It
 * crossed no carrier: measured, a parent withholding `shell` produced a child with `undefined`, and
 * delegation therefore WIDENED authority the operator had revoked.
 */
import { describe, expect, it } from "vitest";

import { buildChildCreateOptions, type SubAgentSpec } from "../src/a2a/subagent.js";
import { resolveInheritedCredentials } from "../src/internal/local-agent/real-local-run-tools.js";
import type { AgentOptions } from "../src/types/agent.js";

const SPEC = { name: "r", description: "d", instructions: "i" } as SubAgentSpec;

describe("withheld builtins survive delegation", () => {
  it("a child of a parent that withheld shell also withholds it", () => {
    const parent = { withheldBuiltinTools: ["shell"] } as AgentOptions;

    const child = buildChildCreateOptions(SPEC, resolveInheritedCredentials(parent));

    expect(child.withheldBuiltinTools).toEqual(["shell"]);
  });

  it("a role may tighten: its own withholding is UNIONED with the parent's", () => {
    const child = buildChildCreateOptions(
      { ...SPEC, withheldBuiltinTools: ["memory_search"] } as SubAgentSpec,
      { withheldBuiltinTools: ["shell"] },
    );

    expect([...(child.withheldBuiltinTools ?? [])].sort()).toEqual(["memory_search", "shell"]);
  });

  it("a role may NOT loosen: an empty list subtracts nothing", () => {
    // The security property of the whole fix. `model` and `sandbox` let the role's own value win, and
    // copying that pattern here would let a child un-withhold what its parent revoked — the defect,
    // reintroduced by its own fix. An empty list is an empty contribution to a union, not a reset.
    const child = buildChildCreateOptions({ ...SPEC, withheldBuiltinTools: [] } as SubAgentSpec, {
      withheldBuiltinTools: ["shell"],
    });

    expect(child.withheldBuiltinTools).toEqual(["shell"]);
  });

  it("does not duplicate a builtin both sides withheld", () => {
    const child = buildChildCreateOptions(
      { ...SPEC, withheldBuiltinTools: ["shell"] } as SubAgentSpec,
      { withheldBuiltinTools: ["shell"] },
    );

    expect(child.withheldBuiltinTools).toEqual(["shell"]);
  });

  it("a role can withhold on its own, with no parent withholding at all", () => {
    const child = buildChildCreateOptions(
      { ...SPEC, withheldBuiltinTools: ["shell"] } as SubAgentSpec,
      { apiKey: "k" },
    );

    expect(child.withheldBuiltinTools).toEqual(["shell"]);
  });

  it("omits the key entirely when nobody withheld anything", () => {
    // The control: without this, every assertion above would pass on a build that always emits a
    // list, and none of them would prove the union is doing the work.
    expect(buildChildCreateOptions(SPEC, { apiKey: "k" }).withheldBuiltinTools).toBeUndefined();
  });

  it("withholding does not disturb the sandbox posture it travels beside", () => {
    const child = buildChildCreateOptions(SPEC, {
      sandbox: true,
      withheldBuiltinTools: ["shell"],
    });

    expect(child.local?.sandboxOptions).toEqual({ enabled: true });
    expect(child.withheldBuiltinTools).toEqual(["shell"]);
  });
});
