/**
 * Adversarial property tests for redactSecrets (T1.5.1, ADR D68).
 *
 * For every builtin credential pattern, prove that 200 randomly
 * generated secret-shaped tokens embedded in random natural-text noise
 * never survive `redactSecrets`. Same property for PARAM_PATTERN keys
 * and BEARER_PATTERN.
 */

import * as fc from "fast-check";
import { describe, it } from "vitest";

import { redactSecrets } from "../../../src/internal/security/redact.js";

// issue #117 — pin the fast-check seed so this gate suite is DETERMINISTIC
// (rules/testing.md § tests MUST be deterministic). The value generators below
// use `fc.stringMatching` (direct generation) rather than `fc.string().filter()`
// — a restrictive filter over arbitrary unicode occasionally exhausts fast-check's
// pre-condition budget and reports a spurious "property failed" unrelated to
// redaction. `stringMatching` produces only in-class strings, so no filter skips.
fc.configureGlobal({ seed: 20260715 });

const generators: Array<{ label: string; gen: fc.Arbitrary<string> }> = [
  { label: "sk-ant-", gen: fc.stringMatching(/^sk-ant-[A-Za-z0-9_-]{20,40}$/) },
  { label: "sk-proj-", gen: fc.stringMatching(/^sk-proj-[A-Za-z0-9_-]{20,40}$/) },
  { label: "sk-", gen: fc.stringMatching(/^sk-[A-Za-z0-9_-]{20,40}$/) },
  { label: "ghp_", gen: fc.stringMatching(/^ghp_[A-Za-z0-9]{36}$/) },
  { label: "github_pat_", gen: fc.stringMatching(/^github_pat_[A-Za-z0-9_]{82}$/) },
  { label: "glpat-", gen: fc.stringMatching(/^glpat-[A-Za-z0-9_-]{20}$/) },
  { label: "AKIA", gen: fc.stringMatching(/^AKIA[A-Z0-9]{16}$/) },
  { label: "AIza", gen: fc.stringMatching(/^AIza[A-Za-z0-9_-]{35}$/) },
  { label: "xox-", gen: fc.stringMatching(/^xox[bpasr]-[A-Za-z0-9-]{10,30}$/) },
  { label: "sntrys_", gen: fc.stringMatching(/^sntrys_[A-Za-z0-9]{40}$/) },
  { label: "sk_live_", gen: fc.stringMatching(/^sk_live_[A-Za-z0-9]{20,40}$/) },
  { label: "rk_live_", gen: fc.stringMatching(/^rk_live_[A-Za-z0-9]{20,40}$/) },
  { label: "whsec_", gen: fc.stringMatching(/^whsec_[A-Za-z0-9]{20,40}$/) },
  { label: "sk_test_", gen: fc.stringMatching(/^sk_test_[A-Za-z0-9]{20,40}$/) },
  { label: "rk_test_", gen: fc.stringMatching(/^rk_test_[A-Za-z0-9]{20,40}$/) },
];

describe("redactSecrets — adversarial property tests (T1.5.1)", () => {
  for (const { label, gen } of generators) {
    it(`pattern ${label} never leaks across 200 random natural-text inputs`, () => {
      fc.assert(
        fc.property(
          gen,
          fc.string({ minLength: 0, maxLength: 200 }),
          fc.string({ minLength: 0, maxLength: 200 }),
          (secret, prefix, suffix) => {
            const haystack = `${prefix} ${secret} ${suffix}`;
            return !redactSecrets(haystack).includes(secret);
          },
        ),
        { numRuns: 200 },
      );
    });
  }

  it("PARAM_PATTERN masks api_key/access_token/password/x-api-key values", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("access_token=", "api_key=", "password:", "x-api-key:"),
        fc.stringMatching(/^[A-Za-z0-9_.-]{8,80}$/),
        (prefix, value) => {
          const haystack = `${prefix} ${value}`;
          return !redactSecrets(haystack).includes(value);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("BEARER pattern masks Authorization: Bearer <token>", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9_.\-+/=]{8,80}$/), (token) => {
        const haystack = `Authorization: Bearer ${token}`;
        const out = redactSecrets(haystack);
        return !out.includes(token);
      }),
      { numRuns: 200 },
    );
  });
});
