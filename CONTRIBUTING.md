# Contributing to `@theokit/sdk`

Thanks for helping build the Theo **Harness**. The essentials are inline below; the exported TypeScript types are the canonical API contract. The code is the documentation.

By taking part you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md). Security problems do **not** go in an issue — see [SECURITY.md](./SECURITY.md).

## Quick start

```bash
nvm use                                   # Node 22.12+
corepack enable && corepack prepare pnpm@9.15.0 --activate
pnpm install
pnpm validate                             # build + typecheck + test + lint + quality gates
```

`pnpm validate` runs the same gates CI runs. It is **not** the same verdict — see
[The gate you run is not the gate that decides](#the-gate-you-run-is-not-the-gate-that-decides)
before you read a green local run as a green build.

One caveat is worth knowing up front: turbo caches test results per package, and a change to a
**root** file (`package.json`, the lockfile) does not invalidate that cache. After touching a root
dependency, force a real run:

```bash
npx turbo run test --filter='./packages/*' --force
```

## Branch model

The flow is `workspace → develop → main`.

- **All work happens on `workspace`.** Features, fixes, refactors, docs, chores — everything commits there. We do **not** use feature branches by default.
- **`develop` integrates.** It only advances through a `workspace → develop` pull request.
- **`main` is release-only.** It receives release merges (`develop → main` PR + a semver tag) — never direct commits.
- `main` is protected by a ruleset: pull request required, force-push and deletion blocked, and the CI checks must pass before a merge.
- Never use `git checkout` (use `git switch` / `git restore`), `git revert` (write an explicit reversing commit), `git reset --hard` (use `git stash` / `--soft`), or `git push --force` on `main`/`develop`.

## Commit conventions

- Conventional-commit prefixes: `feat` / `fix` / `docs` / `refactor` / `test` / `chore` / `style` / `ci` / `perf` / `build`.
- **No AI co-author trailers** (enforced by a git hook).
- Reference the issue or plan ID when there is one.
- Say *why*, not only *what*. A message that explains the reasoning is the only place that reasoning survives.

## Before you open a PR

- [ ] `pnpm validate` is green locally (or the specific package's `build` + `typecheck` + `test`).
- [ ] **TDD** — the failing test came first; a bug fix ships with its regression test.
- [ ] **Public API changed?** Update the exported types in the same PR — they are the contract.
- [ ] A **changeset** (`pnpm changeset`) if the change is user-visible. Changelogs are generated per package by Changesets under `packages/*/CHANGELOG.md`; there is no root changelog to edit.
- [ ] Lint + format clean (`pnpm check` — Biome).

## Test structure

Structure every test as **Arrange → Act → Assert**, separated by a blank line, no comment markers required:

```ts
it("enters plan mode", () => {
  const tool = createPlanModeTool();

  const result = JSON.parse(tool.handler({ action: "enter" }));

  expect(result.ok).toBe(true);
  expect(result.mode).toBe("plan");
});
```

That is the suite's de-facto style today — measured across all 817 test files, 2.2% carry explicit
`// Arrange` / `// Act` / `// Assert` comments or a `Given/When/Then` test name, but a sampled read
found the same three-part shape present and readable in unmarked files too, just without the labels.
This declares the convention `rules/testing.md` § 3 asks every repo to pick, without demanding a
rewrite: existing files named in `Given/When/Then` style stay as they are — converting them buys
nothing a reader doesn't already have, and the churn isn't worth it. Write new tests as AAA with a
blank line between each part; comment markers are optional and add little once the blank line does
the separating.

## Test names

Name a test after the behaviour, in prose, inside the `it()` that already says "it":

```ts
it("rejects a transfer when the balance is insufficient", () => { … });
```

Not `it("test_transfer_fails_when_balance_insufficient")`. Both forms describe behaviour, so this is
a consistency rule rather than a quality one — but the redundant `test_` prefix inside a function
named `it` reads as *"it test the fork destination is born 0600"*, and the split is large enough to
be worth closing: measured 2026-09-02, **1323 of 5249 test names (25%) carry the prefix once the seven defect-id names are excluded, across 190
of 807 files**, and some files mix both forms within one `describe`.

Same treatment as the AAA section above: **the convention is declared, the rewrite is not demanded.**
Existing names stay. `tests/lint/test-names-are-prose.test.ts` pins the count so the minority form
cannot grow, and asks to be re-pinned downward whenever a file is renamed for other reasons — the
ratchet `tools/check-duplication.mjs` and the complexity budget already use here.

One case earns the prefix and is exempt where it appears: a name whose first token is a defect id
from the issue that produced the test (`test_B1_…`, `test_M2_…`). That id is the traceability the
prose form has nowhere to put, and losing it costs more than the consistency gains.

## File size

`pnpm quality:loc` counts **statements**, from the TypeScript AST. Not lines.

The difference is the whole point. It counted logical lines until 2026-09-02, and a line count is
moved by the formatter, so the cheapest way under it was to reformat. `local-agent.ts` had nine
`biome-ignore format` directives saying exactly that — *"one-liner to stay under G8 LoC budget"*,
*"multi-line layout would push file past G8 LoC cap"* — and one of them produced a 332-character
method on a single line. Removing all nine and letting the formatter run took the file from 381 to
**436** logical lines while changing nothing it does: the same 185 statements, the same
responsibilities.

A file that games its way under a cap is worse than one over it, because the number now says "fine"
about a file nobody has split. Whitespace cannot move a statement count, so the only way past this
gate is to have less in the file.

The limit is **250**, a pinned measurement rather than a target: the largest file in the package is
239 (`internal/mcp/client.ts`), and 8 of 546 are above 200. Re-pin it downward when the maximum
drops — the same ratchet `tools/check-duplication.mjs` and the complexity and parameter budgets use.

**What it does not measure**, since the old wording implied otherwise: a statement count is not a
responsibility count. A 100-statement file doing two unrelated jobs is worse than a 240-statement
file doing one, and this gate prefers the first. It bounds growth; it does not certify design.

## What a wait must be

A test that waits — for a state, a frame, a file — must wait on a signal **the intermediate state
cannot satisfy**, taken from the source the code under test itself consumes.

A fixed sleep fails this: it is satisfied by the passage of time, which the code does not control. So
does a substring that was already present before the change. So does an independent probe of the same
state — that is a second opinion, not the same fact, and it moves the problem one level along.

**Read the message the wait produces when it fails.** If it names only the wait — "never reached X",
"timeout" — the instrument does not know what broke. If it names the value observed against the value
expected, it does:

```
task 1f3c… never reached error          <- reports the wait
task 1f3c… was "finished" — expected error   <- reports the defect
```

The second is the one to write. `tests/helpers/poll-until.ts` accepts a function for its message so it
can be built at failure time from the state the poll actually saw.

## When a check starts working, listen for what complains first

Turning a dormant check back on is measured most reliably not by the check passing, but by **whatever
had quietly adjusted to its absence breaking.**

The API-key shape validator here could not run for any input — the predicate deciding whether a key
reached a provider was false for every key. Turning it back on was proven by two test suites failing:
one used an 8-character key, the other a 7-character one, both against a real provider prefix.
Genuinely malformed, passing for years because nothing could look.

**No amount of reading the code would have shown that.** The validator was present, looked correct,
and did nothing. The only thing that demonstrated its inertia was something else having settled into
the gap.

So when you re-enable a guard, widen a gate's scope, or remove a suppression, **expect breakage and
treat it as the evidence** — then fix what accommodated the gap, not the guard. In the case above the
two suites were about session directories and instance caching; neither was about authentication, so
the keys were changed to the fixture convention they always meant. *Fix the classification, never the
requirement.*

## A permissive default needs its reason written next to it

When two errors cost different amounts, "fail fast" does not settle which way to lean — the asymmetry
does.

The provider check above stays permissive on both unknowns: an unrecognised model identifier or an
unregistered provider skips strictness. The reason, and it is the whole justification:

> Rejecting a **valid** key blocks a user outright. Accepting a **malformed** one for a provider we
> cannot identify merely restores the previous behaviour for that case.

**A permissive default chosen for that reason is a different thing from one inherited by accident, and
the difference exists only while the reason is written down.** An undocumented lenient branch is
indistinguishable from an oversight, and the next person to read it will either harden it blindly or
leave it alone for the wrong reason.

One consequence worth stating, because two changes in this repository look like precedent for each
other and are opposites: a boundary check was once **deleted** on a reachability argument and had to be
restored, while the change above **strengthened** a boundary check and removed a line that had never
validated anything — only a runtime's availability. Same surface, opposite movements.

## A measurement that confirms you gets no second reading

Two instrument bugs on the same night, in two repositories:

- `git ls-remote --tags | tail` sorts **lexicographically**, so `v0.9.0` came back as the newest tag
  when 141 tags existed including `v0.72.0`.
- A coverage join matched repo-relative module paths against `SF:` entries that are
  **package-relative**, so an inverted `endsWith` matched nothing and reported *39 of 39 uncovered*.

Same class of bug. What differed is what happened next — and it was not care.

The first result **contradicted** its author's expectation and still went unchecked, because it
served the issue being written. The second **confirmed** the alarm it was measuring, which is the
position no checking instinct fires from. It was caught for one reason only: *39 of 39 is too clean
to be true.*

**The failure is not carelessness. It is confirmation.** A measurement that agrees with what you were
already going to write does not get a second reading, and that is precisely where the second reading
is cheapest.

The procedure that survives this is small, and it is the one that worked:

> **A number that is too round is a signal.** 39 of 39, zero findings, 100% — each earns the question
> *what would this result look like if the tool were broken?* If the answer is "the same", the
> measurement distinguishes nothing and you have learned only that the command ran.

## A claim about A does not transfer to B

`## Verify before you remove` covers the destructive direction — a premise that justifies deleting
something. There is a **lateral** direction it does not cover: a claim that is *true about the thing
you measured*, applied to a neighbour you did not.

Five real instances, collected across two repositories in one night:

| claim | said by someone who genuinely knew |
|---|---|
| "zero in-repo callers" | the repo — but grepped the wrong subdirectory |
| "the same loop held PR #34" | a CI they had watched |
| "four gates already cover this" | gates that do exist |
| "no mutation tooling exists" | a repo whose dependency had been added two days earlier |
| "your gate is shorter, so the same idle window applies" | a mechanism that had been **proved** — in a different repository |

**In none of the five was anyone guessing.** In every one, someone knew something true and extended
the confidence of that knowledge to an adjacent claim that had not been checked. The last is the
clearest precisely *because* the proof behind it was good: an isolated mechanism, a clean experiment,
three failures and one pass at the moment the variable changed. The extension inherited credit that
only the mechanism had earned. It was wrong — the neighbouring repository has no pre-push hook at all,
so the idle window it was said to have cannot exist there.

**The test takes five seconds and would have caught all five:**

> *Is this sentence about the system I just measured, or about a neighbour of it?*

If it is about the neighbour, **it inherits nothing** — not the confidence, and not the proof.

This is the symmetric inverse of a rule elsewhere in this file. There: *a hit for a reason nobody
chose is not a method.* Here: *a proof for a reason you did choose, applied where that reason does not
reach.*

## Fix the classification, never the requirement

When a gate blocks something it should not, there are two different situations and they take opposite
responses.

**The gate could not classify the case.** Then failing loudly is correct and you verify by hand. The
diff-scoped typecheck in `.githooks/pre-commit` selects zero packages for a documentation-only commit,
and refuses to pass silently — because "zero selected" is genuinely ambiguous: it is either a no-op
change or a stale ref hiding a real diff, and the gate cannot tell which. Teaching it about Markdown
would trade a five-second manual check for a new branch nobody tests.

**The gate classified the case wrongly, with confidence.** Then fix the classification. A sibling
repository had a CHANGELOG gate that called a test fixture production source — not ambiguity, a
pattern that did not know the layout, in the one place that did not know it while `knip.json` and the
testing conventions both already treated `tests/**` as non-production.

The difference matters because the second kind is expensive in a way the first is not. A gate
demanding a public changelog entry for a test-only change invites either a **fabricated entry** —
which pollutes the contract consumers read — or reaching for an override. **Reaching for an override
to satisfy a wrong classification is how a gate stops being taken seriously**, and it does not stop
at that gate.

When you do fix a classification, check both directions. The failure mode is over-exclusion, which
retires the gate silently: confirm the things that *should* still be caught still are.

## While a mutant is applied, the tree is not yours

Mutation testing means editing production source, running something, and restoring it. During that
window the working tree does not say what the repository says — and the rule is **not** "do not
commit". It is stronger:

**No other process may compile, test, lint or inspect the tree while a mutant is applied — reading is
as unsafe as writing.** A concurrent reader corrupts nothing. It *harvests your mutant as a finding*,
and the result has the same shape as a real defect.

Two real incidents, and the second is the dangerous one:

- An agent ran `git add -A` while a mutation run was rewriting `src/**` in place. The result was a
  **1268-file patch** — obvious, caught immediately, harmless.
- A sibling repository ran a five-pass suite loop while a single-line mutant was applied for a few
  seconds. Two of the passes came back `1 failed | 1688 passed` — **exactly the signature of the
  intermittent write race that loop was measuring.** Plausible, and plausible is worse. Without
  knowing when the mutant was applied, those two lines would have confirmed a flakiness claim using
  noise from the measuring instrument itself.

There is a third form, and it is the one that ships a lie. Closing the window with
`git restore <file>` **discards the fix along with the mutant** when both live in the same uncommitted
file. The gates then run green against a tree with no fix in it. In the observed case the only thing
that caught it was `git commit` answering *"nothing to commit"* — a different commit message, or a
`git add` first, and an empty commit would have shipped declaring the bug fixed.

| # | shape | what it produces |
|---|---|---|
| 1 | a snapshot inside the window captures the mutant | a 1268-file patch |
| 2 | a concurrent **reader** harvests the mutant | two runs of `1 failed \| 1688 passed` |
| 3 | the restore that closes the window discards the **fix** | green gates over no fix at all |

Form 3 is worth breaking down further, because the three ways of closing a window differ in whether
anything warns you at all:

| closing the window with | what warns you |
|---|---|
| `git restore <file>` | nothing fails; a later `git commit` says *"nothing to commit"* — a weak signal, and only if you commit before staging |
| `git checkout-index -f -- <file>` | **nothing warns you at all.** The file returns to HEAD and the suite passes, correctly, over unfixed code |
| `cp -f /tmp/bak <file>` | cannot lose the fix — but only if the backup was taken *after* it |

Both of the first two happened here on the same day. Neither had a guard; one of them happened to
produce a side effect. **"Restore carefully" is not a rule, because there is no careful enough
restore** — the only thing that closes the whole class is the ordering: commit the fix before you
measure it.

**One rule covers all three, and it is simpler than any of them: commit the fix BEFORE you measure
it.** Then the window contains exactly one uncommitted thing — the mutant — and `git restore` can
only undo that. There is a second, independent reason: a mutant measured against uncommitted code is
measuring something that does not yet exist anywhere.

So: **declare the window, do not merely observe it.** Write down "mutant applied 02:11, restored
02:13" *before* applying, so contamination is attributable immediately rather than reconstructed
later. Discipline only helps while you remember you are inside a window, and the person who wrote
this rule violated it within the hour, having written it.

**And when judging whether a past result survives a contaminant, ask what it REMOVES as well as what
it adds.** A mutant only adds failures, so a "zero failures" claim is robust to one. A mis-scoped
restore removes a fix, so the same claim is *fragile* to that — it pushes the number green. The two
contaminants push opposite ways and only one of them is intuitive.

Prefer a worktree for anything that mutates. A worktree has its own `src/`, so nothing else on the
machine can read through your window.

## Verify before you remove

A premise that only justifies **keeping** something can be wrong and survive. One that justifies a
**deletion** cannot. So the rule is not "check your claims" — it is: *check the claim that is about to
delete something.*

This is checkable while you read, which is what makes it usable. "Is this claim too strong?" is only
answerable after you have already checked it.

Three removals in this repository were argued from a premise that turned out to be false. Two were
caught; one was not:

| Claim | Reality |
|---|---|
| "`plugins.paths` is undeclarable, so the guard is unreachable" | A contract test supplies it by cast. The guard was deleted and the pre-push gate caught the regression. |
| "the barrel test duplicates four build gates" | None of the four reaches that package. Deleting it would have removed the only coverage of that surface. |
| "this helper has zero in-repo callers" | It had four. |

The mechanism behind all three is worth stating, because it explains why review does not catch them:
**a claim stronger than the argument needs passes unaudited precisely because it is doing no work.**
Nobody re-derives a premise the conclusion does not rest on. "Zero callers" and "four gates already
cover this" both sound settled, and neither was load-bearing until someone reached for the delete key.

One corollary, since it is the most common case here: **the type system is not a runtime.** "The type
forbids it" says a TypeScript caller cannot express the value. A JavaScript caller, a JSON config, or
an `as` cast can. A reachability argument is admissible for an internal call shape and inadmissible
for a boundary check — boundary checks exist for the callers you have not met.

And its silent sibling: **`as` is "the type already guarantees it" without even the argument.** It is
not a reachability claim you can weigh — it is an assertion of reachability with the reasoning
removed. The guard that was deleted here on "the types forbid it" was refuted by a contract test that
supplied the value *by cast*.

## A blanket suppression is a claim about the tool

When a gate is configured to skip a whole tree, that configuration is asserting something: *this tool
produces nothing useful here.* It is rarely written down, it is almost never re-measured, and it is
usually wrong in a specific way — the tool was reporting something real, in a shape nobody wanted to
read, and the suppression was the quickest way to stop reading it.

Measured on `knip` (2026-08-20). `packages/sdk` ignored `src/internal/**` — 527 of this repo's source
files, so a green `quality:dead` had examined the public barrel and little else. Two probes:

| Configuration | Findings |
|---|---|
| committed (`ignore: src/internal/**`) | 0 |
| ignore dropped | 269 |
| ignore dropped + `ignoreExportsUsedInFile: true` | **9** |

knip counts an export as used only when another *file* imports it, so every helper exported for a
same-file reason read as dead. 260 of the 269 were that. The blanket ignore had been standing in for
a setting the tool ships for exactly this case, and in standing in for it, it also hid the nine that
were real.

So before widening a suppression — and certainly before inheriting one — **read the tool's options
for the case you are actually suppressing.** The useful question is not "should this stay ignored?"
but "what is this ignore compensating for?" A suppression that names a mechanism can be checked; one
that names a directory cannot.

Two corollaries this repo now follows:

- **Suppress files, not trees.** The list is down to a single named path, and a single path can be
  audited by reading it. `src/**` cannot.
- **A gate that skips must say so on success** — see
  [A silent gate reports absence it never checked](#a-silent-gate-reports-absence-it-never-checked),
  which is the same failure in four unrelated tools.

## A silent gate reports absence it never checked

A passing gate makes a claim: *I looked, and there was nothing.* When it prints nothing on success,
that claim is indistinguishable from a much weaker one: *I did not look.* The reader cannot tell,
and the reader is usually the person deciding whether it is safe to ship.

This is not one tool's quirk. Four instances, all measured here on 2026-08-19/20, in four tools with
nothing in common:

| Gate | What its green meant | What the reader assumed |
|---|---|---|
| `knip` (`quality:dead`) | swept the public barrel; `src/internal/**` — 527 files — was ignored | the repo has no dead exports |
| a secret scan | `bytes=0` — it had been handed an empty file set | nothing scanned found no secrets |
| a test-execution gate | `PASS` with zero languages detected, so no suite ran at all | the suite ran and passed |
| `.githooks/pre-commit` G1 | *(after the fix)* no TypeScript staged, nothing to typecheck | types were checked |

The first three each cost a backlog item to find. The fourth was written to announce itself from the
start — `→ G1: SKIPPED — no TypeScript staged, so there is nothing to typecheck.` — because by then
the pattern had a name.

So when you add or change a gate:

- **Print the scope on success, not only the failures.** `depcruise` says "541 modules cruised";
  `biome` says "Checked 1701 files". Those numbers are what makes their green legible. A gate that
  reports only when angry cannot be audited.
- **Skipping is a legitimate outcome — reporting it is not optional.** "Nothing to check" and
  "checked, all clean" are different results and must read differently.
- **Distrust a zero.** Zero findings, zero files, zero packages selected: each is either good news or
  a broken instrument, and the two are indistinguishable until the gate says which. When a count
  surprises you by being clean, ask what this result would look like if the tool were broken.

The counterpart failure is in [A measurement that confirms you gets no second
reading](#a-measurement-that-confirms-you-gets-no-second-reading) — a silent gate is that trap built
into the tooling, where it fires on everyone rather than on whoever ran the command.

## "No consumer" is a claim about your search, not about the world

This package is published. Its callers are mostly not in this repository, so a question of the form
*does anything use this?* cannot be answered by searching this repository — and the search will
answer anyway, with a number, confidently.

Measured 2026-09-02 (usetheokit/theokit-sdk#521). An audit reported **nine public primitives with
zero consumers**, having grepped `packages/` and `apps/` across all 16 packages here. The grep was
correct. The conclusion was false for five of the nine:

| What the audit found | What was actually true |
|---|---|
| `applySecurityFloor`, `auditEnvReachability`, `foldLayers`, `verifyLayerOrdering` — 0 callers | re-exported in production by `@theokit/agents` (`usetheokit/theokit`), which **raised its dependency floor to `^4.49.0`** specifically to get them |
| `loadProjectEnv` — 0 callers | called from a shipped `create-theokit` template, so **every scaffolded project** calls it |
| the remaining four — 0 callers | true, and each already carries a recorded downstream verdict with an owner or a policy |

**Seven repositories in the organisation depend on `@theokit/sdk`** — `theokit`, `theokit-di`,
`theokit-gateways`, `theokit-plugins`, `theokit-skills`, `theokit-studio`, `theokit-tui`. The audit
measured none of them, and nothing about its output said so.

The template case has no tool that can see it at all. [A blanket suppression is a claim about the
tool](#a-blanket-suppression-is-a-claim-about-the-tool) records that *"knip counts an export as used
only when another file imports it"* — and a `.tmpl` is a string until someone scaffolds it, so no
import graph contains it. That is not a setting anyone forgot; it is outside what an import graph can
represent.

So before writing "no consumer" about anything on a published surface:

- **Search the seven, not the one.** `gh api -X GET search/code -f q='<symbol> org:usetheokit'` costs
  one request and is the whole difference. Code search sees public repositories only — say so when
  the answer is zero, because private and unpublished callers stay invisible.
- **Read the downstream verdict table before forming one of your own.**
  `usetheokit/theokit` maintains `packages/agents/tests/unit/root-bar-coverage.test.ts`, which
  demands an explicit verdict for **every value on this SDK's root bar** and proves the `in` ones by
  referential identity. It distinguishes "nobody decided yet" from "we decided it stays out", which
  is the distinction an upstream guess destroys.
- **Grep the templates too.** `packages/*/templates/**` in the consumer repos ships code that no
  import graph contains.
- **A zero here is a scope report, not a finding.** Write what was searched next to it, so the next
  reader can see the boundary of the claim instead of inheriting the number.

The wider version of this is [A claim about A does not transfer to
B](#a-claim-about-a-does-not-transfer-to-b): a measurement over one tree says nothing about a tree it
never opened, however carefully it was run.

## The gate you run is not the gate that decides

A green `pnpm validate` says the gates passed **in your working tree**. CI says they passed in a
fresh clone. Those are different claims, and the gap between them is not exotic — it is made of the
two things your tree has that a clone does not: files git is not tracking, and build output you
produced earlier.

Measured here on 2026-08-20: **twenty consecutive commits landed against a green local gate while CI
was red the entire time.** Nobody looked. Two independent causes, neither in test logic:

| Cause | Why local could not see it |
|---|---|
| `.gitignore` had `.theokit/` unanchored, so it matched at **any** depth — including the test fixture repos under `packages/sdk/tests/fixtures/repos/*/.theokit/`. Those fixtures were never committed. | The files are on your disk. The suite reads them and passes. A clone has no fixtures and the suite fails. |
| The `coverage floors` CI job had no build step, while `validate` did. | Your `dist/` is already there from the last build. |

Both are the same shape: **the local run consumed something the repository does not contain.** A
suite that passes only where someone has already worked is not passing.

So, as discipline:

- **Read the run.** `gh run list --repo <owner>/<repo> --branch <branch> --limit 5` after a push, and
  actually wait for it. A push whose CI you did not read is a change whose status you do not know.
- **A green local gate is evidence, not a verdict.** It is the fast check that catches most things,
  which is exactly why it is easy to mistake for the decision.
- **When local and CI disagree, CI is right by construction.** It is the one running against what you
  actually shipped. The question is never "why is CI wrong", it is "what does my tree have that the
  clone does not".
- **Adding a file to a fixture? Confirm git tracks it** — `git check-ignore -v <path>` names the rule
  and line that would swallow it. An unanchored pattern in `.gitignore` matches at every depth, and
  the failure is silent in the only direction that matters.

## Prerelease mode goes on a branch that is not the release line

`changeset pre enter` is a mode, not a command: once `.changeset/pre.json` exists on a branch, every
`changeset version` on it produces `-next.N` versions and every entry is written into the
prerelease section. Exiting is what hurts, and it hurts three ways at once.

This repository entered prerelease mode **on `main`** on 2026-08-31 and exited on 2026-09-04. Four
days, and each of the following was measured rather than predicted:

| What broke | Mechanism |
|---|---|
| Ten of twelve packages shipped `5.0.0` with an **empty CHANGELOG section** (#565) | on exit, the stable version inherits the number and none of the content — the entries stay in the `-next.N` section one line below |
| Cutting `5.0.1` would have published **`6.0.0`** (#566) | while `mode: pre`, the CLI ignores `.changeset/pre/`; on exit it reads that directory again, so all 54 archived changesets — including the major behind `5.0.0` — became live |
| The **snapshot path stopped working**, silently | `changeset version --snapshot` refuses outright in pre mode, in a path nothing runs on a schedule, so nothing reported it for four days |

The third is the one worth sitting with. Prerelease mode and snapshot releases are alternatives to
each other, and turning one on turned the other off without saying so.

### What everyone else does

Six repositories that publish multi-package monorepos with changesets, read from their committed
configs and workflows on 2026-09-05:

| Repository | Stable line | Prerelease lives on | `pre.json` on the stable branch |
|---|---|---|---|
| `withastro/astro` | `main` | `next` / `*-legacy` branches, plus `pkg-pr-new` previews per PR label | no |
| `apollographql/apollo-client` | `main` | `release-*` branches, with `prerelease.yml`, `exit-prerelease.yml`, `change-prerelease-tag.yml` | no |
| `sveltejs/kit` | `main` — 2.70.3 | `version-3` — 3.0.0-next.26, permanently `{"mode":"pre","tag":"next"}` | no |
| `emotion-js/emotion` | `main` | — | no |
| `chakra-ui/chakra-ui` | `main` | — | no |
| `radix-ui/primitives` | `main` | — | no |

Not one runs prerelease mode on the branch that carries its stable line. `sveltejs/kit` is the
sharpest case: it stays in pre mode *indefinitely*, and still keeps `main` free of it, because the
2.x line has to keep releasing while 3.x is in `next`.

The `next` and `release-*` branches do not exist in those repositories today — they are created for
a version line and deleted when it ships, while the workflows stay configured, waiting. The
changesets documentation says the same thing in the other direction: it *"thoroughly recommends only
running prereleases from a branch other than the default branch"*, because otherwise prerelease mode
*"will block other changes until you exit"*.

### So

- **A prerelease line gets its own branch.** `next`, `v6`, `release-6.0` — a name, and `release.yml`
  listing it beside `main`. Never `pre enter` on the branch the current line releases from.
- **For "I need this on the registry to test it", use the snapshot path**, not prerelease mode. It
  already exists — `workflow_dispatch` with a `snapshot` dist-tag — publishes under a tag that is
  never `latest`, and leaves no trace in the repository. That is what prerelease mode was being used
  for here, and it is the cheaper tool for it.
- **If a prerelease line is genuinely needed, expect the exit to be an event**, not a formality:
  `.changeset/pre/` reactivates, and the stable sections inherit empty. Read `changeset status`
  before the cut — that is what caught the accidental `6.0.0`.

## A blocked consumer gets a snapshot, not a wait

When you land a fix that some consumer is blocked on, **cut a snapshot at the merge instead of
waiting for the release**. Say the version; they measure the same day.

This is not a new idea here — `5.1.0-compat-581-20260905211819` was measured against days before
`5.1.0` reached `latest`. What was missing was writing down that it is *the path*, rather than what
happens when somebody remembers.

**The reason is not their convenience, it is yours.** The release path is merge → Version PR →
publish, three runs in series, and only after all three does anyone find out whether what you
published works. A snapshot moves that answer to before the publish. Measured on 2026-09-06: three
consumer issues sat blocked while exactly that sequence ran, and the fix that shipped in 5.2.0 had a
defect a consumer found within the hour — a defect a snapshot measurement would have caught before
`latest` moved.

### Two things this convention depends on, and both were broken until recently

**The snapshot version must sort ABOVE the release it is cut from.** `changeset version --snapshot`
defaults to a `0.0.0-` base, and semver compares `major.minor.patch` before it looks at a prerelease
suffix — so every snapshot this repository published sorted *below* every real release. A consumer
with a version floor read it as older and silently disabled the very feature the snapshot existed to
deliver:

```
`compatSources` was declared, but @theokit/sdk@0.0.0-compat-580-… does not know that option and
will ignore it. It landed in 5.0.0.
```

`snapshot.useCalculatedVersion: true` in `.changeset/config.json` is what makes the convention
possible at all. Do not remove it without reading that paragraph again.

**Confirm the snapshot in the registry before naming it.** The workflow going green is not the same
statement as "your consumer can install this". Registry metadata registers minutes before the tarball
propagates — measured, a version absent 3.5 minutes after a *successful* publish, present at ~135
seconds after that. Concluding "publish failed" in that window leads to republishing a version that
already exists, and an npm version is immutable.

### The rules that keep it from becoming a shortcut

1. **A snapshot pin never reaches `develop`.** It is measurement scaffolding. A snapshot can be
   unpublished, and a versioned file pointing at one is a build that breaks later for a reason nobody
   will connect to this.
2. **Measuring against a snapshot does not close an issue.** It proves the fix works. `in-develop`
   and the close still wait for `latest` — *fixed* and *installable* are different claims.
3. **Bump the pin BEFORE running any check.** Otherwise the check measures the old tree and reports
   `blocked` with complete accuracy about the wrong thing.
4. **Return the result, including the failure.** It is the only thing the snapshot buys.

### Why not link the sibling checkout

Because under changesets the `version` field only moves at release. A linked checkout can carry a fix
in `HEAD` while its `package.json` still says the previous version — so a check reads the right code
and reports the wrong version, confidently. Measured on 2026-09-06: the tree said `5.1.0` while HEAD
already carried what shipped as `5.2.0`.

A string like `5.1.0-compat-581-<timestamp>` cannot be mistaken for anything else. That is the
property worth paying for.

Convention proposed by the `theocode` session, which measured the three linking routes and rejected
all of them before proposing this one.

## Quality gates

The push is gated locally by `.githooks/pre-push`, and again in CI. Every gate is one tool, and the rule is **fix the code, not the threshold**:

| Gate | Command | What it refuses |
| --- | --- | --- |
| Lint / format | `pnpm check` | Biome findings |
| Types | `pnpm typecheck` | any type error |
| Tests | `pnpm test` | a failing or newly skipped test |
| Dead code | `pnpm quality:dead` + `quality:dead-internal` | unreachable exports, dead private symbols |
| Cycles | `pnpm quality:cycles` | any import cycle (threshold 0) |
| Layering | `pnpm quality:depcruise` | a dependency pointing the wrong way |
| Cluster boundary | `pnpm quality:cross-cluster` | importing an extracted sibling repo |
| File size | `pnpm quality:loc` | a source file over 250 **statements** (not lines — see § File size) |
| Duplication | `pnpm quality:duplication` | a copied block in `packages/sdk/src` |
| Docs drift | `pnpm quality:doc-api` | a documented import that no longer resolves |
| Declaration typecheck | `pnpm quality:dts-typechecks` | a published `.d.ts`/`.d.cts` that does not compile without `skipLibCheck` |
| Export parity | `pnpm quality:dts-parity` | a name the source barrel exports and the emit omits |
| Nominal dts identity | `pnpm quality:dts-identity` | one exported class declared twice across published entries, so the two are incompatible types |
| Orphaned docblocks | `pnpm quality:doc-orphans` | a JSDoc block stranded above another, attaching to nothing |
| Tag-first docblocks | `pnpm quality:doc-tag-first` | a JSDoc block opening with an unknown `@tag`, so TypeScript files the whole text under that tag and the symbol ships undocumented |
| Doc coverage | `pnpm quality:doc-coverage` | a public export with no documentation (floor: 100%) |
| Generated references | `pnpm quality:docs-map` + `quality:docs-errors` | the committed capability map or error-code reference has drifted from the build |
| Dependencies | `pnpm quality:audit` | a known vulnerability in a shipped dependency |
| Bundle size | `pnpm check:bundle` | a package over its `.bundle-budget.json` |

CI adds a Node `22.12` / `22` matrix, CodeQL, dependency review on pull requests, and an OpenSSF Scorecard run.

## Where things live

`theokit-sdk` is a pnpm-workspaces + turbo monorepo of 12 publishable packages (flagship `@theokit/sdk` at `packages/sdk/`). Layout and the contract-vs-implementation split: [`packages/README.md`](./packages/README.md).

## Getting help

Open an issue — the [templates](https://github.com/usetheokit/theokit-sdk/issues/new/choose) ask for the details that make a report actionable. A heads-up before a large change is welcome and usually saves you a rewrite.
