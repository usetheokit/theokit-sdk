---
"@theokit/sdk": minor
---

The native config root can decline a surface, and a consumer can refuse a hook before it is spawned (#631)

Two additions, both absent-means-today's-behaviour.

## `{ kind: "theokit", import: [...] }` in `compatSources`

`projectConfigRoots` prepended `.theokit/` unconditionally. A **foreign** dialect could already declare which surfaces it contributes; the SDK's own root could declare nothing and contributed all four, always.

That asymmetry had a measured cost. `hookConfigCandidates` reads `settings.json` from every root, so a consumer keeping its own configuration in `.theokit/settings.json` had that file's `hooks` key executed by this package — with no gate, and twice when the consumer also ran them. Measured by `usetheoai-lab/TheoCode`: unapproved fired once, approved fired twice.

The consumer could not opt out: `settingSources` grants a dialect per SOURCE, not per surface, so dropping `claude-code` to avoid its hooks would also drop its skills, agents and rules — the reason an adopter can use this SDK without migrating anything.

```ts
local: { compatSources: [{ kind: "theokit", import: ["skills", "subagents"] }] }
//                        hooks omitted on purpose — this package will not read them from .theokit/
```

Declaring nothing keeps every surface, exactly as before. A bare `"theokit"` admits everything, matching the rule foreign kinds already follow. It rides on `compatSources`, which already reaches all four surfaces, so no new parameter is threaded anywhere.

**Deliberately not included: renaming the directory.** `theokitConfigRoot` is also the DATA root — `agent-registry-store.ts` builds `registry.json`'s path from it directly — so a `dirName` override would move persisted state. Different change, different blast radius, its own migration question.

## `local.hooks.approve`

```ts
local: { hooks: { approve: (req) => myFingerprintStore.has(req.command) } }
```

Consulted at the single point a hook is spawned, for every root — including a foreign dialect's, which the declaration above cannot reach. The request carries the command text, the event, and the file it was declared in, because a consumer's fingerprint is over the command and the source is what separates its own configuration from a dialect it merely imported.

Absent means run: a gate defaulting to refusal would disable every hook in the ecosystem on an upgrade.

**A refused hook resolves as if it were not configured — it does not deny the operation.** `preRun` and `preToolUse` decisions can block what they attach to, so treating "not approved" as a denial would make an unapproved hook worse than an absent one. The consumer asked for the command not to run, not for the work to stop.
