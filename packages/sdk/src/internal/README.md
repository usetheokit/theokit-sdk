# `src/internal/` — subsystem entry points

## Which subsystems expose a barrel, and what that means

Seven of the ~25 subsystems here have an `index.ts`: `cloud-agent`, `local-agent`, `persistence`,
`plugins`, `providers`, `security`, `session`. The rest are entered by direct path.

**That split is documented rather than resolved, and the reason is measured.** An audit recommended
adopting one rule — every subsystem exposes `index.ts`, and cross-subsystem imports go through it,
enforced by dependency-cruiser — on the grounds that deep-path imports are what let two folders reach
into each other's internals. Fifteen mutually-dependent folder pairs were confirmed by measurement.
Applying the rule was then measured too, and it does not hold:

- **129 imports currently bypass an existing barrel** (57 into `persistence`, 22 each into
  `providers` and `plugins`, 20 into `security`, 6 into `session`, 2 into `local-agent`).
- **Routing them through the barrel would create file-level cycles.** `internal/local-agent/index.ts`
  transitively reaches `internal/runtime/lifecycle/` and `internal/session/`, and both of those import
  into `local-agent`. Today `madge --circular` reports **zero** cycles in `src/`; making the barrel the
  entry point would introduce them.
- **Five of the fifteen pairs are parent↔child** (`memory` ↔ `memory/storage`, `providers` ↔
  `providers/builtin`, `telemetry` ↔ `telemetry/adapters`, `system-prompt` ↔ `system-prompt/sources`,
  `subscription` ↔ `subscription/internal`). A barrel does not address those; a parent importing its
  child and the child importing the parent's types is ordinary.

A barrel is a module that depends on its entire subsystem. Routing a cross-subsystem import through
one **widens** the dependency surface — which is the opposite of the intent.

## What is enforced instead

`tests/architecture/no-cycles-at-all.test.ts` asserts the whole graph is acyclic. That is the property
the barrel proposal was reaching for, stated directly. It did not exist before: three sibling files
each pinned ONE historical cycle, so a new cycle anywhere else passed every architecture test.

## When to add a barrel

When a subsystem has a genuine public face that its consumers should hold instead of its internals —
`security` is the example, and its consumers all import downward into it. Not as a blanket rule, and
not for a subsystem whose consumers it imports back.

## What `internal` means here — three meanings, only one of them "private"

An audit read this folder as ambiguously named: 16 sites where something published comes out of a
folder called `internal`, against a threshold of 0. The count is right. The name is not ambiguous —
it carries three distinct meanings, none of which was written down, which is the actual defect.

| # | Shape | What `internal` marks | Count |
|---|---|---|---|
| 1 | `src/index.ts` re-exports from `./internal/…` | the SYMBOL is public at a stable specifier (`@theokit/sdk`); only its MODULE PATH is not an import contract | 12 |
| 2 | a published `./internal/*` subpath | the surface is deliberately **semver-exempt** — the word `internal` in the specifier IS the warning | 3 |
| 3 | everything else | genuinely private | the rest |

**(1) is not a leak.** `BudgetTracker`, `MemoryProvider`, `withCwdMutex` and the other nine are public
API. What `internal/` buys is the freedom to move `internal/budget/tracker/budget-tracker.ts` without
breaking anyone, because nobody may import that path. Moving the twelve files to `src/` root would
publish twelve module paths that are currently free to move; adding twelve one-line facade files at
`src/` root would add indirection and change nothing about where the code lives.

**(2) is an escape hatch, and the three are not alike.** `security` also has a
STABLE facade at `src/security.ts` — the subpath is the raw channel and the
facade is the semver-protected promotion of the parts consumers asked for. (`persistence` used to be a
fourth; its `./internal/persistence` subpath was removed in the next major, and `@theokit/sdk/persistence`
is the supported replacement.) `memory-adapters` and
`memory-store` deliberately have no facade: they are shared-kernel channels to `@theokit/sdk-memory`,
whose surface moves per release, and `tests/peer-range-floors.test.ts` pins the exact SDK floor each
satellite needs precisely because there is no stable contract. A facade there would promise stability
the design refuses to give.

So the risk is not the three that exist — it is a fifth appearing without anyone deciding which kind it
is. `tests/lint/internal-subpaths-are-declared.test.ts` holds that line: every `./internal/*` subpath
in `package.json` must be listed above with its kind, and a new one fails until someone writes down
which it is.
