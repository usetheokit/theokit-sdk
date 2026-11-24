import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../src/errors.js";
import { PermissionEngine } from "../src/permission-engine.js";

function catchErr(fn: () => unknown): ConfigurationError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigurationError);
    return e as ConfigurationError;
  }
  throw new Error("did not throw");
}

describe("PermissionEngine constructor validation", () => {
  it("rejects an options object in place of the rules array", () => {
    const e = catchErr(() => new PermissionEngine({ rules: [] } as never));
    expect(e.code).toBe("permission_rules_not_array");
    expect(e.message).toContain("new PermissionEngine([");
  });

  it("rejects undefined", () => {
    expect(catchErr(() => new PermissionEngine(undefined as never)).code).toBe(
      "permission_rules_not_array",
    );
  });

  it("rejects an invalid action, naming the index", () => {
    const e = catchErr(() => new PermissionEngine([{ tool: "shell", action: "block" }] as never));
    expect(e.code).toBe("permission_rule_invalid");
    expect(e.message).toContain("index 0");
  });

  it("rejects null elements and bad tools by index", () => {
    const e = catchErr(() => new PermissionEngine([{ tool: "a", action: "allow" }, null] as never));
    expect(e.code).toBe("permission_rule_invalid");
    expect(e.message).toContain("index 1");
    expect(catchErr(() => new PermissionEngine([{ tool: 3, action: "allow" }] as never)).code).toBe(
      "permission_rule_invalid",
    );
  });

  it("accepts string and RegExp tools and an empty array", () => {
    const e = new PermissionEngine([
      { tool: "a", action: "allow" },
      { tool: /^b/, action: "deny" },
    ]);
    expect(e.evaluate("a")).toBe("allow");
    expect(e.evaluate("bx")).toBe("deny");
    expect(new PermissionEngine([]).evaluate("x")).toBe("ask");
  });
});
