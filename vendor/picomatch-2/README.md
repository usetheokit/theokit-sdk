# picomatch 2.3.2 with the fix for GHSA-fc5q-39xc-vjpf

This is [picomatch](https://github.com/micromatch/picomatch) at tag `2.3.2` with the same two changes
as `vendor/picomatch` (4.0.7 there), ported to the 2.x code: `classifyWildcardStarBranch` in
`lib/parse.js`, and a linear `removeBackslashes` in `lib/utils.js`. The root `package.json` points
every `picomatch` from 2.0.0 to 2.3.2 in this repository at it (`pnpm.overrides`).

## Why

The advisory covers every release up to 4.0.7, and the 2.x line is no exception: 2.3.2 ships the same
repeated-extglob analysis as 4.0.7 (it was backported there) and the same backtracking. On
`+(*a)` against 24 characters that do not match, 2.3.2 takes 3.2 s, and four times longer with every
two more. `jscpd` brings it in through `@jscpd/finder`, `fast-glob` and `micromatch`, so the second
half of `quality:audit` (`pnpm audit --audit-level=high`, development dependencies included) failed.

## How it was checked

- 2.3.2 already has `analyzeRepeatedExtglob`, `splitTopLevel` and the `analysis.risky` branch in
  `lib/parse.js`, so the 4.x patch applies at the same three places.
- Upstream's suite at tag `2.3.2` passes on this copy: 1,972 tests, the same count as on 2.3.2.
- Random `+(X)` and `*(X)` globs whose body has a `*`, against random inputs of up to 6 characters
  over `a`, `b` and `/`: 800,000 comparisons with 2.3.2, no difference.
- `removeBackslashes` against the regular expression it replaces: 300,000 random strings over `[`,
  `]`, `\`, a newline and letters, no difference; `'*' + '['.repeat(60000)` takes 13 ms.
- `tools/tests/picomatch-is-past-the-extglob-redos-advisory.test.mts` takes about 11 s per pattern on
  2.3.2 and milliseconds on this copy.

## When it goes

When picomatch publishes a 2.x release with the fix, or when nothing in this repository depends on
2.x any more: delete this directory and its override, and update the advisory test.

The code is MIT, Copyright (c) 2017-present, Jon Schlinkert. See `LICENSE`.
