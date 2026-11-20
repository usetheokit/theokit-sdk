/**
 * Tests for the public `Security` namespace (T2.1, ADR D68).
 */

import { describe, expect, it } from "vitest";

import { Security } from "../src/index.js";
import { redactSecrets } from "../src/internal/security/index.js";

describe("Security.redact (public API)", () => {
  it("masks only the password in URL userinfo", () => {
    const password = "Zx9qLm2Vb7Tn4Kd8";
    const out = Security.redact(`postgres://app:${password}@db.example:5432/x`);
    expect(out).toContain("postgres://app:");
    expect(out).toContain("@db.example:5432/x");
    expect(out).not.toContain(password);
  });

  it("leaves Stripe publishable keys unchanged", () => {
    const text = "pk_live_abcdefghijklmnopqrstuvwx pk_test_abcdefghijklmnopqrstuvwx";
    expect(Security.redact(text)).toBe(text);
  });

  it("leaves URLs and addresses without a userinfo password unchanged", () => {
    for (const text of [
      "https://example.com/path@v2",
      "user@example.com",
      "https://user@example.com/",
    ]) {
      expect(Security.redact(text)).toBe(text);
    }
  });

  it("masks long sk-* tokens with prefix+suffix", () => {
    const secret = "sk-abcdef0123456789ghijklmnopqrstuv";
    const out = Security.redact(`key=${secret}`);
    expect(out).not.toContain(secret);
    expect(out).toContain("sk-abc");
  });

  it("masks Authorization Bearer with `Bearer ***`", () => {
    expect(Security.redact("Authorization: Bearer eyJabc.def.ghi.jkl")).toMatch(/Bearer \*\*\*/);
  });

  it("coerces objects via JSON.stringify and returns a string", () => {
    const out = Security.redact({ key: "sk-abcdef0123456789ghijklmn" });
    expect(typeof out).toBe("string");
    expect(out).not.toContain("sk-abcdef0123456789ghijklmn");
  });

  it("returns '' for null and undefined", () => {
    expect(Security.redact(null)).toBe("");
    expect(Security.redact(undefined)).toBe("");
  });

  it("with codeFile: true preserves env-example placeholders", () => {
    const out = Security.redact("OPENAI_API_KEY=sk-test", { codeFile: true });
    expect(out).toContain("sk-test");
    expect(out).toContain("OPENAI_API_KEY=");
  });
});

describe("Security.addPattern (public API)", () => {
  it("rejects regex without /g flag", () => {
    expect(() => Security.addPattern(/CUSTOM-[A-Z]{4}/)).toThrow(/\/g flag/);
  });

  it("accepts regex with /g and masks custom secrets in subsequent redact calls", () => {
    Security.addPattern(/MYORG-[A-Z0-9]{16}/g);
    const custom = `MYORG-${"A".repeat(16)}`;
    const out = redactSecrets(`token: ${custom}`);
    expect(out).not.toContain(custom);
  });

  it("does not affect built-in patterns", () => {
    Security.addPattern(/ZZZNEW-[A-Z]{8}/g);
    expect(redactSecrets("key=sk-abcdef0123456789ghijklmn")).not.toContain(
      "sk-abcdef0123456789ghijklmn",
    );
  });
});
