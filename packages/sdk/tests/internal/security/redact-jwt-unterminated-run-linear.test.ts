/**
 * The JWT entry of BUILTIN_PATTERNS must stay linear on hostile input.
 *
 * A long run of `eyJ` repetitions that the pattern cannot complete (no `.`, a `.` not followed by
 * `eyJ`, or a run of dots after the run) made the first `[A-Za-z0-9_-]{4,}` take the rest of the
 * run from every `eyJ`, give it back one character at a time, and restart at the next `eyJ`, so
 * redaction time grew with the square of the run. Every caller that redacts unbounded text (a
 * serialised tool result, a provider error body) inherits that stall.
 *
 * The bound is generous on purpose: a linear pass over 224000 characters takes single-digit
 * milliseconds (the neutral-text control below), so 100 ms leaves an order of magnitude for host
 * load while the quadratic case sits several orders above it.
 */
import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../../src/internal/security/index.js";

const INPUT_LENGTH = 224_000;
const BOUND_MS = 100;
const CASE_TIMEOUT_MS = 600_000;

function repeatTo(unit: string, length: number): string {
  const s = unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
  expect(s.length).toBe(length);
  return s;
}

/**
 * Best of three runs, warmed once on a short input so JIT compilation is not counted. A run over
 * the bound ends the measurement at once: repeating a quadratic call only spends the timeout, and
 * the first slow run already decides the case.
 */
function bestElapsedMs(input: string): number {
  redactSecrets(input.slice(0, 64));
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 3; i++) {
    const started = performance.now();
    redactSecrets(input);
    best = Math.min(best, performance.now() - started);
    if (best > BOUND_MS) return best;
  }
  return best;
}

describe("redactSecrets on eyJ runs the JWT pattern cannot complete", () => {
  it(
    "returns within the bound for an eyJa run with no dot",
    () => {
      const input = repeatTo("eyJa", INPUT_LENGTH);
      expect(bestElapsedMs(input)).toBeLessThan(BOUND_MS);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "returns within the bound for an eyJa run ending in .x",
    () => {
      const input = repeatTo("eyJa", INPUT_LENGTH - 2) + ".x";
      expect(input.length).toBe(INPUT_LENGTH);
      expect(bestElapsedMs(input)).toBeLessThan(BOUND_MS);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "returns within the bound for an eyJa run filling half the string followed by dots",
    () => {
      const input = repeatTo("eyJa", INPUT_LENGTH / 2) + repeatTo(".", INPUT_LENGTH / 2);
      expect(input.length).toBe(INPUT_LENGTH);
      expect(bestElapsedMs(input)).toBeLessThan(BOUND_MS);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "returns within the same bound for neutral text of the same length",
    () => {
      const input = repeatTo("lorem ipsum dolor sit amet ", INPUT_LENGTH);
      expect(bestElapsedMs(input)).toBeLessThan(BOUND_MS);
    },
    CASE_TIMEOUT_MS,
  );

  it("still masks a well-formed three-segment JWT to the maskToken shape", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(redactSecrets(`before ${jwt} after`)).toBe("before eyJhbG...sw5c after");
  });
});
