# `@theokit/sdk` — `internal/security/`

Security primitives shared across the SDK: secret redaction at output boundaries (`redactSecrets`), path containment guards (`safePathJoin`, `sanitizeIdentifier`, `createExclusive`), and per-cwd CAS helpers. These primitives are wired at every leaky boundary — telemetry attrs, error `metadata.raw`, transcript appends, migration logger output, config persistence.

## Files

| File | Responsibility |
|---|---|
| `redact.ts` | `redactSecrets` — canonical credential masking with built-in pattern set + extensible `addPattern` API (ADRs D68-D73) |
| `path-guard.ts` | `safePathJoin`, `sanitizeIdentifier`, `createExclusive`, `casUpdate` — path traversal + race protection (ADRs D79-D85) |
| `shell-command-line.ts` | `readShellCommandLine` — splits a shell line into the commands it runs, for `parsePermissionRules` (not exported from the barrel) |
| `test-reset.ts` | Test seam — resets internal redact state between tests (NOT public API) |
| `index.ts` | Barrel — re-exports the public surface |

## Auditor-acknowledged Zone of Pain (AF#16, info-level once documented)

The 2026-06-06 architecture audit (`/loop-architecture-review` Phase 5 dependency-cartographer) measured Robert Martin's coupling metrics on every workspace module. This subsystem landed at:

| Metric | Value | Interpretation |
|---|---|---|
| `Ca` (afferent coupling) | 12 | 12 distinct internal modules depend on this folder |
| `Ce` (efferent coupling) | 1 | This folder depends on 1 module |
| `I` (instability `Ce / (Ca+Ce)`) | 0.077 | Highly stable — appropriate for primitives |
| `A` (abstractness) | 0.000 | Fully concrete — zero interfaces / abstract classes |
| `D` (distance from main sequence `|A+I−1|`) | **0.923** | Far from main sequence — Martin's "Zone of Pain" |

Per `rules/cycle-rule-schema.md` heuristic legend, the 0.3 cutoff that triggers a "Zone of Pain" flag is folklore — Martin himself gave no numeric cutoff in *Clean Architecture*. The finding is **real** (high `Ca` × zero `A` does limit evolution capacity), but the "Pain" framing is a working heuristic, not a published rule.

## Why concrete + stable is the **intentional** choice (do NOT refactor)

Per ADRs D68, D69, D70, D71, D72, D73, security primitives — particularly `redactSecrets` — MUST be concrete, stable, and the single source of truth:

1. **D68 (canonical module):** there is exactly ONE `redactSecrets` function in the SDK. Replacing it with an interface + N implementations would re-fragment the credential pattern set and re-create the duplication problem D68 was introduced to fix.
2. **D69 (env snapshot at module init):** the redaction enable/disable flag is read ONCE at module load, defending against prompt-injection that tries to disable redaction mid-run. This invariant requires module-level state — it does NOT compose with an interface that supports per-instance configuration.
3. **D70 (ON by default + warn on opt-out):** the side-effect of warning on stderr at module load is an intentional security pressure on operators. Wrapping in an interface obscures the side-effect.
4. **D71 (two-bucket masking):** the masking format (`prefix...suffix` for long tokens, `***` for short) is part of the SECURITY CONTRACT, not an implementation detail. Operators rely on the visible mask shape to identify masked tokens in logs. Allowing N implementers via interface would let consumers ship inconsistent masking shapes.
5. **D73 (output-boundary semantics):** the contract is "redact when crossing the output boundary, never at storage". Promoting to interface would let consumers attempt to redact at storage — re-introducing the bug D73 was introduced to fix.

Splitting these concerns across a flexible abstraction would **regress 6 explicit ADRs** for a marginal coupling-metric improvement. The Zone of Pain measurement is acknowledged as a real metric, but the action it suggests (raise A) is rejected per the ADR record.

## What we DID change (T9.1 of `arch-review-fixes-2026-06-06`), and what was later removed

T9.1 added `secret-redactor.ts`, a types-only `SecretRedactor` interface that `redactSecrets` was
structurally compatible with. **It was removed on 2026-09-01, and the reason is the same one the
section above gives for rejecting the abstraction in the first place.**

It had zero implementers and zero consumers for its whole life. Nothing in `src/` referenced it, the
barrel never exported it, and the only mentions anywhere were its own docstring and this README. Its
stated purpose was to raise abstractness so the module would leave Martin's Zone of Pain — but an
interface nobody holds does not change what any module depends on, so the metric it was added to move
did not move either. What remained was a file to keep in sync with a function it did not constrain.

The paragraph above stands: the action the Zone of Pain measurement suggests (raise A) is rejected on
the ADR record, and adding an unused interface is not a way to satisfy a metric without paying the
design cost it is measuring. If a second redaction implementation ever appears — a no-op for a browser
build, a stricter one for regulated deployments — the interface comes back then, driven by the second
implementer rather than by the number.

## Auditor record

- Plan: `arch-review-fixes-2026-06-06` § Phase 9 / T9.1 (ADR D437)
- Audit DB row: `architectural_findings.id=16` @ `packages/sdk/src/internal/security/`
- Audit report: `architecture-output/final_report.md § Findings by dimension` AF#16

## Related ADRs

- D68 — Canonical `redactSecrets` module, single source of truth
- D69 — Env snapshot at module init (prompt-injection defense)
- D70 — Redaction ON by default; opt-out emits one-time stderr warning
- D71 — Two-bucket masking (short fully masked, long preserves prefix+suffix)
- D72 — `codeFile: true` opt-out for `.env.example` placeholders
- D73 — Redact at OUTPUT boundaries, never at storage
- D79 — `path-guard.ts` as canonical module for path defense
- D80 — `safePathJoin` resolves THEN prefix-checks (defeats normalized escape)
- D81 — `sanitizeIdentifier` strict grammar `^[a-z0-9][a-z0-9-_]*$`
- D82 — `createExclusive` via `O_EXCL` with default mode `0o600`
- D83 — `casUpdate` SQLite optimistic compare-and-swap helper
- D85 — CI lint gate uses grep regex (not AST) — same pattern as `no-unredacted-sink`
- **D437** — `SecretRedactor` interface (REMOVED 2026-09-01, zero implementers; see above) + Zone of Pain documentation, which stands
