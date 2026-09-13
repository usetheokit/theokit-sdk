---
"@theokit/sdk": minor
---

A permission policy can be data an operator ships, reviews and diffs. It could only be a compiled-in function.

Measured: `allowedTools` and `disallowedTools` returned 0 files in the agents layer, and the closest
facility was `CommandPolicy = (command: string) => string | null` — a code predicate. The spec's rule
language had no counterpart: `Bash(` 0/0, `domain:` 1/0 and that one in prose.

The consequence is not a missing convenience. Every policy was a function, so it could not be
audited, diffed, reviewed in a pull request, or varied per environment — and `Read(./.env)`, the
spec's own paste-ready secret-exclusion example, could not be expressed at all.

**The grammar is decided as a whole**, one shape with a self-describing specifier:

| Written | Matches |
|---|---|
| `Bash` | every call to `Bash` |
| `Bash(npm run test:*)` | the argument starts with `npm run test:` |
| `Bash(npm audit)` | the argument equals `npm audit` — not a prefix |
| `Read(path:./.env)` | the argument, read as a path, matches the glob |
| `WebFetch(domain:example.com)` | the argument's HOST equals `example.com` |

The specifier says how to read itself. Per-tool magic — knowing that `Read` means a path — cannot
work where the consumer brings their own tools: a rule naming a tool this SDK has never heard of must
still be readable.

**A domain matches the HOST, never a substring.** `example.com.evil.test` is a different host, and a
substring match here would be an open redirect in policy form.

**A path glob is anchored at both ends.** Unanchored fails in both directions — a file outside the
protected tree matches because the pattern appears in its path, and a file inside escapes by having
anything appended. It is built from the literal with every other metacharacter escaped, so a policy
line cannot smuggle a regular expression into the matcher.

**Deny is emitted first**, then `ask`, then `allow`. The engine is first-match, so emission order *is*
precedence — and a narrow deny must survive a broad allow, or `Read` plus `Read(path:./.env)` would
read the secret the second line exists to protect.

**The engine is untouched.** A specifier becomes one rule per conventional argument name
(`command`, `file_path`, `path`, `url`, `query`) rather than a matcher that inspects the whole call:
`ArgMatcher` receives a single value, and `#argsMatch` fails a matcher whose argument is absent — an
invariant with its own history (#367, where a predicate invoked with `undefined` widened an allow
rule written to narrow). Widening that to add a grammar would trade a tested invariant for a parser.

**The limit is stated, not guessed around.** A tool whose argument is named something else cannot be
narrowed by specifier. "Read whichever argument is the only string" was the alternative and is worse:
a rule would match an argument the operator never named, widening an allow rule exactly as often as
it narrows a deny one. A bare tool name always works and matches every call.

A rule this grammar cannot read is **refused**, not dropped. A policy line an operator wrote and the
runtime silently ignored is the belief-in-an-absent-protection this tier exists to remove.

**B-038 is decided by this change rather than inherited by it.** The engine is first-match over an
array while the format groups by category, so a ported file listing `allow` above `deny` for the same
tool would silently invert and the narrower deny would never be reached. The decision is that the
LOADER reorders, not that the engine gains category evaluation: the array semantics are what every
existing consumer already built rules against, and changing how it walks them would move ground under
code nobody asked to change. A fixture writing `allow` first pins it.

**A rule written in the documented MCP spelling now matches.** The reference names an MCP tool
`mcp__server__tool` with a double underscore; this runtime names the same tool
`mcp_server_tool`, single, because the name is sanitised for the provider. Every permission rule an
operator copied from the documentation missed its target **silently** — the deny read as configured
and the tool ran.

Normalised in the RULE, never in the runtime name: the runtime spelling is what the model sees and
what the provider validates, and changing it would break every rule already written against it and
every consumer matching it, to fix a mismatch that costs one substitution at parse time. Scoped to
the `mcp__` prefix rather than rewriting every double underscore, because a tool outside MCP is
entitled to one in its own name.

