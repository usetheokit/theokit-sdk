/**
 * Must-not-regress guard for the PEM masking of `redactSecrets`.
 *
 * Every expected string below was produced by running `redactSecrets` at `1456fee2`, while the PEM
 * entry of BUILTIN_PATTERNS was still the lazy `[\s\S]+?` regex, and pasted as a literal. The guard
 * was committed green against that regex before the regex was replaced, so a replacement that
 * masks any of these inputs differently fails here, including the regex's surprising cases: a
 * second BEGIN absorbed into the first block, a foreign END skipped as content, and headers with
 * nothing between them masked through to a later END.
 */
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { maskToken, redactSecrets } from "../../../src/internal/security/index.js";

const CASES: ReadonlyArray<{ name: string; input: string; expected: string }> = [
  {
    name: "plain label",
    input:
      "a -----BEGIN PRIVATE KEY-----\nMIIEowIBAAKCAQEAsyntheticFixtureBody\n-----END PRIVATE KEY----- z",
    expected: "a -----B...---- z",
  },
  {
    name: "RSA label",
    input:
      "a -----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAsyntheticFixtureBody\n-----END RSA PRIVATE KEY----- z",
    expected: "a -----B...---- z",
  },
  {
    name: "EC label",
    input:
      "a -----BEGIN EC PRIVATE KEY-----\nMIIEowIBAAKCAQEAsyntheticFixtureBody\n-----END EC PRIVATE KEY----- z",
    expected: "a -----B...---- z",
  },
  {
    name: "DSA label",
    input:
      "a -----BEGIN DSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAsyntheticFixtureBody\n-----END DSA PRIVATE KEY----- z",
    expected: "a -----B...---- z",
  },
  {
    name: "OPENSSH label",
    input:
      "a -----BEGIN OPENSSH PRIVATE KEY-----\nMIIEowIBAAKCAQEAsyntheticFixtureBody\n-----END OPENSSH PRIVATE KEY----- z",
    expected: "a -----B...---- z",
  },
  {
    name: "ENCRYPTED label",
    input:
      "a -----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIEowIBAAKCAQEAsyntheticFixtureBody\n-----END ENCRYPTED PRIVATE KEY----- z",
    expected: "a -----B...---- z",
  },
  {
    name: "several spaces",
    input:
      "a -----BEGIN   RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAsyntheticFixtureBody\n-----END    RSA PRIVATE KEY----- z",
    expected: "a -----B...---- z",
  },
  {
    name: "differing labels",
    input:
      "a -----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAsyntheticFixtureBody\n-----END EC PRIVATE KEY----- z",
    expected: "a -----B...---- z",
  },
  {
    name: "two blocks",
    input:
      "a -----BEGIN PRIVATE KEY-----\nMIIEowIBAAKCAQEAsyntheticFixtureBody\n-----END PRIVATE KEY----- m -----BEGIN EC PRIVATE KEY-----\nMIIEowIBAAKCAQEAsyntheticFixtureBody\n-----END EC PRIVATE KEY----- z",
    expected: "a -----B...---- m -----B...---- z",
  },
  {
    name: "BEGIN BEGIN END",
    input:
      "a -----BEGIN PRIVATE KEY-----\nMIIEowIBAAKCAQEAsyntheticFixtureBody\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAsyntheticFixtureBody\n-----END PRIVATE KEY----- z",
    expected: "a -----B...---- z",
  },
  {
    name: "zero gap then later END",
    input: "a -----BEGIN PRIVATE KEY----------END PRIVATE KEY----- m -----END PRIVATE KEY----- z",
    expected: "a -----B...---- z",
  },
  {
    name: "foreign END inside",
    input:
      "a -----BEGIN PRIVATE KEY-----\nMIIEowIBAAKCAQEAsyntheticFixtureBody\n-----END CERTIFICATE-----\nMIIEowIBAAKCAQEAsyntheticFixtureBody\n-----END PRIVATE KEY----- z",
    expected: "a -----B...---- z",
  },
  {
    name: "key into END",
    input: "a -----BEGIN PRIVATE KEY-----\nsk-ant-abcdefghijklmnop-----END PRIVATE KEY----- z",
    expected: "a -----B...---- z",
  },
  {
    name: "BEGIN no END",
    input: "a -----BEGIN PRIVATE KEY-----\nMIIEowIBAAKCAQEAsyntheticFixtureBody\n z",
    expected: "a -----BEGIN PRIVATE KEY-----\nMIIEowIBAAKCAQEAsyntheticFixtureBody\n z",
  },
  {
    name: "zero gap no later END",
    input: "a -----BEGIN PRIVATE KEY----------END PRIVATE KEY----- z",
    expected: "a -----BEGIN PRIVATE KEY----------END PRIVATE KEY----- z",
  },
  {
    name: "tab after BEGIN",
    input:
      "a -----BEGIN\tPRIVATE KEY-----\nMIIEowIBAAKCAQEAsyntheticFixtureBody\n-----END PRIVATE KEY----- z",
    expected:
      "a -----BEGIN\tPRIVATE KEY-----\nMIIEowIBAAKCAQEAsyntheticFixtureBody\n-----END PRIVATE KEY----- z",
  },
  {
    name: "tab after END",
    input:
      "a -----BEGIN PRIVATE KEY-----\nMIIEowIBAAKCAQEAsyntheticFixtureBody\n-----END\tPRIVATE KEY----- z",
    expected:
      "a -----BEGIN PRIVATE KEY-----\nMIIEowIBAAKCAQEAsyntheticFixtureBody\n-----END\tPRIVATE KEY----- z",
  },
  {
    name: "lowercase",
    input:
      "a -----begin private key-----\nMIIEowIBAAKCAQEAsyntheticFixtureBody\n-----end private key----- z",
    expected:
      "a -----begin private key-----\nMIIEowIBAAKCAQEAsyntheticFixtureBody\n-----end private key----- z",
  },
  {
    name: "two spaces label",
    input:
      "a -----BEGIN RSA  PRIVATE KEY-----\nMIIEowIBAAKCAQEAsyntheticFixtureBody\n-----END RSA  PRIVATE KEY----- z",
    expected:
      "a -----BEGIN RSA  PRIVATE KEY-----\nMIIEowIBAAKCAQEAsyntheticFixtureBody\n-----END RSA  PRIVATE KEY----- z",
  },
  {
    name: "six dashes",
    input:
      "a ------BEGIN PRIVATE KEY-----\nMIIEowIBAAKCAQEAsyntheticFixtureBody\n-----END PRIVATE KEY----- z",
    expected: "a ------B...---- z",
  },
];

