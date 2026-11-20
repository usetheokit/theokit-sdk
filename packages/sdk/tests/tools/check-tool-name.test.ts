import { describe, expect, it } from "vitest";
import { Agent, ConfigurationError, checkToolName } from "../../src/index.js";
import type { BuiltinToolName } from "../../src/types/agent.js";
import { useTempCwd } from "../helpers/temp-workspace.js";

useTempCwd();

interface Case {
  label: string;
  name: string;
  withheld?: BuiltinToolName[];
  code?: string;
}

const CASES: Case[] = [
  { label: "plain name", name: "search_docs" },
  { label: "reserved builtin", name: "shell", code: "tool_reserved_name" },
  { label: "withheld builtin", name: "shell", withheld: ["shell"] },
  {
    label: "other builtin stays reserved",
    name: "memory_get",
    withheld: ["shell"],
    code: "tool_reserved_name",
  },
  { label: "mcp_ prefix", name: "mcp_x", code: "tool_reserved_name" },
  { label: "leading digit", name: "9tool", code: "tool_invalid_name" },
  { label: "65 characters", name: "a".repeat(65), code: "tool_invalid_name" },
  { label: "empty", name: "", code: "tool_missing_name" },
];

describe("checkToolName", () => {
  it.each(CASES)("$label: check and Agent.create agree", async (c) => {
    const result = checkToolName(c.name, { withheldBuiltins: c.withheld });
    const create = () =>
      Agent.create({
        apiKey: "local",
        model: { id: "claude-sonnet-4-6" },
        withheldBuiltinTools: c.withheld,
        tools: [
          {
            name: c.name,
            description: "d",
            inputSchema: { type: "object", properties: {} },
            handler: () => "ok",
          },
        ],
      });
    if (c.code === undefined) {
      expect(result).toEqual({ ok: true });
      const agent = await create();
      await agent.dispose();
      return;
    }
    expect(result).toMatchObject({ ok: false, code: c.code });
    const err = await create().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConfigurationError);
    expect((err as ConfigurationError).code).toBe(c.code);
    expect((err as ConfigurationError).message).toContain((result as { message: string }).message);
  });
});
