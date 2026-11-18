import { createRequire } from "node:module";
import { resolve } from "node:path";

import { expect, it } from "vitest";

import { ROOT, readRootFile } from "./lockfile-versions.mts";

/*
 * GHSA-fc5q-39xc-vjpf: a repeated extglob with one branch, such as `+(*a)`, makes every picomatch
 * up to 4.0.7, the 2.x line included, build a regular expression that backtracks exponentially.
 * No release fixes it, so `quality:audit` failed on both halves. The root overrides send every
 * affected picomatch to a patched copy in `vendor/` (see the README in each).
 *
 * These checks fail offline: the lockfile must resolve picomatch only to those copies, and each
 * copy must answer the hostile patterns in linear time while matching what they describe.
 */

const COPIES = ["vendor/picomatch", "vendor/picomatch-2"] as const;
const HOSTILE = ["+(*a)", "*(*a)"] as const;
// 4.0.7 and 2.3.2 take tens of seconds on 28 characters and get four times slower with every two
// more; the copies answer in milliseconds.
const INPUT = `${"a".repeat(28)}b`;

interface Picomatch {
  (glob: string): (input: string) => boolean;
  makeRe(glob: string): RegExp;
}

function load(copy: string): Picomatch {
  return createRequire(resolve(ROOT, copy, "package.json"))(resolve(ROOT, copy)) as Picomatch;
}

it("the lockfile resolves picomatch only to the vendored copies", () => {
  const keys = [...readRootFile("pnpm-lock.yaml").matchAll(/^ {2}picomatch@(\S+?):(?: \{\})?$/gm)].map(
    (match) => match[1],
  );

  expect(keys.length, "pnpm-lock.yaml resolves no picomatch at all").toBeGreaterThan(0);
  expect(keys.filter((key) => !key.startsWith("file:vendor/picomatch"))).toEqual([]);
});

for (const copy of COPIES) {
  for (const glob of HOSTILE) {
    it(`${copy} rejects a non-matching input for ${glob} in linear time`, () => {
      const re = load(copy).makeRe(glob);
      const started = performance.now();
      const matched = re.test(INPUT);

      expect(performance.now() - started).toBeLessThan(1_000);
      expect(matched).toBe(false);
    });
  }

  it(`${copy} still matches what +(*a) describes`, () => {
    const isMatch = load(copy)("+(*a)");

    expect(isMatch("banana")).toBe(true);
    expect(isMatch("bananas")).toBe(false);
  });
}