/** The PEM entry of BUILTIN_PATTERNS at `1456fee2`, copied verbatim as the oracle. */
const OLD_PEM =
  /-----BEGIN[ ]+(?:RSA |EC |DSA |OPENSSH |ENCRYPTED |)PRIVATE KEY-----[\s\S]+?-----END[ ]+(?:RSA |EC |DSA |OPENSSH |ENCRYPTED |)PRIVATE KEY-----/g;

const LABELS = ["", "RSA ", "EC ", "OPENSSH ", "ENCRYPTED "];
const SPACINGS = [" ", "  ", "\t"];
const header = (kind: "BEGIN" | "END") =>
  fc
    .tuple(fc.constantFrom(...SPACINGS), fc.constantFrom(...LABELS))
    .map(([space, label]) => `-----${kind}${space}${label}PRIVATE KEY-----`);
/** Header-shaped fragments and filler with no key-shaped text, so no other pattern fires. */
const FRAGMENT = fc.oneof(
  header("BEGIN"),
  header("END"),
  fc.constant("-----END CERTIFICATE-----"),
  fc.constantFrom("-", " ", "\n", "x"),
);

const BOUND_MS = 100;
const INPUT_LENGTH = 224_000;

/** Best of three runs, warmed once, stopping at the first run over the bound. */
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

describe("redactSecrets keeps its PEM output", () => {
  it.each(CASES)("$name", ({ input, expected }) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it("matches the lazy regex on random header fragments", () => {
    fc.assert(
      fc.property(fc.array(FRAGMENT, { minLength: 1, maxLength: 8 }), (fragments) => {
        const s = fragments.join("");
        expect(redactSecrets(s)).toBe(s.replace(OLD_PEM, (m) => maskToken(m)));
      }),
      { seed: 20261022, numRuns: 2000 },
    );
  });

  it("returns within the bound for many well-formed blocks", () => {
    const unit = "-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----\n";
    const input = unit.repeat(3672);
    expect(input.length).toBe(223_992);
    expect(redactSecrets(input)).toBe("-----B...----\n".repeat(3672));
    expect(bestElapsedMs(() => redactSecrets(input))).toBeLessThan(BOUND_MS);
  });

  it("returns within the bound for BEGIN followed by long space runs", () => {
    const unit = `-----BEGIN${" ".repeat(1000)}X`;
    const input = unit.repeat(Math.ceil(INPUT_LENGTH / unit.length)).slice(0, INPUT_LENGTH);
    expect(redactSecrets(input)).toBe(input);
    expect(bestElapsedMs(() => redactSecrets(input))).toBeLessThan(BOUND_MS);
  });
});
