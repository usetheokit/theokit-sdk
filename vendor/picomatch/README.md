# picomatch 4.0.7 with the fix for GHSA-fc5q-39xc-vjpf

This is [picomatch](https://github.com/micromatch/picomatch) at tag `4.0.7` with two changes: the fix
proposed upstream in [micromatch/picomatch#266](https://github.com/micromatch/picomatch/pull/266)
(commit `cad55d0`) in `lib/parse.js`, and a linear `removeBackslashes` in `lib/utils.js`. It is the
same copy as `vendor/picomatch` in usetheokit/theokit (#2183 there). The root `package.json` points
every `picomatch` from 4.0.0 to 4.0.7 in this repository at it (`pnpm.overrides`).

## Why

[GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) (high): a repeated extglob
with one branch, such as `+(*a)` or `*(*a)`, compiles to a regular expression that backtracks
exponentially. Every release up to 4.0.7 is affected and none is fixed. `jscodeshift`, which
`packages/codemod-sdk-3-0` depends on, brings 4.0.7 into the production tree, so the first half of
`quality:audit` (`pnpm audit --prod --audit-level=low`) failed with no version to move to.

The patch adds `classifyWildcardStarBranch` to `lib/parse.js`: a single-branch repeated extglob whose
body ends in `*` is either compiled as `@(...)`, which matches the same strings, or treated as a
literal when it cannot be. The linear `removeBackslashes` replaces a regular expression that rescans
to the end of the string from every `[` that never closes (CodeQL `js/polynomial-redos`).

`tools/tests/picomatch-is-past-the-extglob-redos-advisory.test.mts` takes about 51 s per pattern on
4.0.7 and milliseconds on this copy. Upstream's suite passes on it: 1,988 tests, against 1,983 on 4.0.7
(the five new ones come with the patch).

## What it does not cover

A project that installs a published `@theokit/*` package resolves `picomatch` from the registry, and
gets 4.0.7 until upstream releases a fix.

## When it goes

When picomatch publishes a release with both fixes: delete this directory, its override and the
`!vendor` entry in `biome.json` (when `vendor/picomatch-2` goes too), and update the advisory test.

The code is MIT, Copyright (c) 2017-present, Jon Schlinkert. See `LICENSE`.
