import { describe, expect, expectTypeOf, it } from "vitest";
import { ConfigurationError } from "../../src/errors.js";
import { parseSandboxMode, SANDBOX_MODES, type SandboxMode } from "../../src/sandbox/index.js";

describe("SANDBOX_MODES / parseSandboxMode", () => {
  it("derives SandboxMode from the tuple", () => {
    expectTypeOf<SandboxMode>().toEqualTypeOf<(typeof SANDBOX_MODES)[number]>();
    expect([...SANDBOX_MODES]).toEqual(["read-only", "workspace-write", "danger-full-access"]);
  });
  it("accepts every mode", () => {
    for (const m of SANDBOX_MODES) expect(parseSandboxMode(m)).toBe(m);
  });
  it("throws a ConfigurationError listing the modes", () => {
    expect(() => parseSandboxMode("nope")).toThrow(ConfigurationError);
    expect(() => parseSandboxMode("nope")).toThrow(
      /read-only, workspace-write, danger-full-access/,
    );
    expect(() => parseSandboxMode(undefined)).toThrow(ConfigurationError);
    try {
      parseSandboxMode(42);
    } catch (e) {
      expect((e as ConfigurationError).code).toBe("invalid_sandbox_mode");
    }
  });
});
