import { describe, expect, it } from "vitest";
import * as sdk from "../../src/index.js";
import { isSecretEnvName, secretEnvValues } from "../../src/internal/security/secret-env.js";

describe("isSecretEnvName", () => {
  it("is exported from the root", () => {
    expect(sdk.isSecretEnvName).toBe(isSecretEnvName);
    expect(sdk.secretEnvValues).toBe(secretEnvValues);
  });
  it.each([
    ["DB_PWD", true],
    ["GOOGLE_APPLICATION_CREDENTIALS", true],
    ["x_passphrase", true],
    ["PWD", false],
    ["PUBLIC_BASE_URL", false],
  ])("%s -> %s", (name, expected) => {
    expect(isSecretEnvName(name)).toBe(expected);
  });
});

describe("secretEnvValues", () => {
  const env = { API_KEY: "  abcd  ", X_TOKEN: "abc", EMPTY_SECRET: "  ", UNSET_KEY: undefined, HOME: "/home/x" };
  it("trims and drops empty/undefined/non-secret", () => {
    expect(secretEnvValues(env)).toEqual(["abcd", "abc"]);
  });
  it("applies minLength inclusively", () => {
    expect(secretEnvValues(env, { minLength: 4 })).toEqual(["abcd"]);
  });
});
