import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { StructuredOutputResult } from "../src/structured-output.js";
import { createStructuredOutputTool } from "../src/structured-output.js";
import { textHandler } from "./text-handler.js";

const personSchema = z.object({
  name: z.string(),
  age: z.number().int(),
  role: z.string().default("member"),
});

async function call(
  tool: ReturnType<typeof createStructuredOutputTool>,
  input: unknown,
): Promise<StructuredOutputResult> {
  const out = await textHandler(tool)(input as Record<string, unknown>);
  return JSON.parse(out) as StructuredOutputResult;
}

describe("structured_output", () => {
  it("returns_the_parsed_object_for_a_valid_call", async () => {
    const tool = createStructuredOutputTool({ schema: personSchema });
    const started = performance.now();
    const result = await call(tool, { name: "Ada", age: 36 });
    const elapsedMs = performance.now() - started;

    expect(result).toEqual({ ok: true, output: { name: "Ada", age: 36, role: "member" } });
    expect(elapsedMs).toBeLessThan(50);
  });

  it("returns_typed_issues_for_an_invalid_call", async () => {
    const tool = createStructuredOutputTool({ schema: personSchema });
    const result = await call(tool, { name: "Ada", age: "thirty-six" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result.error).toBe("invalid_structured_output");
    expect(result.issue_count).toBe(1);
    expect(result.issues[0]?.path).toBe("age");
    expect(result.issues[0]?.message.length).toBeGreaterThan(0);

    const tagged = createStructuredOutputTool({ schema: z.object({ tags: z.array(z.string()) }) });
    const nested = await call(tagged, { tags: ["ok", 7] });
    if (nested.ok) throw new Error("expected a failure");
    expect(nested.issues[0]?.path).toBe("tags.1");

    const refined = createStructuredOutputTool({
      schema: z.object({ age: z.number().refine((n) => n >= 18, "must be an adult") }),
    });
    const minor = await call(refined, { age: 12 });
    if (minor.ok) throw new Error("expected a failure");
    expect(minor.issues).toEqual([{ path: "age", message: "must be an adult" }]);
  });

  it("treats_a_non_object_input_as_invalid", async () => {
    const tool = createStructuredOutputTool({ schema: personSchema });

    for (const input of [null, ["Ada", 36], '{"name":"Ada","age":36}']) {
      const result = await call(tool, input);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a failure");
      expect(result.error).toBe("invalid_structured_output");
      expect(result.issues[0]?.path).toBe("");
    }
  });

  it("caps_the_issue_list_at_max_issues", async () => {
    const shape: Record<string, z.ZodNumber> = {};
    for (let i = 0; i < 15; i++) shape[`field${i}`] = z.number();
    const tool = createStructuredOutputTool({ schema: z.object(shape) });

    const result = await call(tool, {});

    if (result.ok) throw new Error("expected a failure");
    expect(result.issues).toHaveLength(10);
    expect(result.issue_count).toBe(15);
  });

  it("exposes_the_json_schema_of_the_caller_schema", () => {
    const tool = createStructuredOutputTool({ schema: personSchema });
    const schema = tool.inputSchema as {
      type: string;
      properties: Record<string, unknown>;
      required: string[];
    };

    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties).sort()).toEqual(["age", "name", "role"]);
    expect(schema.required).toEqual(expect.arrayContaining(["name", "age"]));
  });

  it("uses_the_default_name_and_accepts_a_custom_one", () => {
    const byDefault = createStructuredOutputTool({ schema: personSchema });
    const custom = createStructuredOutputTool({
      schema: personSchema,
      name: "final_answer",
      description: "Return the final answer.",
    });

    expect(byDefault.name).toBe("structured_output");
    expect(byDefault.description.length).toBeGreaterThan(0);
    expect(custom.name).toBe("final_answer");
    expect(custom.description).toBe("Return the final answer.");
  });

  it("refuses_a_schema_that_is_not_an_object", () => {
    expect(() => createStructuredOutputTool({ schema: z.string() })).toThrow(TypeError);
    expect(() => createStructuredOutputTool({ schema: z.string() })).toThrow(
      /createStructuredOutputTool: schema must be an object schema/,
    );
    expect(() =>
      createStructuredOutputTool({ schema: z.union([z.object({ a: z.string() }), z.string()]) }),
    ).toThrow(TypeError);
    for (const maxIssues of [0, -1, 1.5, Number.NaN]) {
      expect(() => createStructuredOutputTool({ schema: personSchema, maxIssues })).toThrow(
        RangeError,
      );
    }
    expect(() => createStructuredOutputTool({ schema: personSchema, maxIssues: 0 })).toThrow(
      /createStructuredOutputTool: maxIssues must be a positive integer, got 0/,
    );
  });

  it("never_throws_on_an_invalid_call", async () => {
    const tool = createStructuredOutputTool({ schema: personSchema, maxIssues: 1 });
    const inputs: unknown[] = [undefined, 42, true, {}, { name: 1, age: 1.5, role: 3 }];

    for (const input of inputs) {
      const result = await call(tool, input);
      expect(result).toMatchObject({ ok: false, error: "invalid_structured_output" });
      if (result.ok) throw new Error("expected a failure");
      expect(result.issues).toHaveLength(1);
    }
  });
});
