# Mutation testing covers only the B-026 spike over `src/internal/llm`

- Status: accepted
- Date: 2026-10-17
- Decided by: human/paulo
- Soft cap dismissed: `auditor_unavailable_d4` (code-quality D4, mutation testing), for B-380
  (`sdk-memory-ceiling`) and for any item whose files sit outside the Stryker scope below

## Context

`stryker.config.json` at the repository root came in with adeba4b1 as a measurement spike for
B-026. It was never wired into a gate. Its scope is narrow on purpose:

- `mutate` is `src/internal/llm/**/*.ts`, nothing else;
- it is meant to run from `packages/sdk` (`pnpm --filter exec`), so `jsonReporter.fileName` is
  `../../reports/mutation/slice.json`;
- `inPlace: true` is required because `packages/sdk/vitest.setup.ts` imports
  `../../tools/preflight-native-bindings.mjs`, which escapes the package, so a sandbox copy fails
  before it collects a test. The same commit records that `inPlace` restores file content but not
  file mode, which strips the executable bit from `bin/*.mjs` entry points.

The kit's code-quality detector D4 looks for a Stryker config in the manifest directory (the
repository root here), runs `stryker run --reporters json` from there, and reads
`reports/mutation/mutation.json`. With this config that file is never written, so D4 reports
`auditor_unavailable_d4` ("stryker ran but wrote no report"). B-380 was the first item in this
repository to reach the code-quality audit, and none of its files is under `src/internal/llm`.
Nothing in B-380 touched the config.

## Decision

Mutation testing in theokit-sdk is the B-026 spike over `src/internal/llm` and nothing more, until
a separate backlog item extends it. D4 cannot measure code outside that scope today, so an item
whose files are outside it carries no mutation measurement, and its audit's
`auditor_unavailable_d4` soft cap is dismissed by this record. Extending Stryker is registered as
its own backlog item (`repo: theokit-sdk`).

This dismisses the cap. It does not claim the uncovered code is well tested: the unit and
integration suites are still the only evidence for it.

## Alternatives rejected

- Extend the Stryker config inside B-380, writing the report to `reports/mutation/mutation.json`
  and mutating the memory files. Rejected because it widens an item that is already executing.
  Runs over `packages/sdk` took minutes per file set, surviving mutants could need new tests, and
  the `inPlace` file-mode risk above would come with it, all for work B-380 never scoped.
- Treat the mismatch as a kit defect (D4 runs from the repository root while the config expects
  `packages/sdk`), report it to the kit and hold B-380 until it is fixed. Rejected because the
  config is a spike that was never adopted as a gate. A kit fix would run Stryker against the same
  `src/internal/llm` glob and still measure nothing B-380 changed.

## Consequences

- Every item outside `src/internal/llm` reaches review with D4 unmeasured and FAIL_SOFT, admitted
  only through this record.
- The record stops applying once the backlog item that extends Stryker lands. At that point it
  should be marked superseded.
