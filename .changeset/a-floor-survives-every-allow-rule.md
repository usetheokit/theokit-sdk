---
"@theokit/sdk": minor
---

Two tiers no permission rule and no mode can reach: protected paths and critical paths.

Measured: `protectedPath` returned 0 files here and 0 in the dist; `criticalPath` the same, against a
control of 31/72 on the word `hooks`.

**Protected paths** are the circuit breaker that stops an agent editing its own configuration, the
git hooks or the shell rc files — `.git`, `.claude`, `.theokit`, `.ssh`, `.gnupg`, `.envrc`,
`.npmrc`, `.mcp.json`, `.pre-commit-config.yaml`, `.netrc`. An `allow`-broad setup wrote all of them
freely and the operator had no way to express the exception, because the concept was absent.

**Critical paths** are destructive operations on `/`, the home directory, the working directory and
its parents. The nearest analogue was `catastrophicShellReason` in `@theokit/sdk-tools`, reached
through an opt-in `denyCatastrophicCommands()` — and **an opt-in guard is not a floor**. The whole
point of this tier is that nothing overrides it; a function a consumer may forget to call makes the
guarantee a convention.

**Why a floor and not a deny rule.** A deny rule is ordered, and order is defeasible: it can be
shadowed by a broader rule above it, reordered, or simply not shipped. The floor is consulted before
any verdict is honoured and no rule can reach it. Each test pairs the refusal with an explicit allow
rule for the same call, because the point is not that the operation is refused — it is that the rule
loses.

**Substitutions are refused, not expanded.** The spec names `$(...)` and `"$VAR"/*`, and in both the
dangerous argument is not in the text being matched. Expanding would mean running the substitution,
and a floor that executes its input to decide whether the input is safe has the problem backwards.

**Segment-aware, never prefix-matching.** `/workspace-other` starts with `/work` as a string and is a
different directory; `.gitignore` contains `.git` and is a file projects edit routinely. A floor that
could not tell them apart would refuse ordinary work while claiming to protect something else.

The refusal **names the path and says which tier refused**, so it is not mistaken for a permissions
misconfiguration — an operator who reads "denied" goes looking at their rules and finds nothing wrong
with them.

**Reads are not gated**, deliberately: the tier is about writes and destruction, and refusing reads
would stop an agent inspecting the repository it was pointed at.

Stated rather than implied: this is **not a shell parser**. It recognises the destructive shapes the
spec names, on the arguments it names, and a determined obfuscation gets past it — `rm` reached
through a variable holding the command name, for instance. A floor described as complete would be
trusted as complete.
