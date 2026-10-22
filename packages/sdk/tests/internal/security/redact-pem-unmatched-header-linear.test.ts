/**
 * The PEM entry of BUILTIN_PATTERNS must stay linear on hostile input.
 *
 * A string made of many `-----BEGIN ... PRIVATE KEY-----` headers and no END line made the lazy
 * `[\s\S]+?` span walk to the end of the string once per header, so redaction time grew with the
 * square of the input: about 2 s for 224000 characters on a loaded 12-core host. Every caller that
 * redacts unbounded text (a serialised tool result, a provider error body) inherits that stall.
 *
 * The bound is generous on purpose: a linear scan of 224000 characters takes single-digit
 * milliseconds (the neutral-text control below), so 100 ms leaves an order of magnitude for host
 * load while the quadratic case sits two orders above it.
 */
import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../../src/internal/security/index.js";

const INPUT_LENGTH = 224_000;
const BOUND_MS = 100;
const CASE_TIMEOUT_MS = 120_000;

function repeatTo(unit: string, length: number): string {
  const s = unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
  expect(s.length).toBe(length);
  return s;
}

/**
 * Best of three runs, warmed once. A run over the bound ends the measurement at once: repeating
 * a quadratic call only spends the timeout, and the first slow run already decides the case.
 */
function bestElapsedMs(run: () => unknown): number {
  run();
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 3; i++) {
    const started = performance.now();
    run();
    best = Math.min(best, performance.now() - started);
    if (best > BOUND_MS) return best;
  }
  return best;
}

describe("redactSecrets on unmatched PEM headers", () => {
  it(
    "returns within the bound for BEGIN PRIVATE KEY lines with no END line",
    () => {
      const input = repeatTo("-----BEGIN PRIVATE KEY-----\n", INPUT_LENGTH);
      expect(bestElapsedMs(() => redactSecrets(input))).toBeLessThan(BOUND_MS);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "returns within the bound for BEGIN RSA PRIVATE KEY headers repeated with no newline",
    () => {
      const input = repeatTo("-----BEGIN RSA PRIVATE KEY-----", INPUT_LENGTH);
      expect(bestElapsedMs(() => redactSecrets(input))).toBeLessThan(BOUND_MS);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "returns within the bound for BEGIN ENCRYPTED PRIVATE KEY headers repeated with no newline",
    () => {
      const input = repeatTo("-----BEGIN ENCRYPTED PRIVATE KEY-----", INPUT_LENGTH);
      expect(bestElapsedMs(() => redactSecrets(input))).toBeLessThan(BOUND_MS);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "returns within the same bound for neutral text of the same length",
    () => {
      const input = repeatTo("lorem ipsum dolor sit amet ", INPUT_LENGTH);
      expect(bestElapsedMs(() => redactSecrets(input))).toBeLessThan(BOUND_MS);
    },
    CASE_TIMEOUT_MS,
  );

  it("still masks a well-formed PEM block to the maskToken shape", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAsyntheticFixtureBodyNotARealKey0123456789\n-----END RSA PRIVATE KEY-----";
    const out = redactSecrets(`before ${pem} after`);
    expect(out).toBe("before -----B...---- after");
  });
});
