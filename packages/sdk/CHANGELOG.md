# Changelog

## 5.2.1

### Patch Changes

- [#594](https://github.com/usetheokit/theokit-sdk/pull/594) [`9dc8cf5`](https://github.com/usetheokit/theokit-sdk/commit/9dc8cf52bee690bfb9cf55bee63bcda71d3132b3) Thanks [@usetheodev](https://github.com/usetheodev)! - `effectiveToolNames` refuses a created tool instead of answering confidently about it ([#583](https://github.com/usetheokit/theokit-sdk/issues/583) follow-up)
  
  Every field on `AgentOptions` is optional, so the `CustomTool` that `SubAgent.create()` returns —
  `{ name, description, inputSchema, handler }` — satisfies the type **by vacuity, with no cast**.
  Measured: a `@ts-expect-error` on that call is reported unused (`TS2578`), so the compiler genuinely
  does not refuse it.
  
  What came back was worse than a wrong number:
  
  ```ts
  effectiveToolNames(SubAgent.create({ name: "analyst", … }))
  // { names: ["shell"], unresolved: [] }
  ```
  
  The empty `unresolved` claims **completeness** about an object the function never understood. A
  caller reads that as *"this subagent still announces a shell"* and either disbelieves a fix that
  worked, or "fixes" something on the strength of it. That is the defect [#583](https://github.com/usetheokit/theokit-sdk/issues/583) exists to eliminate, one
  function further on — and the same argument that made this return `{ names, unresolved }` rather than
  a bare array forbids it.
  
  It now throws a `ConfigurationError` naming what to pass instead. The detection is exact rather than
  heuristic: `AgentOptions` declares neither `handler` nor `inputSchema`, so an object carrying **both**
  is a tool and not options.
  
  **The workaround is still needed, and the 5.2.0 notes should not have implied otherwise.**
  `SubAgent.create()` closes its spec inside the handler, so the spec cannot be recovered from the
  returned tool — keep it in a variable, or extract it into a function a test can call, and pass that.
  
  Reported by the `theocode` session, against advice of mine that was wrong.

## 5.2.0

### Minor Changes

- [#585](https://github.com/usetheokit/theokit-sdk/pull/585) [`86bf6c1`](https://github.com/usetheokit/theokit-sdk/commit/86bf6c1ab90438835df5bb0d4a791596c58004ba) Thanks [@usetheodev](https://github.com/usetheodev)! - `effectiveToolNames` — ask what tools an agent will actually have ([#583](https://github.com/usetheokit/theokit-sdk/issues/583))
  
  `Agent.describe()` was the only reflection surface, and it builds its catalog as
  `(options.tools ?? [])` — literally the array the caller passed. The SDK's own builtins were never in
  it, so the two states that matter most were indistinguishable:
  
  ```
  Agent.create({ tools: [] })                    describe().tools = []   ← holds a shell
  the same + withheldBuiltinTools: ["shell"]     describe().tools = []   ← holds nothing
  ```
  
  A consumer confirming that a role declared read-only really is one had no instrument. What they did
  instead, measured in a real session: ask the agent to enumerate its own catalog — needs a credential,
  needs the network, and returns the list the *model* decided to write. That same session recorded a
  subagent answering *"I can't run shell commands in this environment"* while its catalog listed
  `shell`. An attempt measures the model's disposition; the catalog measures its authority.
  
  ```ts
  import { effectiveToolNames } from "@theokit/sdk";
  
  const { names, unresolved } = effectiveToolNames({ tools: [], withheldBuiltinTools: ["shell"] });
  // names: []          — the shell is genuinely gone
  // unresolved: []     — nothing else could contribute, so [] is the whole catalog
  ```
  
  **Options in, not an agent id** — synchronous, credential-free, answerable *before* the agent runs,
  so a test can compare what it declared against what the runtime will declare. `describe()` needs a
  registered agent and answers too late for that.
  
  **Not a bare array**, deliberately. MCP tools need a live connection; plugin tools and the reasoning
  `think` tool are assembled per run. Returning `string[]` would rebuild the original defect one
  function over. `unresolved` names the sources that are configured and could not be enumerated, and is
  empty when none are — which is the only condition under which `names` may be read as complete.
  
  Requested, with this exact shape and rationale, by the `theocode` session after it had to work around
  the gap by extracting a subagent spec into a separate function just to assert on it.

### Patch Changes

- Correct a version number in the 5.1.0 release notes
  
  The 5.1.0 entry *"Snapshot versions now sort ABOVE the release they are cut from"* illustrates the
  result as `5.0.2-compat-580-…`. **That digit was invented rather than derived.** The pending
  changesets included a `minor`, so the calculated base was `5.1.0`, and the first cut after the change
  printed:
  
  ```
  5.1.0-compat-581-20260905211819
  ```
  
  A correction was written before the release and did not reach it: it lived in a pull request that had
  not merged when `changeset version` consumed the changeset, so the uncorrected text shipped.
  
  Recorded as a new entry rather than by editing the published one, per this project's changelog
  discipline — a released entry is a record of what was said at the time, and rewriting it hides that
  the correction happened.
  
  **Why a wrong digit was worth two entries:** the property that mattered — sorting above `5.0.0` —
  held with either number. An invented value that does not change the conclusion is the kind that stays
  uncorrected forever, and a reader comparing the changelog against what they installed would have
  found an unexplained discrepancy and rightly concluded one of the two was lying.

- [#585](https://github.com/usetheokit/theokit-sdk/pull/585) [`86bf6c1`](https://github.com/usetheokit/theokit-sdk/commit/86bf6c1ab90438835df5bb0d4a791596c58004ba) Thanks [@usetheodev](https://github.com/usetheodev)! - `CompatSurface` is declared once ([#586](https://github.com/usetheokit/theokit-sdk/issues/586))
  
  It was declared twice, independently — `types/agent.ts` (public, typing
  `AgentOptions.local.compatSources`) and `internal/runtime/compat/foreign-config-sources.ts` (typing
  the admission logic and `persistence/paths.ts`). Neither imported the other.
  
  Measured: adding a member to one alone produced **zero** type errors. Structurally identical unions
  compare equal, so the two halves of one public contract could stop agreeing about which surfaces
  exist, silently. Widen the public type and a caller declares a surface the admission logic ignores;
  widen the internal one and the loader admits a surface no public caller can name. Both produce a
  declaration that reads as honoured and is not.
  
  `types/` is a leaf by design, so the public declaration stays and the internal module imports it.
  
  The runtime list `COMPAT_SURFACES` cannot be derived from a type, so it remains a second copy of the
  members — and a compile-time exhaustiveness check now pairs the two, in both directions.
  
  **The first version of that check was decorative and this is worth recording:** annotating the list
  `readonly CompatSurface[]` widens each entry back to `CompatSurface`, so the check compared a type
  against itself and passed on any drift. It was caught by testing the guard rather than trusting it —
  a member added to the public type produced zero errors. `as const satisfies` keeps the literals.

## 5.1.0

### Minor Changes

- [#579](https://github.com/usetheokit/theokit-sdk/pull/579) [`f08b330`](https://github.com/usetheokit/theokit-sdk/commit/f08b330fd6ca03049dd5fded5d76250263972691) Thanks [@usetheodev](https://github.com/usetheodev)! - `discoverSubagents` can read a declared foreign dialect, closing an asymmetry against the agent's own registry
  
  `[#524](https://github.com/usetheokit/theokit-sdk/issues/524)` made foreign configuration opt-in and reached the agent's subagent registry — which resolves
  through `settingSources` + `compatSources` — but not `discoverSubagents`, the public selector over
  the same material. The reader underneath already accepted `compatSources`; this entry point simply
  never passed it.
  
  Measured by the `theocode` session on `5.0.1`, both arms in fresh trusted directories with the same
  task:
  
  ```
  roles in .theokit/agents/            delegate_to_team works
  the SAME files in .claude/agents/    "the `explorer` role is not configured"
  ```
  
  So a repository adopting the product could **delegate to** a `.claude/agents/` subagent by name and
  could **not define its team's roles** there. One dialect, two answers, depending on which selector
  asked.
  
  ```ts
  await discoverSubagents(cwd, { compatSources: ["claude-code"] });
  ```
  
  `compatSources` is a **separate option from `settingSources`**, deliberately. That one answers
  *which sources* (project, and one day user or team); this one answers *which dialects* within them.
  Folding `"claude-code"` into `SubagentSource` would conflate two orthogonal axes, and the internal
  loader has kept them apart since `[#524](https://github.com/usetheokit/theokit-sdk/issues/524)` for exactly that reason.
  
  **The opt-in still holds**: with nothing declared, `.claude/agents/` is not read. That is covered by
  a test whose only job is to fail if the option ever became a no-op.
  
  `CompatSourceDeclaration` is re-exported from `@theokit/sdk/subagents-loader` for the same reason
  `AgentDefinition` is — an option whose type is unreachable is an option only `any` can call.

- [#579](https://github.com/usetheokit/theokit-sdk/pull/579) [`8a59217`](https://github.com/usetheokit/theokit-sdk/commit/8a592174f76ea85f8d75d7446ebd1ea5e3094d50) Thanks [@usetheodev](https://github.com/usetheodev)! - `@theokit/sdk/persistence` exposes `sessionUuidFor` and `legacyTranscriptPath` ([#577](https://github.com/usetheokit/theokit-sdk/issues/577))
  
  Every transcript helper on this entry point went **id → path**. Nothing went the other way, and
  nothing let a caller compute the forward mapping to match against — so a consumer enumerating
  `projects/<encoded-cwd>/*.jsonl`, which is how you list sessions without a registry, received
  filenames it could not relate to any agent id it held.
  
  The naming scheme is deliberately one-way: a UUIDv8 over SHA-256, so the Claude Code CLI can
  `--continue` a session this SDK wrote. The 5.0.0 notes say *"nothing has to be persisted to map one
  back to the other"* — true of the scheme, and not true in practice, because `sessionUuidFor` lived
  in the compiled JS and in zero `.d.ts`. The only route left was to reimplement the hash: an SDK
  internal, copied into a consumer, silently wrong the day the scheme moves.
  
  ```ts
  import { sessionUuidFor, transcriptRoot } from "@theokit/sdk/persistence";
  
  const wanted = `${sessionUuidFor(agentId)}.jsonl`;
  const mine = (await readdir(dir)).filter((f) => f === wanted);
  ```
  
  **What crosses is the forward mapping, not an inverse.** A path → id function cannot exist over a
  hash, and shipping one would be a lie about it. `legacyTranscriptPath` crosses alongside because a
  directory written before [#400](https://github.com/usetheokit/theokit-sdk/issues/400) holds both spellings, and a consumer matching only the new one
  reports its own history as missing — the same false absence, one rename later.
  
  Measured on `@theokit/agents` 4.x against `5.0.1`: 29 unit tests failing from this single cause,
  seen from four angles — listing, protection, GC and deletion.

- [#579](https://github.com/usetheokit/theokit-sdk/pull/579) [`b182d84`](https://github.com/usetheokit/theokit-sdk/commit/b182d847725038ed173423d64106024d149e5984) Thanks [@usetheodev](https://github.com/usetheodev)! - `loadSkillInstructions` — turn a discovered skill into an inline one without a second parser
  
  `SkillsSettings.inline` requires `instructions`, and `discoverSkills` returns only the frontmatter
  fields plus `source`. So a consumer wanting to feed discovered skills back in had one route: open
  `source` and split the frontmatter by hand.
  
  That is a second implementation of this module's own convention — the thing
  `@theokit/sdk/subagents-loader` was published to end — and it fails **silently** if the format ever
  moves: the frontmatter lands inside the instructions and nothing says so.
  
  ```ts
  import { discoverSkills, loadSkillInstructions } from "@theokit/sdk/skills";
  
  const skills = await discoverSkills(dir);
  const inline = await Promise.all(
    skills.map(async (s) => ({ ...s, instructions: await loadSkillInstructions(s) })),
  );
  ```
  
  **`Skill` is unchanged**, deliberately. Its docblock says *"the skill BODY is never included"* — a
  written contract whose reason is not written down, and the likely one (a catalog you can put in a
  prompt without carrying every body) is worth keeping intact. The body was never expensive to
  obtain: discovery already reads each file in full and discards all but the frontmatter. What was
  missing was a door that hands it over, which is what this is — the same relationship
  `loadSubagentDefinition` has to `discoverSubagents`.
  
  It **throws** on an unreadable `source`, unlike discovery, which skips what it cannot read. A caller
  naming one skill has asked about that skill, and an empty string would answer a question it did not
  ask.
  
  Reported by the `theocode` session, which needed an operator's `~/.theokit/skills/` to reach an
  agent through this SDK's parser rather than a copy of it.

### Patch Changes

- [#579](https://github.com/usetheokit/theokit-sdk/pull/579) [`0894dda`](https://github.com/usetheokit/theokit-sdk/commit/0894ddad430b1ac5b1e2ba222a9527c1143d9722) Thanks [@usetheodev](https://github.com/usetheodev)! - `local.compatSources` survives delegation and resume ([#578](https://github.com/usetheokit/theokit-sdk/issues/578))
  
  `[#524](https://github.com/usetheokit/theokit-sdk/issues/524)` added `compatSources` to `AgentOptions["local"]`, so a project can declare that `.claude/`
  hooks, skills, subagents and plugins may be read. Two places carry a parent's `local` config across
  a hop, and **neither was updated**:
  
  | Carrier | Was missing |
  |---|---|
  | `buildChildCreateOptions` — parent → delegated child | `settingSources`, `compatSources` |
  | `serializeLocal` — agent → registry → resumed agent | `compatSources` |
  
  So a parent declaring `compatSources: ["claude-code"]` read `.claude/agents/` and its delegated
  child did not: a team could delegate TO a role by name while the child could not resolve the rest of
  the team. And an agent resumed from the registry silently stopped reading the surfaces it was
  created to read.
  
  Both the field and the code that carries it landed on the same day, which is what an omission looks
  like rather than a decision — and `serializeLocal` documents the one inclusion that *was* decided,
  right beside the gap.
  
  **Inheriting is safe here, and it is the opposite direction from every other inherited field.** The
  others hand down a restriction (the sandbox posture, the permission plugins) and the hazard is a
  child escaping it. Here the child is *more* restricted than its parent, so the failure is a missing
  capability rather than an open door. Inheritance cannot widen: the child gets what the parent
  already resolved and runs in the parent's cwd, so it reaches no directory the parent could not. A
  role's explicit value still wins.
  
  **The one hazard in the fix, since it is the kind that trades a bug for a worse bug:**
  `buildChildCreateOptions` used to write `local` whole from the sandbox posture alone, so adding a
  second `local` spread beside it would have silently dropped that posture — turning a
  missing-capability defect into a default-open one. `local` is now accumulated once from all three
  contributors, and a test asserts the sandbox posture survives inheritance.
  
  Reported by the `theocode` session. Its measurement also narrowed who is affected: a consumer that
  rebuilds agent options per invocation never reaches `serializeLocal` and is exposed only to the
  delegation half.

- [#582](https://github.com/usetheokit/theokit-sdk/pull/582) [`95a2e9d`](https://github.com/usetheokit/theokit-sdk/commit/95a2e9de364df5a161671fa0c845e0b6a8208392) Thanks [@usetheodev](https://github.com/usetheodev)! - The built-in judges no longer hold a `shell` they never asked for ([#581](https://github.com/usetheokit/theokit-sdk/issues/581))
  
  `internal/scorers/llm-judge.ts` and `internal/judge/judge-call.ts` each create a short-lived agent to
  score or adjudicate. Neither wants a tool. One passed no `tools` at all; the other passed `tools: []`.
  
  Neither is enough: **a `shell` tool is always registered on a local agent, including when `tools: []`
  is passed.** Withholding is the only mechanism that removes it, and neither judge used it.
  
  The scorer was the worse of the two, because it also carried `sandboxOptions: { enabled: false }` —
  which reads like a restriction and is the opposite of one. It does not restrict the shell; it removes
  the sandbox around it. So the scorer held an **unsandboxed** shell in `process.cwd()` while reading
  content produced by the very thing it was evaluating. `types/agent.ts` § LocalOptions records the
  case that already happened to somebody: the working directory held the benchmark's answer key, and
  two transcripts show the model citing it.
  
  Both now pass `withheldBuiltinTools: ["shell"]`. The scorer's `sandboxOptions` line is left as it
  was: with no shell there is nothing for it to govern, and changing it would be a second, unrelated
  decision.
  
  Neither line had a recorded reason — `git log -S` puts both inside large feature commits whose
  messages never mention the sandbox, the shell, or a tool surface. If either was deliberate, this
  commit and [#581](https://github.com/usetheokit/theokit-sdk/issues/581) are the trail back.

- [#584](https://github.com/usetheokit/theokit-sdk/pull/584) [`69e8dda`](https://github.com/usetheokit/theokit-sdk/commit/69e8dda6be4489f462a031166bdc1f6f06cbe7ac) Thanks [@usetheodev](https://github.com/usetheodev)! - Snapshot versions now sort ABOVE the release they are cut from
  
  `changeset version --snapshot` defaults to a `0.0.0-` base, so every snapshot this repository has
  ever published was `0.0.0-<tag>-<timestamp>` — which **sorts below every real release**, because
  semver compares `major.minor.patch` numerically before it looks at a prerelease suffix.
  
  Any consumer with a version floor therefore read a snapshot as older than the release it was cut
  from. Measured by the `theokit/agents` layer against `0.0.0-compat-580-20260905204608`, on every
  run:
  
  ```
  `compatSources` was declared, but @theokit/sdk@0.0.0-compat-580-… does not know that option and
  will ignore it — the foreign configuration root will NOT be read. It landed in 5.0.0.
  ```
  
  The code in that snapshot knew the option perfectly well. **The version number said it did not, so
  the feature was switched off** — silently for anyone not reading stderr, and precisely the feature
  the snapshot existed to deliver.
  
  `snapshot.useCalculatedVersion: true` bases the snapshot on the version the pending changesets
  would produce, so the same cut becomes `5.0.2-compat-580-…`: still a prerelease, still off `latest`,
  still never resolved by a caret range — and now correctly ordered against the floor.
  
  Reported by the `theocode` session, which caught it in the only way it was catchable: its first run
  piped the output through `tail -3`, which cut the warning off, and the second kept the whole thing.

- [#576](https://github.com/usetheokit/theokit-sdk/pull/576) [`945e999`](https://github.com/usetheokit/theokit-sdk/commit/945e99906180bdd83d9d40845988907e22a08ec4) Thanks [@usetheodev](https://github.com/usetheodev)! - The undeclared-`.claude/` warning now names the file you can edit, not only the option your host passes
  
  `5.0.1` made this warning reach stderr regardless of any diagnostics sink ([#563](https://github.com/usetheokit/theokit-sdk/issues/563)), which was the
  right fix and created a smaller problem underneath it: the message told you to pass
  `local: { compatSources: ["claude-code"] }`, and `local` is an argument **the code embedding this
  SDK** passes. If you are using a tool built on the SDK rather than calling it yourself, that option
  does not exist on your surface — so the line was true about the mechanism and unusable as an action.
  
  Reported by the `theocode` session running `5.0.1` as an embedding host, and their framing is the
  one worth keeping: *"correct about the mechanism and misleading about the action — it sends the
  person looking for an option that is not on their surface."*
  
  [#524](https://github.com/usetheokit/theokit-sdk/issues/524) gives the declaration **two entry points for one shape**, and the warning named only one:
  
  | entry point | who can use it |
  |---|---|
  | `.theokit/config.json` → `{"compat":{"adapters":["claude-code"]}}` | anyone holding the workspace |
  | `local: { compatSources: ["claude-code"] }` | whoever embeds the SDK in code |
  
  The message now names the file first, because that is the entry point its reader can reach, and
  keeps the code option for the embedder for whom it is the right answer. Nothing about the
  behaviour changes — only what the line tells you to do.
  
  ## Still open, and worth knowing
  
  There is no way to say *"I know, and I want none"*. `compatSources: []` would be the natural
  spelling, but `resolveCompatSources` collapses it into the same `[]` an absent option produces, so
  the two cannot be told apart. `theocode` measured one warning per process, and a CLI invocation is
  a process — so a shell loop prints one line per iteration. They explicitly did not ask for a change
  on the volume; if it starts to matter, threading that distinction through is the shape of the fix.

- [#582](https://github.com/usetheokit/theokit-sdk/pull/582) [`1b088c4`](https://github.com/usetheokit/theokit-sdk/commit/1b088c4be2b895b7c442b00055fc34a6c9bf4eb4) Thanks [@usetheodev](https://github.com/usetheodev)! - A delegated child can no longer recover a builtin tool its parent withheld ([#580](https://github.com/usetheokit/theokit-sdk/issues/580))
  
  **This is a security fix.** Measured before the change:
  
  ```
  parent: withheldBuiltinTools: ["shell"]
  child:  undefined
  ```
  
  `withheldBuiltinTools` crossed no carrier at all — not `InheritedCredentials`, not
  `buildChildCreateOptions` — so delegation **widened** authority the operator had revoked. That is the
  inverse of [#578](https://github.com/usetheokit/theokit-sdk/issues/578) and materially worse: there the child was merely over-restricted.
  
  It bites because of a documented default: a `shell` tool is always registered on a local agent,
  *including when you pass `tools: []`*. Withholding is the only mechanism that removes it, so a
  withholding that does not survive delegation leaves a child no way to be without a shell. Nor is
  `sandboxOptions` a substitute — `{ enabled: false }` does not restrict the shell, it removes the
  sandbox around it.
  
  Two changes:
  
  - The parent's withheld set is carried to the child.
  - `SubAgentSpec` accepts `withheldBuiltinTools`, so a role declared read-only can actually be one.
  
  **The child's list is the UNION of its own and the parent's, never a replacement.** Every other field
  on the spec lets the role's value win — `model`, and `sandbox` (an explicit `sandbox: false` really
  does turn confinement off for a child of a confined parent, which is documented and intended). That
  asymmetry is deliberate: a posture is declared, whereas withholding removes a capability from the
  catalog, and the failure is silent. So `withheldBuiltinTools: []` on a role subtracts nothing — a
  restriction may be tightened by a child and never loosened.
  
  Verified with a negative control: 6 of the 7 new tests fail against the pre-fix sources, and the one
  that passes is the control asserting unchanged behaviour.
  
  **There is no known limit on reaching this field from a wrapping layer.** An earlier draft of this
  entry claimed one — that a layer re-exporting `Agent` under a narrowed type could not pass it — and
  that was wrong. Checked against the published declaration: such a narrowing is written as
  `Omit<typeof Agent, 'list'> & { list(…) }`, which narrows only `list`, so `create` keeps this
  package's signature and the field crosses with types and without a cast. The claim came from
  searching a wrapper's `.d.ts` for the field NAME, which is absent there because the type composes by
  reference rather than redeclaring it — the wrong artefact for the question.
  
  It is corrected here rather than deleted because a false limit recorded upstream is worse than none:
  a reader takes it as settled and stops trying.
  
  Found by the `theocode` session, which discovered its own "read-only" role holding a `shell` by
  enumerating the tool catalog — after two probes that asked the model instead, and got answers that
  contradicted it.

## 5.0.1

### Patch Changes

- [#564](https://github.com/usetheokit/theokit-sdk/pull/564) [`bed898c`](https://github.com/usetheokit/theokit-sdk/commit/bed898c21a51087c90745a2df762eeabc5f06bee) Thanks [@usetheodev](https://github.com/usetheodev)! - The undeclared-`.claude/` warning now reaches the consumer
  
  `5.0.0` made a project's `.claude/` opt-in, and its release note said the workspace "says so once,
  on the diagnostics channel". It did not say so to anyone.
  
  The warning went through `diag()`, which returns without doing anything when no diagnostics sink is
  installed. The SDK installs none, and neither of the two observable hosts does either. So a
  consumer upgrading `4.63.4` → `5.0.0` with a `.claude/` and no `compatSources` lost hooks, skills,
  subagents and plugins **in silence** — along with the one line that reverses it:
  
  ```ts
  local: { compatSources: ["claude-code"] }
  ```
  
  It now goes through `diagFailure()`, which prefers an installed sink and falls back to stderr when
  there is none. A host that intercepts diagnostics keeps owning its render surface; a host that does
  not, still hears this one.
  
  The cost is real and is now paid: a repository that wants `.claude/` ignored sees a line. It is
  emitted once per directory per process, not per turn — and before `5.0.0` that repository was
  having the directory imported anyway, so the line confirms the fix it wanted. There is no opt-out
  yet; if the noise matters, say so. ([#563](https://github.com/usetheokit/theokit-sdk/issues/563))

## 5.0.0

### Major Changes

- 667bd3d: **BREAKING:** a project's `.claude/` directory is no longer read unless the consumer declares it.
  Pass `local: { compatSources: ["claude-code"] }` to restore today's behaviour.
  
  Four subsystems — hooks, skills, subagents and plugin bundles — resolved `<cwd>/.claude` alongside
  `<cwd>/.theokit` with no opt-in anywhere. A directory containing only `.claude/`, and no
  configuration of this SDK at all, had its hooks executed, its subagents registered, and its skill
  text folded into the system prompt.
  
  **Trust is not consent.** A consumer's trust gate answers "do I trust the code in this directory?",
  and it was doing double duty as the answer to a different question: "do I want another product's
  configuration imported into this one?" Those come apart in the ordinary case — `.claude/` is
  populated in exactly the repository one trusts most, for a different tool, under a different
  contract, often by a teammate who never heard of this SDK. The measured cost of conflating them was
  the defect fixed one commit earlier: every turn denied by a `PreToolUse` hook nobody had declared.
  
  The skills path is the quieter half. A skill's text enters the system prompt, so importing prompt
  content from a directory this SDK does not own is a prompt-injection surface that no consumer opted
  into and none could see.
  
  A workspace holding an undeclared `.claude/` now says so once, on the diagnostics channel, naming
  the directory and the line that turns it back on. It goes there rather than to stderr because
  ignoring an undeclared directory is the intended behaviour, not a failure — every repository that
  has Claude Code set up and does *not* want it imported would otherwise pay a line on a TUI host's
  render surface for behaving as instructed.
  
  An unrecognised name in `compatSources` is dropped rather than turned into `<cwd>/<name>`: a typo
  must fail closed, since a directory name was never enough to describe a dialect.

### Minor Changes

- 88e87d0: A foreign configuration source can now be admitted to some surfaces and not others.
  
  `compatSources: ["claude-code"]` was all-or-nothing: declaring it admitted `.claude/` to hooks,
  plugins, skills AND subagents at once. The four carry very different risk — a skill is text that
  enters the system prompt, a plugin is code loading, a hook is command execution — so a consumer who
  wanted to reuse the skills they had already written was handed arbitrary command execution along
  with them, and had no way to say otherwise.
  
  ```ts
  local: {
    compatSources: [{ kind: "claude-code", import: ["skills", "subagents"] }],
  }
  ```
  
  Hooks and plugins then resolve `.theokit/` alone. `CompatSurface` and `CompatSourceAdapter` are
  exported.
  
  Three rules, each failing closed:
  
  - **The bare `"claude-code"` string still admits every surface.** It is what `5.0.0-next.1`
    published, and narrowing it silently would turn a working opt-in into a no-op that says nothing —
    the defect this option exists to fix, one level up.
  - **An adapter with no `import` list admits nothing.** Safe to apply strictly because the object
    form is new and nobody can be relying on it yet.
  - **An unrecognised surface name is dropped**, exactly as an unrecognised `kind` already is. A typo
    must narrow access, never widen it.
  
  The `plugins` surface governs reading a foreign plugin directory even when the caller wants the
  SKILLS a bundle carries: a bundle is code, and its skills arrive attached to it, so admitting
  `skills` alone must not reach inside one. Otherwise the narrower permission would silently grant
  the wider one.
  
  Closes the per-surface half of usetheokit/theokit-sdk#524. The visibility half — skills, subagents
  and plugins carrying the root they came from, the way hooks already carry `sourcePath` — and the
  declarative `.theokit/config.toml` form are not in this change.
- 33aa170: A project can now declare its foreign compat sources in `.theokit/config.json`, instead of only in
  code.
  
  ```json
  {
    "compat": {
      "adapters": [{ "kind": "claude-code", "import": ["skills", "subagents"] }]
    }
  }
  ```
  
  The DECLARATIVE half usetheokit/theokit-sdk#524 asked for, in a `## Sketch` written against TOML.
  It ships as JSON: this SDK already reads JSON everywhere a project declares something
  (`settings.json`, `mcp.json`, `context.json`) and carries no TOML parser or dependency for one —
  adding one for a single optional section would be the opposite of what #522/#524 are about, reading
  in a new format nobody asked this SDK to speak. The shape is unchanged: `compat.adapters` accepts
  exactly what `local.compatSources` already does in code — a bare kind string, or `{ kind, import }`.
  
  **Precedence, decided here because the issue does not state it:** explicit `local.compatSources` in
  code wins over the file. The file is the default for a caller who declared nothing. A test or a
  one-off script can therefore always override the file without editing or deleting it.
  
  Read with `readFileSync`, not this package's usual async reader: the caller is `Agent`'s
  synchronous constructor, which resolves `compatSources` before any submanager exists to await a
  promise. `existsSync` already runs in the same constructor for the same reason.
  
  One resolver, `resolveCompatSources(options, cwd)`, replaces five call sites that each wrote
  `options.local?.compatSources ?? []` by hand — the same duplication `theokitConfigRoot` closed one
  layer down, closed here one layer up, so the file form reaches all four surfaces (hooks, skills,
  plugins, subagents) through the one place rather than needing five separate edits that could drift.
  
  Closes the declarative half of #524. `#524` itself stays open until it is verified in an installed
  release, per this project's issue-lifecycle convention.
- 85b5c2f: A host can read the messages a session already contains
  
  `readSessionMessages` was compiled into the package and missing from the type surface, so a
  surface that repointed a session could not re-render it: the messages were on disk, the SDK
  read them to give the model its context, and the screen stayed empty while the model
  demonstrably remembered.
  
  ```ts
  import { readSessionMessages } from "@theokit/sdk";
  
  const history = await readSessionMessages({ sessionId, cwd: projectDir });
  for (const m of history) render(m.role, m.text);
  ```
  
  `cwd` defaults to `process.cwd()`, and `sessionDir` is only needed when the agent was created
  with `local.sessionDir`. A session that was never written resolves to `[]` — a fresh session
  has no history, which is not an error.
  
  The internal reader takes a `SessionStore`; this one does not, so the transcript layout and
  the record shape stay private. A host that already has a custom store can read from it
  directly. (#546)
- edfa59c: `Agent` can now be asked which operations it supports, instead of being told by an exception.
  
  `SDKAgent` is one handle over two runtimes that do not offer the same operations, and the type did
  not model the difference. `downloadArtifact` is a **required** member that rejects for every input on
  a local agent; `listArtifacts` is required and returns `[]` for every state, so "no artifacts" and
  "this runtime has no artifacts" were the same value. On a cloud agent, five members declared
  _optional_ are present-but-throwing — so `typeof agent.fork === "function"` is `true` and calling it
  throws. Neither requiredness nor optionality expresses "exists here, not there", which left a caller
  no way to branch except a `try`/`catch` around a call it did not want to make.
  
  Two additive members answer the question first, mirroring `Run.supports(op)` /
  `Run.unsupportedReason(op)`, which already solved this one layer down:
  
  ```ts
  if (agent.supports("downloadArtifact")) {
    await agent.downloadArtifact(id);
  } else {
    logger.info(agent.unsupportedReason("downloadArtifact"));
  }
  ```
  
  The new `AgentOperation` union is exported. Nothing was removed and no signature changed, so a
  caller that never asks behaves exactly as before.
  
  This is a mitigation. The structural fix is to split `SDKAgent` into a common core plus
  `LocalCapableAgent` / `CloudCapableAgent`, so the compiler refuses the call rather than the runtime.
  That is breaking on a published 4.x surface and is deliberately not done here.
- e7cf2dd: A skill, subagent or plugin now says which directory it was read from.
  
  usetheokit/theokit-sdk#524 asks for it in one line — *"whatever is imported should be reportable […]
  silent inheritance is what made this take a debugging session to notice"* — and a consumer listing
  its own skills could not tell that one had arrived from `.claude/skills/` rather than the project's
  own directory.
  
  What is new is not the data. It existed on all three and did not reach the caller:
  
  - `Skill.source` was already the absolute path to the `SKILL.md`, and the projection that builds
    `agent.skills` mapped it away along with the body. The projection is right to drop the BODY —
    that is what `get()` is for — and dropping the PATH with it answered a question nobody asked.
  - `agent.plugins.list()` has always returned `source` at runtime; the internal type's own docblock
    says it carries provenance "so callers can audit where the plugin came from". `SDKPluginMetadata`
    simply never declared it, so the caller received the field and the compiler denied it existed.
  - `readSubagentsFrom` computes the file path on the line it reads the file, then dropped it.
    `AgentDefinition.source` keeps it.
  
  `source` is optional on all three, and absence means something specific: declared in code, not read
  from disk. A subagent passed through `AgentOptions.subagents` has no file and `source` is absent.
  An inline `createSkill` skill has no file either, but already carried the synthetic `inline://<name>`
  marker before this change (`create-skill.ts`) — so a skill's `source` is now populated for every
  entry `list()` returns, either a disk path or that marker, and a first version of this fix wrongly
  described it as absent for that case. An existing regression test (`agent-skills-get.test.ts`,
  SE21) asserted `list()` must NOT carry `source` at all; it predates #524 and is updated here to
  assert the marker instead, while still proving the skill's body and references never leak.
  
  `SkillsHandle.list` is now typed as the public `SystemPromptSkillRef` instead of restating
  `{ name; description }` inline. The two had drifted, and an internal handle declaring a narrower
  shape than the contract it serves silently deletes fields the projection produces — which is exactly
  how `source` reached the caller at runtime while not existing to the compiler.
  
  Closes the visibility half of #524. The declarative `.theokit/config.toml` form is not in this
  change.
- 912e3b9: Three silent downgrades now tell you they happened. Behaviour is unchanged; visibility is not.
  
  **A failing `MemoryProvider` no longer disappears quietly.** `initLoopContext` caught every provider
  failure into an empty value: an `init` failure meant no memory tool was registered, a `buildTools`
  failure meant no provider tools, an `activePass` failure meant no recalled context in the system
  prompt. The agent answered without the memory it was configured with, and nothing recorded it. There
  is now a `memory_degraded` run event — new `RunMemoryDegradedEvent`, carrying the stage and the
  provider's own message — alongside a stderr diagnostic, so a host can show "memory degraded" instead
  of a healthy run. Degrading to a working agent is still what happens.
  
  **The memory FTS fallback is gated on the case it was written for.** Any SQL failure used to become a
  `LIKE '%query%'` scan over the whole table, returning plausible hits at a fixed score — so a corrupt
  database, a missing FTS table and a disk error all looked like a successful search with worse
  relevance. The fallback still runs, and a non-CJK failure now reports that the index may be missing
  or corrupt.
  
  **A `@theokit/sdk-memory` peer that fails to load says so.** Absent is expected and stays silent;
  present-but-unloadable — a module-format interop failure, a broken native dependency, a bundler
  rewrite — is reported instead of falling back to the legacy path in silence.
- 16a996f: Every error this SDK throws is now catchable as `TheokitAgentError`.
  
  The README tells you to catch `TheokitAgentError`, and twenty-four exported error classes were not
  one — they extended bare `Error`, so that catch silently missed them and none of them told you
  whether the failure was worth retrying. Among them: `GenerateObjectError`, `StreamObjectError`,
  `FileNotFoundError` and its four siblings, `SandboxSecurityError`, `SandboxNotAvailableError`, the
  three `Auth*Error`s, `A2ARequestTimeoutError`, `MaxDelegationDepthError`, `WorkflowToolError`, and the
  two errors on the `./interactive` subpath.
  
  All twenty-four now extend `TheokitAgentError`, carry a `code`, and answer `isRetryable`. The answer
  was decided per class rather than defaulted, and the reasoning is in the source. Two are retryable —
  `A2ARequestTimeoutError` (a peer that missed one deadline may answer the next) and
  `CompressionFailedError` (a single LLM call that failed or came back empty) — plus `FilesystemError`,
  where the underlying I/O failure genuinely can be transient. The rest are not, and say why.
  
  This is additive: `instanceof Error` still holds, every `code` value is unchanged, and no signature
  moved. Code that already caught these by their specific class keeps working.
  
  `generateObject` and `streamObject` also stop declaring the same failure contract twice with
  byte-identical messages. They share one internal base class and keep their two distinct public names,
  so `streamObjectError instanceof GenerateObjectError` remains false.
- 374dd5f: The `MemoryProvider` port is now the only memory path. `THEOKIT_PORT_MEMORY_PATH`
  is gone, and the adapter over the built-in memory runs by default; a
  consumer-supplied `memoryProvider` still takes precedence.
  
  No typed API was removed — the flag was internal and never appeared in your
  TypeScript types — but three behaviours change:
  
  - **Recalled memory is now escaped before it reaches the model.** The port path
    concatenated the recall summary into the system prompt raw, while the assembly
    pipeline has always wrapped it as `<active-memory>` with XML escaping. A recalled
    fact containing `</active-memory>` could close the block early and have everything
    after it read as a system instruction. Both paths now wrap and escape.
  - **Memory tools receive the run's abort signal and transcript projection.** They
    arrive through the same channel as your own tools, so a long memory search is now
    cancellable with the run.
  - **`.theokit/memory` is no longer created by a send that never reaches the agent
    loop** — a fixture-mode send with a `theo_test_*` key used to leave an empty
    SQLite index behind. Real runs are unchanged: the index is created and searchable
    exactly as before.
- 374dd5f: `MemoryProvider.buildTools(handle, agent)` now declares its second parameter as
  `MemoryProviderAgentRef` — `{ agentId, model }` — which is all the SDK has ever
  passed it.
  
  It declared `SDKAgent`, a 33-member interface, and satisfied that with a cast over
  a two-field object. Any implementation reaching for one of the other 31 members —
  `send()`, `fork()`, `dispose()` — got `undefined is not a function` at runtime, with
  no compile-time warning, because the cast removed exactly that check.
  
  Non-breaking in both directions: an `SDKAgent` still satisfies the new type, and an
  existing implementation typed `agent: SDKAgent` still compiles. `MemoryProviderAgentRef`
  is exported from the package root so you can name it.
- 618cd02: `ctx.on(...)` now returns a disposer, so a plugin can detach one hook.
  
  It returned `void`, which made the plugin Observer a one-way door: a handler attached through
  `initialize()` had no removal path and ran for the life of the process. The only documented dynamic
  case — a permission plugin re-installed on every prompt — worked because the registry keys plugins by
  name, so re-registering the whole plugin was the only way to remove one hook.
  
  ```ts
  const off = ctx.on("pre_tool_call", handler);
  // ...later
  off();
  ```
  
  The disposer detaches the registration it was given — attaching the same function twice and disposing
  once leaves one — and is idempotent. A handler the SDK refused (a non-function, which is warned and
  ignored) still returns a working no-op disposer, so a caller never has to branch on whether the
  registration took.
  
  Two observers in the SDK already worked this way (`Run.onDidChangeStatus`, `MessageBus.unregister`);
  this closes the gap. The new `PluginHookDisposer` type is exported.
- 31fea8f: `Retry.run(fn, options)` is the new name for `Retry.create(fn, options)`.
  
  `create` never created anything — it runs `fn` with retry and resolves to `fn`'s
  result — and the name said otherwise. It is deprecated, still honoured, and
  removed in the next major.
- 691d8e6: `SandboxBackend`'s derived `glob`, `grep` and `listDir` now throw when the command could not run.
  
  They returned `[]` on any non-zero exit, so a search that could not execute reported the same thing as
  a search that found nothing — opposite facts, one normal and one meaning the agent is looking at a
  filesystem it cannot read. That is the failure a backend whose `execute` is not a POSIX shell hits,
  which the class docblock warns about in prose and could not enforce.
  
  A genuine no-match still returns `[]`, and the distinction is the one the tools themselves draw:
  `grep` exits 1 for no match and ≥2 for an error, `find` exits 0 with empty output.
  
  If you have a custom backend that is not a POSIX shell and relied on these silently returning nothing,
  they now throw a `ConfigurationError` with code `sandbox_derived_helper_failed`, telling you to
  override them — which the docblock already asked for.
- 0ceeddc: `sanitizeToolInput` now reaches values inside arrays.
  
  It never did. `{ tag: "  a  " }` came back trimmed and `{ tags: ["  a  "] }` came back untouched, with
  nothing in the type or the documentation distinguishing them — the `@public` docblock on `deep` said
  "recurse into nested objects/arrays", and array elements were not reached by any rung, including
  `trim`, which is on by default.
  
  Elements follow the same rules as fields: a string element is sanitized by whichever rungs are on, an
  object element is descended only under `deep`. Array descent itself is not gated by `deep`, because a
  value does not stop being a string by sitting in a list; `maxDepth` counts every hop and is what
  bounds it. Arrays stay arrays.
  
  If you were relying on array contents passing through a sanitizer untouched, they no longer do.
- 558dd30: `SessionStore` declares the three lifecycle hooks the SDK was already calling.
  
  The port declared two methods, and the SDK probed for `acquire`, `release` and `dispose` through
  `as unknown` casts. They worked — but nothing in the interface mentioned them, so a store author
  implementing the documented two-method contract got no writer lease, no release and no disposal, with
  no way to discover that those hooks existed.
  
  They are now optional members with their contracts written down, including the one that matters:
  a rejection from `acquire` whose `name` is `SessionBusyError` **propagates to the caller**, because
  another process holding the session is a decision the caller has to make. Every other rejection is
  treated as "no lease here" and the turn proceeds.
  
  Optional means optional: an existing two-method store keeps working unchanged. What changes is that
  the capability is now readable in the type you implement.
- 94722e8: `StructuredOutputError` distinguishes the causes it already knew apart.
  
  Three different failures reported `no_tool_call`: an agent run that errored
  before producing an answer, a run that was cancelled, and a tool-only completion
  with no text to structure. Only the free-text message differed, so a caller could
  not branch on which had happened without parsing English.
  
  They are now `upstream_run_failed`, `run_cancelled` and `no_text_answer`.
  `no_tool_call` keeps its original meaning — the model did not call the forced
  output tool — and `parse_failed` is unchanged.
  
  BEHAVIOUR CHANGE for a caller matching `no_tool_call`: three of the five cases it
  used to catch now carry their own code. A caller that branched on it for a
  cancelled run was branching on a defect, but the string it matched does change.
  
  The union is exported as `StructuredOutputErrorCode`.
- ae2a720: `THEO.md` now works at the project root, the way `AGENTS.md`, `GEMINI.md` and `CLAUDE.md` already
  do — found from the root, and reachable by walking up from any subdirectory.
  
  Before this, `THEO.md` was the only context file this SDK knows about that had to live inside
  `.theokit/` and could not be found from a subdirectory. The miss was silent: a well-formed
  `THEO.md` at the project root was simply never read, with no warning that it had been ignored.
  
  ```
  project/
  ├── THEO.md              ← now read, walking up from any subdirectory
  └── .theokit/
      └── THEO.md           ← still works exactly as before
  ```
  
  A new `DEFAULT_DISCOVERY_SPECS` entry (`THEO.md.root`, priority 55) is added alongside the
  existing one — nothing about `.theokit/THEO.md` changes, so a project already using it keeps
  working unchanged. When both exist, `.theokit/THEO.md` is the later, winning source on conflict —
  the precedence usetheokit/theokit-sdk#531 asked for.
  
  The new entry sets `followImports: true`, unlike `.theokit/THEO.md` (`false`) and unlike
  `AGENTS.md`. This is deliberate, not an inconsistency: a root-level `THEO.md` is edited by the same
  people, in the same place, as `CLAUDE.md`/`GEMINI.md` — the two other root-level files, both
  `followImports: true` — so it belongs in their category rather than `AGENTS.md`'s vendor-neutral,
  import-free one. Flagged as an open decision in the issue; resolved here because adding a new spec
  rather than reusing the existing one meant it could be decided on its own merits, with zero
  behaviour change for existing `.theokit/THEO.md` files either way.
  
  Closes usetheokit/theokit-sdk#531.
- 266ffc8: Nine failures that used to arrive as a bare `Error` now carry a type and a code.
  
  `docs/error-codes.md` says to branch on `code`, never on the message — messages carry context and
  change with it. These nine gave you no code to branch on:
  
  - `MessageBus.send` / `request` against an unregistered peer now reject with the new
    `A2APeerNotRegisteredError` (`a2a_peer_not_registered`), carrying `to`. The timeout branch of those
    same two methods was typed under #380; this was the branch above it.
  - The ChatGPT provider's missing-credential path now throws `AuthenticationError`
    (`missing_credential`), matching the router path that handles the same condition.
  - `createSkill`, `createTokenLimiter`, `defineSkillReadTool`, the two `Workflow` builder guards, and
    `Security.addPattern` now throw `ConfigurationError` with a code each.
  
  Because `isTransientError` is `err instanceof TheokitAgentError && err.isRetryable`, a bare `Error`
  was also permanently invisible to retry logic. These now answer the question.

### Patch Changes

- eae788a: **`memory.directory` now moves the search index with the store, except into the Claude Code CLI's own directory** (#554).
  
  The index is not a pointer. `chunks.text` holds the fact TEXT — FTS5/BM25 needs it to search — and `files.path` holds the store's absolute path. So a copy of the index is a copy of the memory, readable with `strings`.
  
  Leaving it at `<cwd>/.theokit/memory/.index/` while the facts moved meant an operator who pointed `directory` at one personal store had that store's contents written into **every repository the agent ran in**, untracked and un-ignored. Recall worked throughout, so nothing looked wrong; what was wrong was where the data landed.
  
  ```
  before   /tmp/my-store/fact.md              facts move
           /any-project/.theokit/memory/.index/memory.sqlite    ← and the content follows here
  
  after    /tmp/my-store/fact.md
           /tmp/my-store/.index/memory.sqlite                   ← one store, one index
  ```
  
  ## The Claude Code case is unchanged, on its own argument
  
  `docs/memory-decisions.md` § 1 keeps the index in the project store when `directory` names the directory the Claude Code CLI manages: that CLI has no index format, so a binary there is an artefact the partner does not understand inside a directory it owns. That argument reaches **that** directory and no other, and the fix narrows the behaviour to match it rather than reversing the decision. `tests/claude-code-e2e-compat.test.ts` passes unchanged.
  
  `memoryIndexRoot` (`internal/memory/storage/memory-root.ts`) is the single place that decides, using the path-only test `indexBudgetWarning` already relied on — no new heuristic.
  
  ## Two things corrected alongside
  
  **The recorded decision said something that had stopped being true.** *"The index is derived data that can be rebuilt from them"* was true of its derivability and false of its contents, and was doing the work of both. § 1 now quotes the schema and dates the narrowed scope.
  
  **A test fixed the behaviour more widely than its own reason supported.** `test_the_index_database_stays_in_the_project_store_even_when_the_facts_move` used a plain `mkdtempSync` tmpdir, not the CLI's directory — so it pinned § 1 for *every* location when § 1 argues for one. That is why the leak stayed invisible: the test read as the decision being enforced. It now covers the plain-directory case, and `tests/memory/index-follows-a-relocated-store.test.ts` pins both halves.
- 667bd3d: A hook or lifecycle command that exits without reading its stdin no longer raises an uncaught
  `EPIPE` in the SDK's own process.
  
  `spawnAndCollect` writes the JSON payload to the child's stdin. A child that never reads it —
  `exit 1`, a hook that only inspects the environment, any command that ignores the payload — closes
  the pipe first, and the write then raises `EPIPE` on a stream with no `error` listener, which Node
  promotes to an uncaught exception. The child was behaving perfectly legitimately; the host process
  took the fault.
  
  The error is swallowed rather than surfaced: the child's exit code and stderr are the result, and
  both are collected either way. A payload nobody read is not a failure of the spawn.
- 070ee92: A foreign plugin's entry file is now checked against the root it was actually discovered under.
  
  `refresh()` iterates every root a compat source admits — `.theokit/plugins`, and `.claude/plugins`
  once `compatSources` names the `plugins` surface — and checks each plugin's declared `entry` file
  exists. That check reconstructed the plugin's directory as `.theokit/plugins/<folder>`
  unconditionally, regardless of which root the plugin was actually found under.
  
  A plugin discovered at `.claude/plugins/my-plugin/` was therefore checked against
  `.theokit/plugins/my-plugin/` — a directory it never lived in. With nothing there, a legitimate
  foreign plugin was refused as "entry file is missing." Had a same-named folder existed under
  `.theokit/plugins/` instead, its entry file would have been read in place of the real one — a path
  confusion the ADR D79-D80 traversal guard this check calls does not catch, because the guard runs
  against the wrong root rather than against none.
  
  This was reachable through the bare `compatSources: ["claude-code"]` form, which has always admitted
  the `plugins` surface — not something the per-surface work landing alongside this introduced.
  
  Found while testing the per-surface admission work for usetheokit/theokit-sdk#524.
- 131ab8b: A foreign plugin's `source` field is now a real relative path instead of a single character.
  
  Both manifest loaders (Claude Code's `.claude-plugin/plugin.json` form and this SDK's own
  `PLUGIN.md`/`plugin.json`) built `source` by searching the manifest path for the literal substring
  `.theokit/` and slicing from there. A manifest read from `.claude/plugins/<name>/…` contains no such
  substring: `indexOf` returns `-1`, and `.slice(-1)` silently returned the manifest path's LAST
  CHARACTER — `"n"` from `.json`, `"d"` from `PLUGIN.md` — instead of a path.
  
  `source` is exactly the audit trail the visibility half of usetheokit/theokit-sdk#524 exists to
  provide, and this was broken for precisely the case that matters most: a plugin admitted from a
  foreign root. Replaced the substring search with `path.relative(cwd, manifestPath)` — the stdlib
  does this correctly, and it is what the substring search was trying to approximate.
  
  Found alongside the entry-file root confusion, testing the same per-surface admission work.
- 4415f83: An unrecognised key under `local` is now reported on the diagnostics channel instead of being
  accepted in silence.
  
  Measured before this: `Agent.create({ local: { compatSourcess: [...] } })` — one letter wrong —
  created the agent with no throw, no warning, and nothing anywhere. That made two very different
  failures identical: a typo and an SDK too old to know the option both produced the default
  behaviour and no complaint.
  
  It is the reason `usetheokit/theokit#634` is blocked rather than merely unimplemented — a forward
  of `compatSources` written against a published SDK would be inert, and no consumer could tell.
  The same shape produced the `$CLAUDE_PROJECT_DIR` defect and motivated the `compatSources` opt-in:
  a surface that accepts input and does nothing with it, where the absence of a complaint reads as
  acceptance.
  
  The message names the key and the nearest known one, so one letter wrong is one line to read
  rather than a trip to the documentation. It is a warning, never a refusal: rejecting an unknown key
  would break every consumer passing a forward-compatible extra — the ordinary way to write code that
  runs against two SDK versions — and turn a diagnostic problem into an outage. A correct
  configuration emits nothing, and there is a test for that, because a warning that fires on valid
  input stops being read.
- 9181434: A failed atomic write no longer leaves its temp file behind.
  
  `replaceFileAtomic` — which backs the agent registry, session transcripts, MCP token storage and
  everything else the SDK persists — cleaned up its `.tmp` on a rename failure and on no other. A
  failure between the open and the rename, meaning a write error, a full disk, or an fsync failure,
  closed the file handle and propagated with the temp still on disk.
  
  Every failure after the open now removes it. A process killed mid-write still leaves one, which no
  code inside that process can prevent; `sweepStaleAtomicTemps` reaps those on the next registry load.
- edfa59c: `Agent.batch(prompts, { task })` now rejects when the batch task fails, instead of resolving with an
  empty array.
  
  The task-wrapped path assigned its results inside the task's `work` callback and then returned that
  variable unconditionally, so three different failures produced one indistinguishable value: the work
  threw, the task was cancelled, or a fixed 5000-iteration poll budget elapsed. Each returned `[]` on
  a **resolved** promise — which a caller cannot tell apart from `Agent.batch([])` on empty input.
  Nothing threw and nothing was logged, and the registry's own `{ code, message }` for the failure was
  discarded by a loop that read only the task's `state`.
  
  The poll is gone. The wait is now the task's terminal event, which carries the failure detail:
  
  - work threw → rejects with `code: "batch_task_failed"`, the registry's code on `protoErrorCode`
  - cancelled → rejects with `code: "batch_task_cancelled"` and the reason, when one was given
  
  The removed budget was not a safety net: 5000 iterations of a 5 ms sleep is roughly 25 seconds, so a
  batch legitimately longer than that would trip it and return `[]`. The bound generated the failure
  it appeared to guard against.
  
  If you were checking `results.length === 0` to detect a failed batch, catch the rejection instead —
  an empty array now means only what it says.
- edfa59c: Corrected the published JSDoc for `AgentOptions.budgetTracker` and `AgentOptions.memoryProvider`,
  which told consumers the opposite of what the SDK does.
  
  Both carried a paragraph stating the option was "wired to the type surface only" and that a consumer
  supplying one "gets the type guarantee but NOT runtime enforcement". Neither has been true for some
  time. `budgetTracker` is read by the agent loop before every iteration (`evaluateBudgetGate`),
  advanced with `nextIteration()`, and charged with `track(...)` after each completion.
  `memoryProvider` has its full lifecycle driven — `init`, `buildTools`, `runActivePass`, `sync`,
  `dispose`.
  
  No behaviour changes here; the code was already correct. What changes is what the published `.d.ts`
  tells you, and it was wrong in the expensive direction: a consumer reading it was told the SDK would
  not enforce their cost ceiling, so the rational response was to build a second control outside the
  SDK, or to stop passing the option at all.
  
  Six occurrences of the claim were corrected across `types/agent.ts`, `index.ts` and the loop's own
  input types, and a lint now requires any "not implemented yet" note to carry a tracking reference and
  a date, so the next one expires instead of outliving the work it describes.
- 4be7411: `Budget.create` now refuses `scope: "agent"` and `scope: "call"` with a
  `ConfigurationError` (`unimplemented_budget_scope`).
  
  Only `"process"` was ever implemented. Nothing outside the registry read `scope`,
  so the other two were accepted and silently ignored: a caller asking for
  per-agent accounting got process-wide accounting with no signal. A cost control
  that reports the wrong number is worse than a missing feature.
  
  `FnStep.compensate` is marked deprecated. It was never implemented — setting it
  arms `WorkflowCompensateNotImplementedError`, so the step fails at run time.
  
  `AgentLoopInputs` declares `maxConsecutiveToolErrors` and `maxConcurrentTools`,
  which were read through inline casts and appeared in no type. A typo in either
  name now fails to compile instead of silently taking the default.
- 24fb692: `Cron.create()` now reports when the job will actually next fire.
  
  It reported `now + 1 hour` for every expression. The function behind it read neither the cron
  expression nor the timezone — a `@yearly` job said it would run within the hour, and so did a
  `*/5 * * * *` one. Its own docstring scoped it to fixture mode ("real scheduling uses a proper
  evaluator wired in by the local scheduler"), and its only caller was `Cron.create()`.
  
  The local scheduler overwrote the value for jobs it picked up, which is why this survived: the wrong
  number was visible between creating a job and the scheduler reaching it, and permanently for a job
  the scheduler never runs — a job created against a cloud runtime, or created while the scheduler is
  stopped.
  
  `nextRunAt` is now computed with croner, which was already a dependency and already doing exactly
  this inside the scheduler. When an expression has no next run — `0 0 30 2 *`, a date that never
  occurs — the field is absent rather than filled with a number, which is what the optional
  `CronJob.nextRunAt` already meant.
- edfa59c: Two abstractions with no implementers and no consumers are gone. Nothing published changes.
  
  `internal/security/secret-redactor.ts` declared a `SecretRedactor` interface that `redactSecrets`
  happened to satisfy. It was added to raise the module's abstractness out of a coupling metric's "zone
  of pain", and nothing ever held it — no implementer, no consumer, absent from every barrel. An
  interface nobody holds does not change what any module depends on, so the number it was added to move
  could not have moved either. Its README section now records that, and keeps the reasoning that
  rejects chasing the metric in the first place.
  
  `server/adapter/express.ts`, `fastify.ts` and `hono.ts` were byte-identical below their docblocks:
  two imports and a one-line delegation each, with no framework type imported or adapted anywhere. They
  are replaced by a single `server/adapter/index.ts` whose docblock says what the function actually
  returns — a route descriptor the host binds itself, not middleware. The three per-framework docblocks
  claimed an adaptation that did not exist, which is the half of this that could mislead a reader.
  
  Their three test files, which had quietly drifted into three different levels of coverage, are one
  file carrying the union of their cases plus one new case asserting the descriptor contract directly.
- 374dd5f: Embedding requests now retry with the same jittered exponential backoff the rest of
  the SDK uses, and honour the provider's `Retry-After` header.
  
  They used to back off linearly at `50ms * attempt` and ignore `Retry-After`, so two
  clients hitting a rate-limited embedding endpoint retried in lockstep and neither
  waited as long as the provider asked. The delay is tuned tighter than the LLM
  transport's — 250ms base, 4s cap rather than 500ms/32s — because an embedding retry
  sits inside a memory write on the run's critical path.
- 63617cd: Hooks imported from `.claude/settings.json` now run with `$CLAUDE_PROJECT_DIR` defined, so a
  repository that also uses Claude Code stops denying every turn.
  
  Reading that file is a deliberate compatibility decision, but the commands inside it are written for
  Claude Code's runtime, which defines that variable and whose documentation tells hook authors to
  reach project files through it. This SDK did not define it, so `sh` expanded it to the empty string
  and `bash "$CLAUDE_PROJECT_DIR/.claude/hooks/guard.sh"` ran as `bash "/.claude/hooks/guard.sh"` — a
  file that does not exist, which a hook runner correctly reads as a refusal. The result was every
  tool call denied, in any repository whose only unusual property was having Claude Code set up, with
  a message naming a script that was present and executable all along.
  
  A denial caused by an undefined variable now names the variable. `$CLAUDE_PLUGIN_ROOT` and the rest
  of that runtime's surface are still not supplied — inventing a value would send a script somewhere
  real and wrong — but a hook that needs one fails saying which, instead of reporting a path that
  failed ten characters later.
- edfa59c: HTTP 408 is now classified as a retryable timeout instead of a configuration error.
  
  `mapHttpStatusToError` in `internal/http.ts` had no arm for 408, so a Request Timeout fell through
  to the generic `4xx` branch and came back as a `ConfigurationError` — `isRetryable: false`. Every
  one of the four provider-specific mappers already did the opposite: `openai-compatible`, `anthropic`,
  `bedrock` and `vertex` all map 408 to a `NetworkError` carrying a `timeout` code, which is retryable.
  The generic ladder is a fifth copy of the same knowledge and it was the copy that drifted.
  
  The failure was silent and pointed the wrong way. Nothing threw: a caller branching on
  `isTransientError` simply refused to retry a request that would very likely have succeeded, and did
  so only on the paths that went through the generic mapper rather than a provider one.
  
  If you were catching `ConfigurationError` to handle 408 specifically, catch `NetworkError` instead —
  or branch on `code`, which is what `docs/error-codes.md` asks for.
- edfa59c: The HTTP status ladder now has one definition instead of four, and two drifted copies are repaired.
  
  `401/403 → auth_failed`, `402 → quota_exceeded`, `408 → timeout`, `429 → rate_limit`,
  `400 → invalid_request`, `5xx → server_error` is RFC 9110 semantics, not a vendor contract: a 429
  means the same thing whichever provider sent it. It was nevertheless written out in all four
  provider mappers, and the copies had already diverged in two ways that reached users:
  
  - **HTTP 402 reached one mapper of four.** `quota_exceeded` was wired into the OpenAI-compatible
    mapper only, so a Bedrock, Vertex or Anthropic endpoint answering 402 fell through every arm and
    surfaced as `unknown`. The canonical bucket existed and three of four mappers could not reach it.
  - **The server arm had two different upper bounds.** Anthropic and OpenAI-compatible guarded
    `>= 500 && < 600`; Bedrock and Vertex guarded `>= 500` with no ceiling, so a malformed or
    proxy-injected 6xx was `server_error` in two mappers and `unknown` in the other two.
  
  The ladder now lives once, in `internal/error-mappers/shared.ts`, beside the other dialect-agnostic
  helpers. Each mapper keeps its own body dialect — Anthropic's `context_too_long`, OpenAI's
  `insufficient_quota`, Bedrock's AWS `__type` strings and 404 rule, Vertex's `google.rpc` enum with
  its finer `unauthenticated`/`permission` split — because those *are* per-vendor contracts. The
  shape is now `classifyVendorBody(body) ?? httpStatusToErrorCode(status)`.
  
  Visible changes: 402 now yields `quota_exceeded` (was `unknown`) on Anthropic, Bedrock and Vertex,
  and a status of 600 or above now yields `unknown` (was `server_error`) on Bedrock and Vertex. HTTP
  404 is deliberately unchanged everywhere.
- 926cb81: Removed `LanceMemoryAdapter.unwrap()`, which handed callers the raw `LanceIndex`
  behind the adapter. It had no callers anywhere in the monorepo — including the
  migration tool and benchmark script its own docblock named, both of which open a
  `LanceIndex` directly and never go through the adapter.
  
  A caller that needs `addFacts` / `countFacts` / `removeFacts` needs a
  `LanceIndex`, and opening one is the honest way to get it.
- 7f91326: The Lance memory backend now honours `SearchOptions.vectorWeight` and
  `textWeight`. It blended hits with hard-coded 0.7 / 0.3 literals and never read
  the options, so a caller that tuned the weights had its tuning applied on the
  SQLite backend and silently dropped on Lance.
  
  Unweighted Lance results shift slightly as a consequence: the shared defaults are
  0.6 / 0.4, and one of the two hard-coded numbers was never the contract's.
  
  Workflow step logging (`ctx.log.debug` / `.info` / `.warn`) now goes through the
  SDK's diagnostics channel instead of `console`, so a host that installs a
  diagnostics sink — a TUI, for instance — receives it instead of having its frame
  written over.
- edfa59c: Two internal modules moved to the layer they belong to. No public API changed.
  
  `src/errors.ts` is the package's leaf — fifteen files under `internal/runtime/` import the typed
  error hierarchy from it — and it imported back up into `internal/runtime/retry/` for one helper. The
  helper encodes which error codes are retriable, which is a property of the error taxonomy rather
  than of the retry runtime, so it now lives in `internal/error-mappers/` beside the other mapping
  knowledge. One import path changed; the file itself was moved, not rewritten.
  
  `internal/security/` is the most-depended-upon module in the tree and held node builtins and
  `errors.js` and one exception: a path-containment primitive it reached for in
  `internal/runtime/context/`. That primitive had four consumers and only two were in the folder it
  sat in — it lived there because that is where it was extracted from, not because it belonged there.
  It is now `internal/security/path-containment.ts`, and all four consumers import downward into
  `security/`, the direction the rest of the tree already runs.
- 243bd2c: The live-agent registry and the session cache survive a package loaded twice.
  
  `liveAgentRegistry` and the session cache's two maps were plain module-level `const`s, which are
  singletons per module INSTANCE. A package can be loaded more than once in one process — two copies in
  `node_modules`, ESM and CJS side by side, a monorepo with distinct versions — and each copy then gets
  its own registry. For the live-agent registry, the public one, that means two views of which agents
  are running, and a caller reading the wrong one sees none.
  
  All three now go through the same `Symbol.for`-keyed helper the rest of the SDK uses.
  
  The session cache's docblock asserted that the instances "remain the only ones in the process, because
  an ES module is a singleton". That is the claim the helper exists to refute; the docblock now says so.
- edfa59c: `LiveSessionError` from `@theokit/sdk/persistence` is renamed to `LiveTranscriptError`. The old name
  still works and is deprecated.
  
  Two different classes were called `LiveSessionError`, exported from two declared subpaths that one
  consumer can hold at once. They have incompatible shapes: the root barrel's is
  `new LiveSessionError(sessionId, reason)` with a `reason` field and no `code`; the persistence one
  was `new LiveSessionError(path)` with a `path` field and `code: "live_session_protected"`.
  
  The failure was quiet in the way that costs most. `instanceof` is class identity, so a `catch`
  checking the class imported from the root silently did not match the one thrown from persistence, and
  the fallback ran for a condition the code believed it had handled. A `name` check looked like it
  worked — `err.name === "LiveSessionError"` matched *both* — and then read `err.reason`, which only
  one of them has.
  
  The names now say what each refusal is about: refusing to destroy a **session**, and refusing to
  overwrite a **transcript** file. `LiveSessionError` remains exported from `@theokit/sdk/persistence`
  as a deprecated alias so existing imports keep working; it will be removed in the next major.
- ba6549f: An MCP client with a tight `requestTimeoutMs` can reconnect after a drop.
  
  `reconnect()` recovers by spawning a fresh child and running the `initialize` handshake, and that
  handshake was bounded by the same `requestTimeoutMs` the caller set for ordinary requests. Setting a
  tight request budget — an ordinary thing to do for a latency SLO — silently made a client unable to
  recover: every reconnect attempt spawned a process that could not finish inside a steady-state budget,
  the bounded loop exhausted, and the client surfaced `mcp_disconnected`. That is the wedge the bounded
  loop exists to prevent.
  
  The reconnect handshake now takes `max(requestTimeoutMs, 10s)`.
  
  The **first** connect is unchanged and keeps your budget exactly. The difference is which failure is
  visible: a `requestTimeoutMs` too small to connect at all fails at the call you made, immediately, and
  is yours to correct. The reconnect is the SDK's own recovery, which you never sized and never see
  until a drop happens.
- edfa59c: `MemoryIndex.sync()` and `.status()` now say whether their numbers were measured.
  
  `MemoryIndex` has two implementations. `IndexManager` walks a markdown corpus and counts rows with
  `SELECT COUNT(*)`. The Lance backend has no corpus — it is a vector store fed by explicit writes —
  and it answered with a frozen all-zeros `SyncResult` and a hardcoded `filesIndexed: 0,
  chunksIndexed: 0`. Those are indistinguishable from a real sync that found nothing to do and a real
  index that is empty, and the comment above them stated that as the goal: *"Returns zero counts so
  callers' existing logging does not break."*
  
  The consequence was a false negative rather than a crash. A caller deciding "is the index
  populated?" from `chunksIndexed > 0` got `false` on every Lance run, however many rows the table
  held.
  
  Two required fields make the difference visible:
  
  - `SyncResult.supported` — `true` from `IndexManager`, `false` from Lance
  - `IndexStatus.countsExact` — `true` when counted, `false` when the number is a placeholder
  
  The counts stay zero. Inventing a number would have traded one false claim for another; what changed
  is that a caller can no longer read a placeholder as a measurement. Both fields are also on the
  public `MemoryIndexHandle`, so a consumer holding the handle can see them. If you need the real Lance
  count, `unwrap().countFacts()` still returns it.
- 21be5cb: `migrateSqliteToLance` now rejects a `batchSize` its loop cannot advance with,
  before touching the workspace.
  
  A `0` or a negative made the migration spin forever, calling `addFacts([])` and
  logging a progress line every iteration. `NaN` — which `Number("abc")` produces —
  made it migrate nothing and report "Validation FAILED. SQLite preserved.",
  blaming the migration for a typo. Both now raise a `ConfigurationError` with code
  `invalid_batch_size`, naming the value received.
- edfa59c: A dropped connection to Ollama is now retried instead of surfacing on the first attempt.
  
  `OllamaNativeClient` rethrew the raw `fetch` rejection when its own body-dialect mapper did not
  recognise the failure, and threw a bare `new Error` for any HTTP status the dialect did not cover.
  Both land outside the SDK error hierarchy, and that decides retry behaviour by contract rather than
  by chance: `isTransientError` is `err instanceof TheokitAgentError && err.isRetryable === true`, and
  the router wraps every resolved client in `RetryingLlmClient`. A foreign error is therefore
  non-transient by definition — so the most ordinary failure a local Ollama can produce, a dropped
  connection, was never retried.
  
  The repository had already found and fixed this for the other transports; `openai.ts` records the
  measurement and names Ollama as the one still carrying it. Transport failures now go through
  `wrapTransportError` (which passes `AbortError` and any already-mapped SDK error through untouched,
  so nothing gets relabelled), and unrecognised statuses go through the shared HTTP status ladder
  rather than a bare `Error`.
  
  Visible change: these two paths now reject with `NetworkError` (`code: "transport_failure"`) and a
  typed error carrying the status, instead of a `TypeError` and an `Error`. A caller branching on
  `instanceof Error` is unaffected; a caller branching on `isTransientError` starts getting retries.
- 5d174f2: Three pieces of duplicated logic now have one owner each. One internal error message improves.
  
  The `~4 chars per token` estimate had two `@public` implementations reachable from two entry points —
  `built-in-processors.ts` with a named constant, `compaction.ts` with the ratio inlined. Tuning it, or
  switching to code points instead of UTF-16 units (a caveat both docblocks already carried), would have
  silently diverged them. It lives in `compaction.ts` now, with `CHARS_PER_TOKEN` exported beside it;
  `built-in-processors.ts` re-exports both under the same names, so nothing published changes.
  
  The error-body reader duplicated character-for-character in the Bedrock and Vertex mappers is one
  `parseErrorBody` in their shared module. It describes how `fetch` surfaces a body, which is the same
  whoever sent it.
  
  `abortError` had three copies — including inside the two files the extraction's own docblock named as
  the ones that should stop having one. **One of the three behaved differently**: the pool-aware client
  discarded a non-`Error` abort reason and raised a generic `"AbortError"`. All three are now the shared
  implementation, which carries the caller's reason through. If you cancel with
  `controller.abort("shutting down")` and the pool-aware client is in the path, the rejection message is
  now `shutting down` rather than `AbortError`.
- 7b4063b: One resolver now answers "where does this project's configuration live?" — `theokitConfigRoot(cwd)`,
  in `internal/persistence/paths.ts`, semver-exempt.
  
  Five readers hand-rolled `join(cwd, ".theokit", ...)` independently: `mcp.json`, the context
  directory + `context.json`, the hooks-root fallback check, `registry.json`, and the personality
  `PROJECT_SUBDIR`. `projectConfigRoots` (hooks/skills/subagents/plugins, per usetheokit/theokit-sdk#524)
  already resolved its native root the same way, inline, making six independent copies of one
  constant.
  
  No filename, format or resulting path changes — this is a pure consolidation, and the project's own
  lint gate (`no-hardcoded-theokit-path.test.ts`, ratcheted 23 → 14) is the proof: every literal this
  change removed was already flagged as migration debt, and the full suite is unchanged.
  
  Deliberately does NOT touch homedir-anchored state (sessions, credentials, the personality
  `USER_SUBDIR`, provider discovery) — those follow `getTheokitHome`/`THEOKIT_HOME` by design, and
  folding them into this resolver would be the exact silent behaviour change
  `theokitConfigRoot`'s own docblock warns against: a project's committed configuration must never
  follow an operator's relocated state directory. A regression test pins this — swapping the
  resolver's body for `getTheokitHome`'s would move all six readers under `THEOKIT_HOME` at once, in
  one line, with no caller-side signal.
- 0c4df84: The `PermissionRule` documentation described a bug that was fixed, and told you to work around it.
  
  The public docblock warned that a predicate matcher is invoked with `undefined` when the call omitted
  the argument — so an allow-rule written to narrow would authorize an argument-less call, and a
  deny-rule would throw a `TypeError` out of the permission gate. It closed by telling you to guard the
  parameter in every predicate you write.
  
  None of that has been true since `argMatches` started checking for a missing argument first, for
  every matcher form. **A rule that declares an argument the call did not supply does not match, and
  the predicate is not invoked.** You do not need the hand-written guards.
  
  The fixed behaviour also had no test — deleting the guard left the entire suite green — so three
  cases now cover it, including the two the old docblock described.
- 01630ec: The README explains that three unrelated things in this ecosystem are called "plugin", and that
  two of them share one option.
  
  A **framework plugin** (`@theokit/plugin-canvas`, `@theokit/auth-github`, …) extends a `theokit`
  application — routes, UI, devtools, CLI verbs. An **SDK code plugin** (`PermissionPlugin.create(…)`,
  `Handoff.asPlugin(…)`) extends an agent and is passed as `Agent.create({ plugins: [ … ] })`. The
  same option also accepts `{ enabled: ["name"] }`, which selects **file-discovered** plugins under
  `.theokit/plugins/` and is mutually exclusive with the array form.
  
  Reaching for the wrong one raises no error; it simply has no effect. Installing `plugin-payments`
  does nothing for an agent, and passing `PermissionPlugin` does nothing for a route.
  
  It also records the observation that sends people looking for a bug that is not there:
  `agent.pluginsManager` only ever holds the file-discovered form, so it reports `plugins: []` while
  a code plugin is registered and working. An empty manager beside a populated `options.plugins` is
  the normal shape.
- edfa59c: The Responses-API transport's SSE state machine is a class, and the eight event kinds it handles are
  now covered by tests.
  
  `ResponsesApiClient.stream` inlined the whole dispatch: one 165-line generator, ten mutable locals
  and eight `else if` arms, carrying a suppression that described it as "mirroring
  `OpenAIStreamAccumulator.consume`". It mirrored what that method does, not how it is organised —
  `consume` is seven lines delegating to small private methods. The state machine now lives in a
  `ResponsesStreamAccumulator` shaped like its sibling, the suppression is gone, and every function in
  the file is under the complexity threshold the project sets for itself.
  
  The refactor is behaviour-preserving, and that claim was measured rather than asserted. Each arm of
  the dispatch was mutated in turn before the change: three of eight killed a test, five did not — the
  reasoning deltas, the incremental tool-argument accumulation, `response.incomplete` → `max_tokens`,
  the reasoning/cache token counters, and the in-stream failure path. Notably, a comment in the
  existing suite claimed the argument deltas were exercised "because the parsed input below can only
  be right if they were accumulated"; deleting the accumulation left that suite green, because the
  recorded fixture repeats the full arguments on the terminal event.
  
  Eight characterisation tests close those gaps, and re-running the battery after the extraction kills
  all eleven mutants. Two behaviours documented for the first time by that battery: the tool name is
  taken from the frame that announced the call when the completion frame omits it, and frames sent
  after `[DONE]` are ignored.
  
  No public API changed.
- d1182ae: A resumed session now replays its history as structured tool calls instead of flat text, so the
  model stops learning to type `[tool call] <name>` as prose.
  
  Hydration has always produced two projections of each stored turn: `text`, in which a tool call
  folds to the marker `[tool call] NAME`, and structured `parts`, which carries the call id, the tool
  name and the arguments. The replay read `text` alone. So a resumed session showed the model its own
  prior turn as prose containing the marker, and the model did the reasonable thing with a pattern it
  is shown — it wrote the marker instead of calling the tool. Downstream that surfaced as an assistant
  message ending `"…report its output.[tool call] run_shell"` with no tool call behind it: the tool
  did not run, nothing errored, and the transcript read as the model narrating an action it never took.
  
  A turn with no `parts` replays exactly as before, so sessions stored by an older SDK keep the
  behaviour they were written under. Tool results replay as a user message, which is the convention
  the live loop already uses.
  
  **An already-affected session recovers on its next turn.** No need to start a new one or delete
  anything: the stored `parts` were always correct — only the `text` projection carried the marker —
  so reading structure instead of prose heals a contaminated transcript rather than merely stopping
  new contamination. Verified against a session that had accumulated seven occurrences of the marker.
- 1499923: `@theokit/sdk/sandbox` marks `resetInteractiveWarnLatch` and `resetSandboxWarnLatch`
  as deprecated. Both are test seams for WARN-once latches that were re-exported
  under plain camelCase, reading like ordinary API. They still work and are removed
  in the next major; there is no replacement, because production code has no reason
  to reset a warn-once latch.
  
  `resetBwrapMemo` is NOT deprecated and now documents why it is public: it is the
  companion to `detectBwrapMemoized`, and the only way to make a long-lived host
  re-probe after `bwrap` is installed.
- f64ab2b: `SessionManager` gains an optional `getCookieSecret()`, the member `defineAuth`
  uses to encrypt the OAuth transaction cookie.
  
  It is additive: a manager without it falls back to `THEOKIT_OAUTH_TX_SECRET`
  exactly as before. What changes is that the orchestrator no longer casts its own
  port away to read an undeclared `secret` field — a shape no conforming
  implementation could supply.
- 6aeeadb: Telemetry auto-instrumentation now logs what each adapter actually wired.
  
  Five of the seven adapters install something concrete — an OTel span processor,
  an event processor, a vendor client. Braintrust and LangSmith cannot: those
  vendors auto-instrument from an env var, so loading the module is the whole
  contribution. Both are legitimate, but the registry printed
  `Braintrust auto-instrumented.` for the second kind, which read as a wired
  telemetry pipeline when nothing had been installed.
  
  `register()` now returns what it wired and the registry reports that instead of
  asserting a single outcome for all seven. A vendor that is detected but cannot
  be wired says so too, rather than being logged as instrumented.
- 7f2bce4: Test-only: the MCP token-store fixtures create their temporary directories atomically.
  
  CodeQL reported an insecure temporary file at high severity, and the report was right. The
  directories were built from a predictable name — `theokit-mcp-tokens-${hrtime}` under a
  world-writable `/tmp` — and one of them was created world-writable and populated afterwards. On a
  shared machine another local user can predict the path, win the race to create it, and plant a file
  the test is about to trust; the restrictive mode passed to `mkdirSync` arrives after the name has
  already been claimed.
  
  `mkdtempSync` creates with a random suffix and mode 0700 in one atomic step. The one fixture whose
  loose modes ARE the subject — the case proving the gate refuses a world-writable store — creates
  restricted and loosens with `chmod`, so the state under test is identical and the window is closed.
  
  No production code is affected and no assertion changed.
- edfa59c: The "no transport" error no longer tells you to install a package that cannot exist.
  
  When a provider declares an `apiMode` the SDK has no transport for, the thrown `ConfigurationError`
  advised: *"Install a third-party transport plugin (`@theokit-transport-{apiMode}`)"*. There is no
  plugin mechanism to install into — `registerTransport` and `transportRegistry` appear nowhere in the
  package, and the only other mention of `theokit-transport` was a docblock describing that very
  message. Someone could publish the package; nothing would load it.
  
  The message now says transports are a built-in, closed set, and names all four of them —
  `chat_completions`, `anthropic_messages`, `bedrock_anthropic`, `responses_api` — instead of two. The
  `transport_unavailable` code is unchanged, so anything branching on `code` is unaffected.
- e0a1ab9: Three public failure paths now carry a type and a code instead of a sentence.
  
  `normalizeSchema` threw bare `Error` for both of its failures — a missing
  `@valibot/to-json-schema` peer and an unsupported schema — so a caller could
  branch on nothing but the message. Both are `ConfigurationError` now, with codes
  `valibot_converter_missing` and `unsupported_schema`. It also detects the missing
  peer from `err.code === "ERR_MODULE_NOT_FOUND"` before falling back to matching
  the message text.
  
  Resuming an agent whose persisted workspace path exists but is a file now says
  so, instead of reporting it as "missing or inaccessible".
  
  Subscription error frames carry the server error's own `code` over the wire, and
  the WebSocket client prefers it over its blanket `ws_server_error`. A caller can
  tell an invalid input from a disconnect without parsing English.
- edfa59c: Workflow errors now carry `code` and `isRetryable`, so the SDK's own retry helper can see them.
  
  Eleven public workflow error classes extended plain `Error`. `isTransientError` is
  `err instanceof TheokitAgentError && err.isRetryable === true`, and it is the default predicate of
  `Retry.create` — so a class outside the hierarchy is permanent *by contract*, whatever it actually
  represents. Wrapping `workflow.run()` in the SDK's own retry helper therefore got `false` for every
  workflow failure, including `WorkflowAlreadyRunningError`, which is precisely the
  try-again-in-a-moment condition.
  
  They now extend `TheokitAgentError`, each with a stable `code`:
  
  | code | retryable |
  |---|---|
  | `workflow_already_running` | **yes** — another run holds the single-flight lock |
  | `workflow_duplicate_step_id`, `workflow_input_invalid`, `workflow_output_invalid`, `workflow_state_invalid`, `workflow_nested_failed`, `workflow_snapshot_not_found`, `workflow_max_iterations_exceeded`, `workflow_not_serializable`, `workflow_resume_step_not_found`, `workflow_compensate_not_implemented` | no |
  
  Source-compatible: `TheokitAgentError extends Error`, so `instanceof Error` and `err.name` are
  unchanged, and every existing field (`stepId`, `workflowName`, `detail`, …) stays where it was.
  
  `WorkflowParallelError` is deliberately unchanged — it extends `AggregateError`, and the standard
  `errors` array is why callers catch it. It stays outside the hierarchy, and therefore stays
  non-retryable; inspect `err.errors` and decide per branch.

## 5.0.0-next.4

### Minor Changes

- 85b5c2f: A host can read the messages a session already contains
  
  `readSessionMessages` was compiled into the package and missing from the type surface, so a
  surface that repointed a session could not re-render it: the messages were on disk, the SDK
  read them to give the model its context, and the screen stayed empty while the model
  demonstrably remembered.
  
  ```ts
  import { readSessionMessages } from "@theokit/sdk";
  
  const history = await readSessionMessages({ sessionId, cwd: projectDir });
  for (const m of history) render(m.role, m.text);
  ```
  
  `cwd` defaults to `process.cwd()`, and `sessionDir` is only needed when the agent was created
  with `local.sessionDir`. A session that was never written resolves to `[]` — a fresh session
  has no history, which is not an error.
  
  The internal reader takes a `SessionStore`; this one does not, so the transcript layout and
  the record shape stay private. A host that already has a custom store can read from it
  directly. (#546)

## 5.0.0-next.3

### Minor Changes

- ae2a720: `THEO.md` now works at the project root, the way `AGENTS.md`, `GEMINI.md` and `CLAUDE.md` already
  do — found from the root, and reachable by walking up from any subdirectory.
  
  Before this, `THEO.md` was the only context file this SDK knows about that had to live inside
  `.theokit/` and could not be found from a subdirectory. The miss was silent: a well-formed
  `THEO.md` at the project root was simply never read, with no warning that it had been ignored.
  
  ```
  project/
  ├── THEO.md              ← now read, walking up from any subdirectory
  └── .theokit/
      └── THEO.md           ← still works exactly as before
  ```
  
  A new `DEFAULT_DISCOVERY_SPECS` entry (`THEO.md.root`, priority 55) is added alongside the
  existing one — nothing about `.theokit/THEO.md` changes, so a project already using it keeps
  working unchanged. When both exist, `.theokit/THEO.md` is the later, winning source on conflict —
  the precedence usetheokit/theokit-sdk#531 asked for.
  
  The new entry sets `followImports: true`, unlike `.theokit/THEO.md` (`false`) and unlike
  `AGENTS.md`. This is deliberate, not an inconsistency: a root-level `THEO.md` is edited by the same
  people, in the same place, as `CLAUDE.md`/`GEMINI.md` — the two other root-level files, both
  `followImports: true` — so it belongs in their category rather than `AGENTS.md`'s vendor-neutral,
  import-free one. Flagged as an open decision in the issue; resolved here because adding a new spec
  rather than reusing the existing one meant it could be decided on its own merits, with zero
  behaviour change for existing `.theokit/THEO.md` files either way.
  
  Closes usetheokit/theokit-sdk#531.

## 5.0.0-next.2

### Minor Changes

- 88e87d0: A foreign configuration source can now be admitted to some surfaces and not others.
  
  `compatSources: ["claude-code"]` was all-or-nothing: declaring it admitted `.claude/` to hooks,
  plugins, skills AND subagents at once. The four carry very different risk — a skill is text that
  enters the system prompt, a plugin is code loading, a hook is command execution — so a consumer who
  wanted to reuse the skills they had already written was handed arbitrary command execution along
  with them, and had no way to say otherwise.
  
  ```ts
  local: {
    compatSources: [{ kind: "claude-code", import: ["skills", "subagents"] }],
  }
  ```
  
  Hooks and plugins then resolve `.theokit/` alone. `CompatSurface` and `CompatSourceAdapter` are
  exported.
  
  Three rules, each failing closed:
  
  - **The bare `"claude-code"` string still admits every surface.** It is what `5.0.0-next.1`
    published, and narrowing it silently would turn a working opt-in into a no-op that says nothing —
    the defect this option exists to fix, one level up.
  - **An adapter with no `import` list admits nothing.** Safe to apply strictly because the object
    form is new and nobody can be relying on it yet.
  - **An unrecognised surface name is dropped**, exactly as an unrecognised `kind` already is. A typo
    must narrow access, never widen it.
  
  The `plugins` surface governs reading a foreign plugin directory even when the caller wants the
  SKILLS a bundle carries: a bundle is code, and its skills arrive attached to it, so admitting
  `skills` alone must not reach inside one. Otherwise the narrower permission would silently grant
  the wider one.
  
  Closes the per-surface half of usetheokit/theokit-sdk#524. The visibility half — skills, subagents
  and plugins carrying the root they came from, the way hooks already carry `sourcePath` — and the
  declarative `.theokit/config.toml` form are not in this change.
- 33aa170: A project can now declare its foreign compat sources in `.theokit/config.json`, instead of only in
  code.
  
  ```json
  {
    "compat": {
      "adapters": [{ "kind": "claude-code", "import": ["skills", "subagents"] }]
    }
  }
  ```
  
  The DECLARATIVE half usetheokit/theokit-sdk#524 asked for, in a `## Sketch` written against TOML.
  It ships as JSON: this SDK already reads JSON everywhere a project declares something
  (`settings.json`, `mcp.json`, `context.json`) and carries no TOML parser or dependency for one —
  adding one for a single optional section would be the opposite of what #522/#524 are about, reading
  in a new format nobody asked this SDK to speak. The shape is unchanged: `compat.adapters` accepts
  exactly what `local.compatSources` already does in code — a bare kind string, or `{ kind, import }`.
  
  **Precedence, decided here because the issue does not state it:** explicit `local.compatSources` in
  code wins over the file. The file is the default for a caller who declared nothing. A test or a
  one-off script can therefore always override the file without editing or deleting it.
  
  Read with `readFileSync`, not this package's usual async reader: the caller is `Agent`'s
  synchronous constructor, which resolves `compatSources` before any submanager exists to await a
  promise. `existsSync` already runs in the same constructor for the same reason.
  
  One resolver, `resolveCompatSources(options, cwd)`, replaces five call sites that each wrote
  `options.local?.compatSources ?? []` by hand — the same duplication `theokitConfigRoot` closed one
  layer down, closed here one layer up, so the file form reaches all four surfaces (hooks, skills,
  plugins, subagents) through the one place rather than needing five separate edits that could drift.
  
  Closes the declarative half of #524. `#524` itself stays open until it is verified in an installed
  release, per this project's issue-lifecycle convention.
- e7cf2dd: A skill, subagent or plugin now says which directory it was read from.
  
  usetheokit/theokit-sdk#524 asks for it in one line — *"whatever is imported should be reportable […]
  silent inheritance is what made this take a debugging session to notice"* — and a consumer listing
  its own skills could not tell that one had arrived from `.claude/skills/` rather than the project's
  own directory.
  
  What is new is not the data. It existed on all three and did not reach the caller:
  
  - `Skill.source` was already the absolute path to the `SKILL.md`, and the projection that builds
    `agent.skills` mapped it away along with the body. The projection is right to drop the BODY —
    that is what `get()` is for — and dropping the PATH with it answered a question nobody asked.
  - `agent.plugins.list()` has always returned `source` at runtime; the internal type's own docblock
    says it carries provenance "so callers can audit where the plugin came from". `SDKPluginMetadata`
    simply never declared it, so the caller received the field and the compiler denied it existed.
  - `readSubagentsFrom` computes the file path on the line it reads the file, then dropped it.
    `AgentDefinition.source` keeps it.
  
  `source` is optional on all three, and absence means something specific: declared in code, not read
  from disk. A subagent passed through `AgentOptions.subagents` has no file and `source` is absent.
  An inline `createSkill` skill has no file either, but already carried the synthetic `inline://<name>`
  marker before this change (`create-skill.ts`) — so a skill's `source` is now populated for every
  entry `list()` returns, either a disk path or that marker, and a first version of this fix wrongly
  described it as absent for that case. An existing regression test (`agent-skills-get.test.ts`,
  SE21) asserted `list()` must NOT carry `source` at all; it predates #524 and is updated here to
  assert the marker instead, while still proving the skill's body and references never leak.
  
  `SkillsHandle.list` is now typed as the public `SystemPromptSkillRef` instead of restating
  `{ name; description }` inline. The two had drifted, and an internal handle declaring a narrower
  shape than the contract it serves silently deletes fields the projection produces — which is exactly
  how `source` reached the caller at runtime while not existing to the compiler.
  
  Closes the visibility half of #524. The declarative `.theokit/config.toml` form is not in this
  change.

### Patch Changes

- 070ee92: A foreign plugin's entry file is now checked against the root it was actually discovered under.
  
  `refresh()` iterates every root a compat source admits — `.theokit/plugins`, and `.claude/plugins`
  once `compatSources` names the `plugins` surface — and checks each plugin's declared `entry` file
  exists. That check reconstructed the plugin's directory as `.theokit/plugins/<folder>`
  unconditionally, regardless of which root the plugin was actually found under.
  
  A plugin discovered at `.claude/plugins/my-plugin/` was therefore checked against
  `.theokit/plugins/my-plugin/` — a directory it never lived in. With nothing there, a legitimate
  foreign plugin was refused as "entry file is missing." Had a same-named folder existed under
  `.theokit/plugins/` instead, its entry file would have been read in place of the real one — a path
  confusion the ADR D79-D80 traversal guard this check calls does not catch, because the guard runs
  against the wrong root rather than against none.
  
  This was reachable through the bare `compatSources: ["claude-code"]` form, which has always admitted
  the `plugins` surface — not something the per-surface work landing alongside this introduced.
  
  Found while testing the per-surface admission work for usetheokit/theokit-sdk#524.
- 131ab8b: A foreign plugin's `source` field is now a real relative path instead of a single character.
  
  Both manifest loaders (Claude Code's `.claude-plugin/plugin.json` form and this SDK's own
  `PLUGIN.md`/`plugin.json`) built `source` by searching the manifest path for the literal substring
  `.theokit/` and slicing from there. A manifest read from `.claude/plugins/<name>/…` contains no such
  substring: `indexOf` returns `-1`, and `.slice(-1)` silently returned the manifest path's LAST
  CHARACTER — `"n"` from `.json`, `"d"` from `PLUGIN.md` — instead of a path.
  
  `source` is exactly the audit trail the visibility half of usetheokit/theokit-sdk#524 exists to
  provide, and this was broken for precisely the case that matters most: a plugin admitted from a
  foreign root. Replaced the substring search with `path.relative(cwd, manifestPath)` — the stdlib
  does this correctly, and it is what the substring search was trying to approximate.
  
  Found alongside the entry-file root confusion, testing the same per-surface admission work.
- 7b4063b: One resolver now answers "where does this project's configuration live?" — `theokitConfigRoot(cwd)`,
  in `internal/persistence/paths.ts`, semver-exempt.
  
  Five readers hand-rolled `join(cwd, ".theokit", ...)` independently: `mcp.json`, the context
  directory + `context.json`, the hooks-root fallback check, `registry.json`, and the personality
  `PROJECT_SUBDIR`. `projectConfigRoots` (hooks/skills/subagents/plugins, per usetheokit/theokit-sdk#524)
  already resolved its native root the same way, inline, making six independent copies of one
  constant.
  
  No filename, format or resulting path changes — this is a pure consolidation, and the project's own
  lint gate (`no-hardcoded-theokit-path.test.ts`, ratcheted 23 → 14) is the proof: every literal this
  change removed was already flagged as migration debt, and the full suite is unchanged.
  
  Deliberately does NOT touch homedir-anchored state (sessions, credentials, the personality
  `USER_SUBDIR`, provider discovery) — those follow `getTheokitHome`/`THEOKIT_HOME` by design, and
  folding them into this resolver would be the exact silent behaviour change
  `theokitConfigRoot`'s own docblock warns against: a project's committed configuration must never
  follow an operator's relocated state directory. A regression test pins this — swapping the
  resolver's body for `getTheokitHome`'s would move all six readers under `THEOKIT_HOME` at once, in
  one line, with no caller-side signal.

## 5.0.0-next.1

### Major Changes

- 667bd3d: **BREAKING:** a project's `.claude/` directory is no longer read unless the consumer declares it.
  Pass `local: { compatSources: ["claude-code"] }` to restore today's behaviour.
  
  Four subsystems — hooks, skills, subagents and plugin bundles — resolved `<cwd>/.claude` alongside
  `<cwd>/.theokit` with no opt-in anywhere. A directory containing only `.claude/`, and no
  configuration of this SDK at all, had its hooks executed, its subagents registered, and its skill
  text folded into the system prompt.
  
  **Trust is not consent.** A consumer's trust gate answers "do I trust the code in this directory?",
  and it was doing double duty as the answer to a different question: "do I want another product's
  configuration imported into this one?" Those come apart in the ordinary case — `.claude/` is
  populated in exactly the repository one trusts most, for a different tool, under a different
  contract, often by a teammate who never heard of this SDK. The measured cost of conflating them was
  the defect fixed one commit earlier: every turn denied by a `PreToolUse` hook nobody had declared.
  
  The skills path is the quieter half. A skill's text enters the system prompt, so importing prompt
  content from a directory this SDK does not own is a prompt-injection surface that no consumer opted
  into and none could see.
  
  A workspace holding an undeclared `.claude/` now says so once, on the diagnostics channel, naming
  the directory and the line that turns it back on. It goes there rather than to stderr because
  ignoring an undeclared directory is the intended behaviour, not a failure — every repository that
  has Claude Code set up and does *not* want it imported would otherwise pay a line on a TUI host's
  render surface for behaving as instructed.
  
  An unrecognised name in `compatSources` is dropped rather than turned into `<cwd>/<name>`: a typo
  must fail closed, since a directory name was never enough to describe a dialect.

### Minor Changes

- edfa59c: `Agent` can now be asked which operations it supports, instead of being told by an exception.
  
  `SDKAgent` is one handle over two runtimes that do not offer the same operations, and the type did
  not model the difference. `downloadArtifact` is a **required** member that rejects for every input on
  a local agent; `listArtifacts` is required and returns `[]` for every state, so "no artifacts" and
  "this runtime has no artifacts" were the same value. On a cloud agent, five members declared
  _optional_ are present-but-throwing — so `typeof agent.fork === "function"` is `true` and calling it
  throws. Neither requiredness nor optionality expresses "exists here, not there", which left a caller
  no way to branch except a `try`/`catch` around a call it did not want to make.
  
  Two additive members answer the question first, mirroring `Run.supports(op)` /
  `Run.unsupportedReason(op)`, which already solved this one layer down:
  
  ```ts
  if (agent.supports("downloadArtifact")) {
    await agent.downloadArtifact(id);
  } else {
    logger.info(agent.unsupportedReason("downloadArtifact"));
  }
  ```
  
  The new `AgentOperation` union is exported. Nothing was removed and no signature changed, so a
  caller that never asks behaves exactly as before.
  
  This is a mitigation. The structural fix is to split `SDKAgent` into a common core plus
  `LocalCapableAgent` / `CloudCapableAgent`, so the compiler refuses the call rather than the runtime.
  That is breaking on a published 4.x surface and is deliberately not done here.
- 912e3b9: Three silent downgrades now tell you they happened. Behaviour is unchanged; visibility is not.
  
  **A failing `MemoryProvider` no longer disappears quietly.** `initLoopContext` caught every provider
  failure into an empty value: an `init` failure meant no memory tool was registered, a `buildTools`
  failure meant no provider tools, an `activePass` failure meant no recalled context in the system
  prompt. The agent answered without the memory it was configured with, and nothing recorded it. There
  is now a `memory_degraded` run event — new `RunMemoryDegradedEvent`, carrying the stage and the
  provider's own message — alongside a stderr diagnostic, so a host can show "memory degraded" instead
  of a healthy run. Degrading to a working agent is still what happens.
  
  **The memory FTS fallback is gated on the case it was written for.** Any SQL failure used to become a
  `LIKE '%query%'` scan over the whole table, returning plausible hits at a fixed score — so a corrupt
  database, a missing FTS table and a disk error all looked like a successful search with worse
  relevance. The fallback still runs, and a non-CJK failure now reports that the index may be missing
  or corrupt.
  
  **A `@theokit/sdk-memory` peer that fails to load says so.** Absent is expected and stays silent;
  present-but-unloadable — a module-format interop failure, a broken native dependency, a bundler
  rewrite — is reported instead of falling back to the legacy path in silence.
- 16a996f: Every error this SDK throws is now catchable as `TheokitAgentError`.
  
  The README tells you to catch `TheokitAgentError`, and twenty-four exported error classes were not
  one — they extended bare `Error`, so that catch silently missed them and none of them told you
  whether the failure was worth retrying. Among them: `GenerateObjectError`, `StreamObjectError`,
  `FileNotFoundError` and its four siblings, `SandboxSecurityError`, `SandboxNotAvailableError`, the
  three `Auth*Error`s, `A2ARequestTimeoutError`, `MaxDelegationDepthError`, `WorkflowToolError`, and the
  two errors on the `./interactive` subpath.
  
  All twenty-four now extend `TheokitAgentError`, carry a `code`, and answer `isRetryable`. The answer
  was decided per class rather than defaulted, and the reasoning is in the source. Two are retryable —
  `A2ARequestTimeoutError` (a peer that missed one deadline may answer the next) and
  `CompressionFailedError` (a single LLM call that failed or came back empty) — plus `FilesystemError`,
  where the underlying I/O failure genuinely can be transient. The rest are not, and say why.
  
  This is additive: `instanceof Error` still holds, every `code` value is unchanged, and no signature
  moved. Code that already caught these by their specific class keeps working.
  
  `generateObject` and `streamObject` also stop declaring the same failure contract twice with
  byte-identical messages. They share one internal base class and keep their two distinct public names,
  so `streamObjectError instanceof GenerateObjectError` remains false.
- 374dd5f: The `MemoryProvider` port is now the only memory path. `THEOKIT_PORT_MEMORY_PATH`
  is gone, and the adapter over the built-in memory runs by default; a
  consumer-supplied `memoryProvider` still takes precedence.
  
  No typed API was removed — the flag was internal and never appeared in your
  TypeScript types — but three behaviours change:
  
  - **Recalled memory is now escaped before it reaches the model.** The port path
    concatenated the recall summary into the system prompt raw, while the assembly
    pipeline has always wrapped it as `<active-memory>` with XML escaping. A recalled
    fact containing `</active-memory>` could close the block early and have everything
    after it read as a system instruction. Both paths now wrap and escape.
  - **Memory tools receive the run's abort signal and transcript projection.** They
    arrive through the same channel as your own tools, so a long memory search is now
    cancellable with the run.
  - **`.theokit/memory` is no longer created by a send that never reaches the agent
    loop** — a fixture-mode send with a `theo_test_*` key used to leave an empty
    SQLite index behind. Real runs are unchanged: the index is created and searchable
    exactly as before.
- 374dd5f: `MemoryProvider.buildTools(handle, agent)` now declares its second parameter as
  `MemoryProviderAgentRef` — `{ agentId, model }` — which is all the SDK has ever
  passed it.
  
  It declared `SDKAgent`, a 33-member interface, and satisfied that with a cast over
  a two-field object. Any implementation reaching for one of the other 31 members —
  `send()`, `fork()`, `dispose()` — got `undefined is not a function` at runtime, with
  no compile-time warning, because the cast removed exactly that check.
  
  Non-breaking in both directions: an `SDKAgent` still satisfies the new type, and an
  existing implementation typed `agent: SDKAgent` still compiles. `MemoryProviderAgentRef`
  is exported from the package root so you can name it.
- 618cd02: `ctx.on(...)` now returns a disposer, so a plugin can detach one hook.
  
  It returned `void`, which made the plugin Observer a one-way door: a handler attached through
  `initialize()` had no removal path and ran for the life of the process. The only documented dynamic
  case — a permission plugin re-installed on every prompt — worked because the registry keys plugins by
  name, so re-registering the whole plugin was the only way to remove one hook.
  
  ```ts
  const off = ctx.on("pre_tool_call", handler);
  // ...later
  off();
  ```
  
  The disposer detaches the registration it was given — attaching the same function twice and disposing
  once leaves one — and is idempotent. A handler the SDK refused (a non-function, which is warned and
  ignored) still returns a working no-op disposer, so a caller never has to branch on whether the
  registration took.
  
  Two observers in the SDK already worked this way (`Run.onDidChangeStatus`, `MessageBus.unregister`);
  this closes the gap. The new `PluginHookDisposer` type is exported.
- 31fea8f: `Retry.run(fn, options)` is the new name for `Retry.create(fn, options)`.
  
  `create` never created anything — it runs `fn` with retry and resolves to `fn`'s
  result — and the name said otherwise. It is deprecated, still honoured, and
  removed in the next major.
- 691d8e6: `SandboxBackend`'s derived `glob`, `grep` and `listDir` now throw when the command could not run.
  
  They returned `[]` on any non-zero exit, so a search that could not execute reported the same thing as
  a search that found nothing — opposite facts, one normal and one meaning the agent is looking at a
  filesystem it cannot read. That is the failure a backend whose `execute` is not a POSIX shell hits,
  which the class docblock warns about in prose and could not enforce.
  
  A genuine no-match still returns `[]`, and the distinction is the one the tools themselves draw:
  `grep` exits 1 for no match and ≥2 for an error, `find` exits 0 with empty output.
  
  If you have a custom backend that is not a POSIX shell and relied on these silently returning nothing,
  they now throw a `ConfigurationError` with code `sandbox_derived_helper_failed`, telling you to
  override them — which the docblock already asked for.
- 0ceeddc: `sanitizeToolInput` now reaches values inside arrays.
  
  It never did. `{ tag: "  a  " }` came back trimmed and `{ tags: ["  a  "] }` came back untouched, with
  nothing in the type or the documentation distinguishing them — the `@public` docblock on `deep` said
  "recurse into nested objects/arrays", and array elements were not reached by any rung, including
  `trim`, which is on by default.
  
  Elements follow the same rules as fields: a string element is sanitized by whichever rungs are on, an
  object element is descended only under `deep`. Array descent itself is not gated by `deep`, because a
  value does not stop being a string by sitting in a list; `maxDepth` counts every hop and is what
  bounds it. Arrays stay arrays.
  
  If you were relying on array contents passing through a sanitizer untouched, they no longer do.
- 558dd30: `SessionStore` declares the three lifecycle hooks the SDK was already calling.
  
  The port declared two methods, and the SDK probed for `acquire`, `release` and `dispose` through
  `as unknown` casts. They worked — but nothing in the interface mentioned them, so a store author
  implementing the documented two-method contract got no writer lease, no release and no disposal, with
  no way to discover that those hooks existed.
  
  They are now optional members with their contracts written down, including the one that matters:
  a rejection from `acquire` whose `name` is `SessionBusyError` **propagates to the caller**, because
  another process holding the session is a decision the caller has to make. Every other rejection is
  treated as "no lease here" and the turn proceeds.
  
  Optional means optional: an existing two-method store keeps working unchanged. What changes is that
  the capability is now readable in the type you implement.
- 94722e8: `StructuredOutputError` distinguishes the causes it already knew apart.
  
  Three different failures reported `no_tool_call`: an agent run that errored
  before producing an answer, a run that was cancelled, and a tool-only completion
  with no text to structure. Only the free-text message differed, so a caller could
  not branch on which had happened without parsing English.
  
  They are now `upstream_run_failed`, `run_cancelled` and `no_text_answer`.
  `no_tool_call` keeps its original meaning — the model did not call the forced
  output tool — and `parse_failed` is unchanged.
  
  BEHAVIOUR CHANGE for a caller matching `no_tool_call`: three of the five cases it
  used to catch now carry their own code. A caller that branched on it for a
  cancelled run was branching on a defect, but the string it matched does change.
  
  The union is exported as `StructuredOutputErrorCode`.
- 266ffc8: Nine failures that used to arrive as a bare `Error` now carry a type and a code.
  
  `docs/error-codes.md` says to branch on `code`, never on the message — messages carry context and
  change with it. These nine gave you no code to branch on:
  
  - `MessageBus.send` / `request` against an unregistered peer now reject with the new
    `A2APeerNotRegisteredError` (`a2a_peer_not_registered`), carrying `to`. The timeout branch of those
    same two methods was typed under #380; this was the branch above it.
  - The ChatGPT provider's missing-credential path now throws `AuthenticationError`
    (`missing_credential`), matching the router path that handles the same condition.
  - `createSkill`, `createTokenLimiter`, `defineSkillReadTool`, the two `Workflow` builder guards, and
    `Security.addPattern` now throw `ConfigurationError` with a code each.
  
  Because `isTransientError` is `err instanceof TheokitAgentError && err.isRetryable`, a bare `Error`
  was also permanently invisible to retry logic. These now answer the question.

### Patch Changes

- 667bd3d: A hook or lifecycle command that exits without reading its stdin no longer raises an uncaught
  `EPIPE` in the SDK's own process.
  
  `spawnAndCollect` writes the JSON payload to the child's stdin. A child that never reads it —
  `exit 1`, a hook that only inspects the environment, any command that ignores the payload — closes
  the pipe first, and the write then raises `EPIPE` on a stream with no `error` listener, which Node
  promotes to an uncaught exception. The child was behaving perfectly legitimately; the host process
  took the fault.
  
  The error is swallowed rather than surfaced: the child's exit code and stderr are the result, and
  both are collected either way. A payload nobody read is not a failure of the spawn.
- 4415f83: An unrecognised key under `local` is now reported on the diagnostics channel instead of being
  accepted in silence.
  
  Measured before this: `Agent.create({ local: { compatSourcess: [...] } })` — one letter wrong —
  created the agent with no throw, no warning, and nothing anywhere. That made two very different
  failures identical: a typo and an SDK too old to know the option both produced the default
  behaviour and no complaint.
  
  It is the reason `usetheokit/theokit#634` is blocked rather than merely unimplemented — a forward
  of `compatSources` written against a published SDK would be inert, and no consumer could tell.
  The same shape produced the `$CLAUDE_PROJECT_DIR` defect and motivated the `compatSources` opt-in:
  a surface that accepts input and does nothing with it, where the absence of a complaint reads as
  acceptance.
  
  The message names the key and the nearest known one, so one letter wrong is one line to read
  rather than a trip to the documentation. It is a warning, never a refusal: rejecting an unknown key
  would break every consumer passing a forward-compatible extra — the ordinary way to write code that
  runs against two SDK versions — and turn a diagnostic problem into an outage. A correct
  configuration emits nothing, and there is a test for that, because a warning that fires on valid
  input stops being read.
- 9181434: A failed atomic write no longer leaves its temp file behind.
  
  `replaceFileAtomic` — which backs the agent registry, session transcripts, MCP token storage and
  everything else the SDK persists — cleaned up its `.tmp` on a rename failure and on no other. A
  failure between the open and the rename, meaning a write error, a full disk, or an fsync failure,
  closed the file handle and propagated with the temp still on disk.
  
  Every failure after the open now removes it. A process killed mid-write still leaves one, which no
  code inside that process can prevent; `sweepStaleAtomicTemps` reaps those on the next registry load.
- edfa59c: `Agent.batch(prompts, { task })` now rejects when the batch task fails, instead of resolving with an
  empty array.
  
  The task-wrapped path assigned its results inside the task's `work` callback and then returned that
  variable unconditionally, so three different failures produced one indistinguishable value: the work
  threw, the task was cancelled, or a fixed 5000-iteration poll budget elapsed. Each returned `[]` on
  a **resolved** promise — which a caller cannot tell apart from `Agent.batch([])` on empty input.
  Nothing threw and nothing was logged, and the registry's own `{ code, message }` for the failure was
  discarded by a loop that read only the task's `state`.
  
  The poll is gone. The wait is now the task's terminal event, which carries the failure detail:
  
  - work threw → rejects with `code: "batch_task_failed"`, the registry's code on `protoErrorCode`
  - cancelled → rejects with `code: "batch_task_cancelled"` and the reason, when one was given
  
  The removed budget was not a safety net: 5000 iterations of a 5 ms sleep is roughly 25 seconds, so a
  batch legitimately longer than that would trip it and return `[]`. The bound generated the failure
  it appeared to guard against.
  
  If you were checking `results.length === 0` to detect a failed batch, catch the rejection instead —
  an empty array now means only what it says.
- edfa59c: Corrected the published JSDoc for `AgentOptions.budgetTracker` and `AgentOptions.memoryProvider`,
  which told consumers the opposite of what the SDK does.
  
  Both carried a paragraph stating the option was "wired to the type surface only" and that a consumer
  supplying one "gets the type guarantee but NOT runtime enforcement". Neither has been true for some
  time. `budgetTracker` is read by the agent loop before every iteration (`evaluateBudgetGate`),
  advanced with `nextIteration()`, and charged with `track(...)` after each completion.
  `memoryProvider` has its full lifecycle driven — `init`, `buildTools`, `runActivePass`, `sync`,
  `dispose`.
  
  No behaviour changes here; the code was already correct. What changes is what the published `.d.ts`
  tells you, and it was wrong in the expensive direction: a consumer reading it was told the SDK would
  not enforce their cost ceiling, so the rational response was to build a second control outside the
  SDK, or to stop passing the option at all.
  
  Six occurrences of the claim were corrected across `types/agent.ts`, `index.ts` and the loop's own
  input types, and a lint now requires any "not implemented yet" note to carry a tracking reference and
  a date, so the next one expires instead of outliving the work it describes.
- 4be7411: `Budget.create` now refuses `scope: "agent"` and `scope: "call"` with a
  `ConfigurationError` (`unimplemented_budget_scope`).
  
  Only `"process"` was ever implemented. Nothing outside the registry read `scope`,
  so the other two were accepted and silently ignored: a caller asking for
  per-agent accounting got process-wide accounting with no signal. A cost control
  that reports the wrong number is worse than a missing feature.
  
  `FnStep.compensate` is marked deprecated. It was never implemented — setting it
  arms `WorkflowCompensateNotImplementedError`, so the step fails at run time.
  
  `AgentLoopInputs` declares `maxConsecutiveToolErrors` and `maxConcurrentTools`,
  which were read through inline casts and appeared in no type. A typo in either
  name now fails to compile instead of silently taking the default.
- 24fb692: `Cron.create()` now reports when the job will actually next fire.
  
  It reported `now + 1 hour` for every expression. The function behind it read neither the cron
  expression nor the timezone — a `@yearly` job said it would run within the hour, and so did a
  `*/5 * * * *` one. Its own docstring scoped it to fixture mode ("real scheduling uses a proper
  evaluator wired in by the local scheduler"), and its only caller was `Cron.create()`.
  
  The local scheduler overwrote the value for jobs it picked up, which is why this survived: the wrong
  number was visible between creating a job and the scheduler reaching it, and permanently for a job
  the scheduler never runs — a job created against a cloud runtime, or created while the scheduler is
  stopped.
  
  `nextRunAt` is now computed with croner, which was already a dependency and already doing exactly
  this inside the scheduler. When an expression has no next run — `0 0 30 2 *`, a date that never
  occurs — the field is absent rather than filled with a number, which is what the optional
  `CronJob.nextRunAt` already meant.
- edfa59c: Two abstractions with no implementers and no consumers are gone. Nothing published changes.
  
  `internal/security/secret-redactor.ts` declared a `SecretRedactor` interface that `redactSecrets`
  happened to satisfy. It was added to raise the module's abstractness out of a coupling metric's "zone
  of pain", and nothing ever held it — no implementer, no consumer, absent from every barrel. An
  interface nobody holds does not change what any module depends on, so the number it was added to move
  could not have moved either. Its README section now records that, and keeps the reasoning that
  rejects chasing the metric in the first place.
  
  `server/adapter/express.ts`, `fastify.ts` and `hono.ts` were byte-identical below their docblocks:
  two imports and a one-line delegation each, with no framework type imported or adapted anywhere. They
  are replaced by a single `server/adapter/index.ts` whose docblock says what the function actually
  returns — a route descriptor the host binds itself, not middleware. The three per-framework docblocks
  claimed an adaptation that did not exist, which is the half of this that could mislead a reader.
  
  Their three test files, which had quietly drifted into three different levels of coverage, are one
  file carrying the union of their cases plus one new case asserting the descriptor contract directly.
- 374dd5f: Embedding requests now retry with the same jittered exponential backoff the rest of
  the SDK uses, and honour the provider's `Retry-After` header.
  
  They used to back off linearly at `50ms * attempt` and ignore `Retry-After`, so two
  clients hitting a rate-limited embedding endpoint retried in lockstep and neither
  waited as long as the provider asked. The delay is tuned tighter than the LLM
  transport's — 250ms base, 4s cap rather than 500ms/32s — because an embedding retry
  sits inside a memory write on the run's critical path.
- 63617cd: Hooks imported from `.claude/settings.json` now run with `$CLAUDE_PROJECT_DIR` defined, so a
  repository that also uses Claude Code stops denying every turn.
  
  Reading that file is a deliberate compatibility decision, but the commands inside it are written for
  Claude Code's runtime, which defines that variable and whose documentation tells hook authors to
  reach project files through it. This SDK did not define it, so `sh` expanded it to the empty string
  and `bash "$CLAUDE_PROJECT_DIR/.claude/hooks/guard.sh"` ran as `bash "/.claude/hooks/guard.sh"` — a
  file that does not exist, which a hook runner correctly reads as a refusal. The result was every
  tool call denied, in any repository whose only unusual property was having Claude Code set up, with
  a message naming a script that was present and executable all along.
  
  A denial caused by an undefined variable now names the variable. `$CLAUDE_PLUGIN_ROOT` and the rest
  of that runtime's surface are still not supplied — inventing a value would send a script somewhere
  real and wrong — but a hook that needs one fails saying which, instead of reporting a path that
  failed ten characters later.
- edfa59c: HTTP 408 is now classified as a retryable timeout instead of a configuration error.
  
  `mapHttpStatusToError` in `internal/http.ts` had no arm for 408, so a Request Timeout fell through
  to the generic `4xx` branch and came back as a `ConfigurationError` — `isRetryable: false`. Every
  one of the four provider-specific mappers already did the opposite: `openai-compatible`, `anthropic`,
  `bedrock` and `vertex` all map 408 to a `NetworkError` carrying a `timeout` code, which is retryable.
  The generic ladder is a fifth copy of the same knowledge and it was the copy that drifted.
  
  The failure was silent and pointed the wrong way. Nothing threw: a caller branching on
  `isTransientError` simply refused to retry a request that would very likely have succeeded, and did
  so only on the paths that went through the generic mapper rather than a provider one.
  
  If you were catching `ConfigurationError` to handle 408 specifically, catch `NetworkError` instead —
  or branch on `code`, which is what `docs/error-codes.md` asks for.
- edfa59c: The HTTP status ladder now has one definition instead of four, and two drifted copies are repaired.
  
  `401/403 → auth_failed`, `402 → quota_exceeded`, `408 → timeout`, `429 → rate_limit`,
  `400 → invalid_request`, `5xx → server_error` is RFC 9110 semantics, not a vendor contract: a 429
  means the same thing whichever provider sent it. It was nevertheless written out in all four
  provider mappers, and the copies had already diverged in two ways that reached users:
  
  - **HTTP 402 reached one mapper of four.** `quota_exceeded` was wired into the OpenAI-compatible
    mapper only, so a Bedrock, Vertex or Anthropic endpoint answering 402 fell through every arm and
    surfaced as `unknown`. The canonical bucket existed and three of four mappers could not reach it.
  - **The server arm had two different upper bounds.** Anthropic and OpenAI-compatible guarded
    `>= 500 && < 600`; Bedrock and Vertex guarded `>= 500` with no ceiling, so a malformed or
    proxy-injected 6xx was `server_error` in two mappers and `unknown` in the other two.
  
  The ladder now lives once, in `internal/error-mappers/shared.ts`, beside the other dialect-agnostic
  helpers. Each mapper keeps its own body dialect — Anthropic's `context_too_long`, OpenAI's
  `insufficient_quota`, Bedrock's AWS `__type` strings and 404 rule, Vertex's `google.rpc` enum with
  its finer `unauthenticated`/`permission` split — because those *are* per-vendor contracts. The
  shape is now `classifyVendorBody(body) ?? httpStatusToErrorCode(status)`.
  
  Visible changes: 402 now yields `quota_exceeded` (was `unknown`) on Anthropic, Bedrock and Vertex,
  and a status of 600 or above now yields `unknown` (was `server_error`) on Bedrock and Vertex. HTTP
  404 is deliberately unchanged everywhere.
- 926cb81: Removed `LanceMemoryAdapter.unwrap()`, which handed callers the raw `LanceIndex`
  behind the adapter. It had no callers anywhere in the monorepo — including the
  migration tool and benchmark script its own docblock named, both of which open a
  `LanceIndex` directly and never go through the adapter.
  
  A caller that needs `addFacts` / `countFacts` / `removeFacts` needs a
  `LanceIndex`, and opening one is the honest way to get it.
- 7f91326: The Lance memory backend now honours `SearchOptions.vectorWeight` and
  `textWeight`. It blended hits with hard-coded 0.7 / 0.3 literals and never read
  the options, so a caller that tuned the weights had its tuning applied on the
  SQLite backend and silently dropped on Lance.
  
  Unweighted Lance results shift slightly as a consequence: the shared defaults are
  0.6 / 0.4, and one of the two hard-coded numbers was never the contract's.
  
  Workflow step logging (`ctx.log.debug` / `.info` / `.warn`) now goes through the
  SDK's diagnostics channel instead of `console`, so a host that installs a
  diagnostics sink — a TUI, for instance — receives it instead of having its frame
  written over.
- edfa59c: Two internal modules moved to the layer they belong to. No public API changed.
  
  `src/errors.ts` is the package's leaf — fifteen files under `internal/runtime/` import the typed
  error hierarchy from it — and it imported back up into `internal/runtime/retry/` for one helper. The
  helper encodes which error codes are retriable, which is a property of the error taxonomy rather
  than of the retry runtime, so it now lives in `internal/error-mappers/` beside the other mapping
  knowledge. One import path changed; the file itself was moved, not rewritten.
  
  `internal/security/` is the most-depended-upon module in the tree and held node builtins and
  `errors.js` and one exception: a path-containment primitive it reached for in
  `internal/runtime/context/`. That primitive had four consumers and only two were in the folder it
  sat in — it lived there because that is where it was extracted from, not because it belonged there.
  It is now `internal/security/path-containment.ts`, and all four consumers import downward into
  `security/`, the direction the rest of the tree already runs.
- 243bd2c: The live-agent registry and the session cache survive a package loaded twice.
  
  `liveAgentRegistry` and the session cache's two maps were plain module-level `const`s, which are
  singletons per module INSTANCE. A package can be loaded more than once in one process — two copies in
  `node_modules`, ESM and CJS side by side, a monorepo with distinct versions — and each copy then gets
  its own registry. For the live-agent registry, the public one, that means two views of which agents
  are running, and a caller reading the wrong one sees none.
  
  All three now go through the same `Symbol.for`-keyed helper the rest of the SDK uses.
  
  The session cache's docblock asserted that the instances "remain the only ones in the process, because
  an ES module is a singleton". That is the claim the helper exists to refute; the docblock now says so.
- edfa59c: `LiveSessionError` from `@theokit/sdk/persistence` is renamed to `LiveTranscriptError`. The old name
  still works and is deprecated.
  
  Two different classes were called `LiveSessionError`, exported from two declared subpaths that one
  consumer can hold at once. They have incompatible shapes: the root barrel's is
  `new LiveSessionError(sessionId, reason)` with a `reason` field and no `code`; the persistence one
  was `new LiveSessionError(path)` with a `path` field and `code: "live_session_protected"`.
  
  The failure was quiet in the way that costs most. `instanceof` is class identity, so a `catch`
  checking the class imported from the root silently did not match the one thrown from persistence, and
  the fallback ran for a condition the code believed it had handled. A `name` check looked like it
  worked — `err.name === "LiveSessionError"` matched *both* — and then read `err.reason`, which only
  one of them has.
  
  The names now say what each refusal is about: refusing to destroy a **session**, and refusing to
  overwrite a **transcript** file. `LiveSessionError` remains exported from `@theokit/sdk/persistence`
  as a deprecated alias so existing imports keep working; it will be removed in the next major.
- ba6549f: An MCP client with a tight `requestTimeoutMs` can reconnect after a drop.
  
  `reconnect()` recovers by spawning a fresh child and running the `initialize` handshake, and that
  handshake was bounded by the same `requestTimeoutMs` the caller set for ordinary requests. Setting a
  tight request budget — an ordinary thing to do for a latency SLO — silently made a client unable to
  recover: every reconnect attempt spawned a process that could not finish inside a steady-state budget,
  the bounded loop exhausted, and the client surfaced `mcp_disconnected`. That is the wedge the bounded
  loop exists to prevent.
  
  The reconnect handshake now takes `max(requestTimeoutMs, 10s)`.
  
  The **first** connect is unchanged and keeps your budget exactly. The difference is which failure is
  visible: a `requestTimeoutMs` too small to connect at all fails at the call you made, immediately, and
  is yours to correct. The reconnect is the SDK's own recovery, which you never sized and never see
  until a drop happens.
- edfa59c: `MemoryIndex.sync()` and `.status()` now say whether their numbers were measured.
  
  `MemoryIndex` has two implementations. `IndexManager` walks a markdown corpus and counts rows with
  `SELECT COUNT(*)`. The Lance backend has no corpus — it is a vector store fed by explicit writes —
  and it answered with a frozen all-zeros `SyncResult` and a hardcoded `filesIndexed: 0,
  chunksIndexed: 0`. Those are indistinguishable from a real sync that found nothing to do and a real
  index that is empty, and the comment above them stated that as the goal: *"Returns zero counts so
  callers' existing logging does not break."*
  
  The consequence was a false negative rather than a crash. A caller deciding "is the index
  populated?" from `chunksIndexed > 0` got `false` on every Lance run, however many rows the table
  held.
  
  Two required fields make the difference visible:
  
  - `SyncResult.supported` — `true` from `IndexManager`, `false` from Lance
  - `IndexStatus.countsExact` — `true` when counted, `false` when the number is a placeholder
  
  The counts stay zero. Inventing a number would have traded one false claim for another; what changed
  is that a caller can no longer read a placeholder as a measurement. Both fields are also on the
  public `MemoryIndexHandle`, so a consumer holding the handle can see them. If you need the real Lance
  count, `unwrap().countFacts()` still returns it.
- 21be5cb: `migrateSqliteToLance` now rejects a `batchSize` its loop cannot advance with,
  before touching the workspace.
  
  A `0` or a negative made the migration spin forever, calling `addFacts([])` and
  logging a progress line every iteration. `NaN` — which `Number("abc")` produces —
  made it migrate nothing and report "Validation FAILED. SQLite preserved.",
  blaming the migration for a typo. Both now raise a `ConfigurationError` with code
  `invalid_batch_size`, naming the value received.
- edfa59c: A dropped connection to Ollama is now retried instead of surfacing on the first attempt.
  
  `OllamaNativeClient` rethrew the raw `fetch` rejection when its own body-dialect mapper did not
  recognise the failure, and threw a bare `new Error` for any HTTP status the dialect did not cover.
  Both land outside the SDK error hierarchy, and that decides retry behaviour by contract rather than
  by chance: `isTransientError` is `err instanceof TheokitAgentError && err.isRetryable === true`, and
  the router wraps every resolved client in `RetryingLlmClient`. A foreign error is therefore
  non-transient by definition — so the most ordinary failure a local Ollama can produce, a dropped
  connection, was never retried.
  
  The repository had already found and fixed this for the other transports; `openai.ts` records the
  measurement and names Ollama as the one still carrying it. Transport failures now go through
  `wrapTransportError` (which passes `AbortError` and any already-mapped SDK error through untouched,
  so nothing gets relabelled), and unrecognised statuses go through the shared HTTP status ladder
  rather than a bare `Error`.
  
  Visible change: these two paths now reject with `NetworkError` (`code: "transport_failure"`) and a
  typed error carrying the status, instead of a `TypeError` and an `Error`. A caller branching on
  `instanceof Error` is unaffected; a caller branching on `isTransientError` starts getting retries.
- 5d174f2: Three pieces of duplicated logic now have one owner each. One internal error message improves.
  
  The `~4 chars per token` estimate had two `@public` implementations reachable from two entry points —
  `built-in-processors.ts` with a named constant, `compaction.ts` with the ratio inlined. Tuning it, or
  switching to code points instead of UTF-16 units (a caveat both docblocks already carried), would have
  silently diverged them. It lives in `compaction.ts` now, with `CHARS_PER_TOKEN` exported beside it;
  `built-in-processors.ts` re-exports both under the same names, so nothing published changes.
  
  The error-body reader duplicated character-for-character in the Bedrock and Vertex mappers is one
  `parseErrorBody` in their shared module. It describes how `fetch` surfaces a body, which is the same
  whoever sent it.
  
  `abortError` had three copies — including inside the two files the extraction's own docblock named as
  the ones that should stop having one. **One of the three behaved differently**: the pool-aware client
  discarded a non-`Error` abort reason and raised a generic `"AbortError"`. All three are now the shared
  implementation, which carries the caller's reason through. If you cancel with
  `controller.abort("shutting down")` and the pool-aware client is in the path, the rejection message is
  now `shutting down` rather than `AbortError`.
- 0c4df84: The `PermissionRule` documentation described a bug that was fixed, and told you to work around it.
  
  The public docblock warned that a predicate matcher is invoked with `undefined` when the call omitted
  the argument — so an allow-rule written to narrow would authorize an argument-less call, and a
  deny-rule would throw a `TypeError` out of the permission gate. It closed by telling you to guard the
  parameter in every predicate you write.
  
  None of that has been true since `argMatches` started checking for a missing argument first, for
  every matcher form. **A rule that declares an argument the call did not supply does not match, and
  the predicate is not invoked.** You do not need the hand-written guards.
  
  The fixed behaviour also had no test — deleting the guard left the entire suite green — so three
  cases now cover it, including the two the old docblock described.
- edfa59c: The Responses-API transport's SSE state machine is a class, and the eight event kinds it handles are
  now covered by tests.
  
  `ResponsesApiClient.stream` inlined the whole dispatch: one 165-line generator, ten mutable locals
  and eight `else if` arms, carrying a suppression that described it as "mirroring
  `OpenAIStreamAccumulator.consume`". It mirrored what that method does, not how it is organised —
  `consume` is seven lines delegating to small private methods. The state machine now lives in a
  `ResponsesStreamAccumulator` shaped like its sibling, the suppression is gone, and every function in
  the file is under the complexity threshold the project sets for itself.
  
  The refactor is behaviour-preserving, and that claim was measured rather than asserted. Each arm of
  the dispatch was mutated in turn before the change: three of eight killed a test, five did not — the
  reasoning deltas, the incremental tool-argument accumulation, `response.incomplete` → `max_tokens`,
  the reasoning/cache token counters, and the in-stream failure path. Notably, a comment in the
  existing suite claimed the argument deltas were exercised "because the parsed input below can only
  be right if they were accumulated"; deleting the accumulation left that suite green, because the
  recorded fixture repeats the full arguments on the terminal event.
  
  Eight characterisation tests close those gaps, and re-running the battery after the extraction kills
  all eleven mutants. Two behaviours documented for the first time by that battery: the tool name is
  taken from the frame that announced the call when the completion frame omits it, and frames sent
  after `[DONE]` are ignored.
  
  No public API changed.
- d1182ae: A resumed session now replays its history as structured tool calls instead of flat text, so the
  model stops learning to type `[tool call] <name>` as prose.
  
  Hydration has always produced two projections of each stored turn: `text`, in which a tool call
  folds to the marker `[tool call] NAME`, and structured `parts`, which carries the call id, the tool
  name and the arguments. The replay read `text` alone. So a resumed session showed the model its own
  prior turn as prose containing the marker, and the model did the reasonable thing with a pattern it
  is shown — it wrote the marker instead of calling the tool. Downstream that surfaced as an assistant
  message ending `"…report its output.[tool call] run_shell"` with no tool call behind it: the tool
  did not run, nothing errored, and the transcript read as the model narrating an action it never took.
  
  A turn with no `parts` replays exactly as before, so sessions stored by an older SDK keep the
  behaviour they were written under. Tool results replay as a user message, which is the convention
  the live loop already uses.
  
  **An already-affected session recovers on its next turn.** No need to start a new one or delete
  anything: the stored `parts` were always correct — only the `text` projection carried the marker —
  so reading structure instead of prose heals a contaminated transcript rather than merely stopping
  new contamination. Verified against a session that had accumulated seven occurrences of the marker.
- 1499923: `@theokit/sdk/sandbox` marks `resetInteractiveWarnLatch` and `resetSandboxWarnLatch`
  as deprecated. Both are test seams for WARN-once latches that were re-exported
  under plain camelCase, reading like ordinary API. They still work and are removed
  in the next major; there is no replacement, because production code has no reason
  to reset a warn-once latch.
  
  `resetBwrapMemo` is NOT deprecated and now documents why it is public: it is the
  companion to `detectBwrapMemoized`, and the only way to make a long-lived host
  re-probe after `bwrap` is installed.
- f64ab2b: `SessionManager` gains an optional `getCookieSecret()`, the member `defineAuth`
  uses to encrypt the OAuth transaction cookie.
  
  It is additive: a manager without it falls back to `THEOKIT_OAUTH_TX_SECRET`
  exactly as before. What changes is that the orchestrator no longer casts its own
  port away to read an undeclared `secret` field — a shape no conforming
  implementation could supply.
- 6aeeadb: Telemetry auto-instrumentation now logs what each adapter actually wired.
  
  Five of the seven adapters install something concrete — an OTel span processor,
  an event processor, a vendor client. Braintrust and LangSmith cannot: those
  vendors auto-instrument from an env var, so loading the module is the whole
  contribution. Both are legitimate, but the registry printed
  `Braintrust auto-instrumented.` for the second kind, which read as a wired
  telemetry pipeline when nothing had been installed.
  
  `register()` now returns what it wired and the registry reports that instead of
  asserting a single outcome for all seven. A vendor that is detected but cannot
  be wired says so too, rather than being logged as instrumented.
- 7f2bce4: Test-only: the MCP token-store fixtures create their temporary directories atomically.
  
  CodeQL reported an insecure temporary file at high severity, and the report was right. The
  directories were built from a predictable name — `theokit-mcp-tokens-${hrtime}` under a
  world-writable `/tmp` — and one of them was created world-writable and populated afterwards. On a
  shared machine another local user can predict the path, win the race to create it, and plant a file
  the test is about to trust; the restrictive mode passed to `mkdirSync` arrives after the name has
  already been claimed.
  
  `mkdtempSync` creates with a random suffix and mode 0700 in one atomic step. The one fixture whose
  loose modes ARE the subject — the case proving the gate refuses a world-writable store — creates
  restricted and loosens with `chmod`, so the state under test is identical and the window is closed.
  
  No production code is affected and no assertion changed.
- edfa59c: The "no transport" error no longer tells you to install a package that cannot exist.
  
  When a provider declares an `apiMode` the SDK has no transport for, the thrown `ConfigurationError`
  advised: *"Install a third-party transport plugin (`@theokit-transport-{apiMode}`)"*. There is no
  plugin mechanism to install into — `registerTransport` and `transportRegistry` appear nowhere in the
  package, and the only other mention of `theokit-transport` was a docblock describing that very
  message. Someone could publish the package; nothing would load it.
  
  The message now says transports are a built-in, closed set, and names all four of them —
  `chat_completions`, `anthropic_messages`, `bedrock_anthropic`, `responses_api` — instead of two. The
  `transport_unavailable` code is unchanged, so anything branching on `code` is unaffected.
- e0a1ab9: Three public failure paths now carry a type and a code instead of a sentence.
  
  `normalizeSchema` threw bare `Error` for both of its failures — a missing
  `@valibot/to-json-schema` peer and an unsupported schema — so a caller could
  branch on nothing but the message. Both are `ConfigurationError` now, with codes
  `valibot_converter_missing` and `unsupported_schema`. It also detects the missing
  peer from `err.code === "ERR_MODULE_NOT_FOUND"` before falling back to matching
  the message text.
  
  Resuming an agent whose persisted workspace path exists but is a file now says
  so, instead of reporting it as "missing or inaccessible".
  
  Subscription error frames carry the server error's own `code` over the wire, and
  the WebSocket client prefers it over its blanket `ws_server_error`. A caller can
  tell an invalid input from a disconnect without parsing English.
- edfa59c: Workflow errors now carry `code` and `isRetryable`, so the SDK's own retry helper can see them.
  
  Eleven public workflow error classes extended plain `Error`. `isTransientError` is
  `err instanceof TheokitAgentError && err.isRetryable === true`, and it is the default predicate of
  `Retry.create` — so a class outside the hierarchy is permanent *by contract*, whatever it actually
  represents. Wrapping `workflow.run()` in the SDK's own retry helper therefore got `false` for every
  workflow failure, including `WorkflowAlreadyRunningError`, which is precisely the
  try-again-in-a-moment condition.
  
  They now extend `TheokitAgentError`, each with a stable `code`:
  
  | code | retryable |
  |---|---|
  | `workflow_already_running` | **yes** — another run holds the single-flight lock |
  | `workflow_duplicate_step_id`, `workflow_input_invalid`, `workflow_output_invalid`, `workflow_state_invalid`, `workflow_nested_failed`, `workflow_snapshot_not_found`, `workflow_max_iterations_exceeded`, `workflow_not_serializable`, `workflow_resume_step_not_found`, `workflow_compensate_not_implemented` | no |
  
  Source-compatible: `TheokitAgentError extends Error`, so `instanceof Error` and `err.name` are
  unchanged, and every existing field (`stepId`, `workflowName`, `detail`, …) stays where it was.
  
  `WorkflowParallelError` is deliberately unchanged — it extends `AggregateError`, and the standard
  `errors` array is why callers catch it. It stays outside the hierarchy, and therefore stays
  non-retryable; inspect `err.errors` and decide per branch.

## 4.63.4-next.0

### Patch Changes

- 01630ec: The README explains that three unrelated things in this ecosystem are called "plugin", and that
  two of them share one option.

  A **framework plugin** (`@theokit/plugin-canvas`, `@theokit/auth-github`, …) extends a `theokit`
  application — routes, UI, devtools, CLI verbs. An **SDK code plugin** (`PermissionPlugin.create(…)`,
  `Handoff.asPlugin(…)`) extends an agent and is passed as `Agent.create({ plugins: [ … ] })`. The
  same option also accepts `{ enabled: ["name"] }`, which selects **file-discovered** plugins under
  `.theokit/plugins/` and is mutually exclusive with the array form.

  Reaching for the wrong one raises no error; it simply has no effect. Installing `plugin-payments`
  does nothing for an agent, and passing `PermissionPlugin` does nothing for a route.

  It also records the observation that sends people looking for a bug that is not there:
  `agent.pluginsManager` only ever holds the file-discovered form, so it reports `plugins: []` while
  a code plugin is registered and working. An empty manager beside a populated `options.plugins` is
  the normal shape.

## 4.63.3

### Patch Changes

- 076e1b3: The Claude Code interop memory read is keyed by the git repository root, matching the CLI.

  `claudeProjectMemoryDir` keyed the auto-memory store by `cwd`. The CLI keys it by the repository:
  _"the `<project>` path is derived from the git repository, so all worktrees and subdirectories within
  the same repo share one auto memory directory. Outside a git repo, the project root is used
  instead."_

  So an agent running from any directory below the root — a monorepo package, a script in `tools/`, a
  test in a subfolder, which is the ordinary case — read a directory the CLI never writes to. It found
  nothing and reported nothing, and that observation is identical to an empty store, which is why it
  survived the interop change that introduced it.

  Confirmed from disk before the fix: of the CLI project directories that resolve to a SUBDIRECTORY of
  a git repository, none had a `memory/` at all, while their repository root held three fact files.
  The subdirectory directories contained only session transcripts.

  **Transcripts are the trap and stay as they were.** The CLI keys those by `cwd`, correctly, and
  `encodeProjectDir` is right for them. One encoder serving two axes is what made the two
  indistinguishable in the code; the encoder is still shared, the path it is given is not.

  `.git` as a FILE — a worktree or a submodule — counts as a repository, so the read does not miss
  again in the layout that most needs it.

## 4.63.2

### Patch Changes

- 1466750: A refused `memory.directory` is now reported on the read path, not only on the write path.

  A relative `directory` is refused by contract, and the write path has said so since the near-miss
  diagnostic landed. The read path did not: `readMemoryForSend` wrapped everything in `safeCall`, which
  reports on `diag` — dropped entirely when the host installed no sink. An app that only CONSUMES
  memory, which is the served case the option exists for, answered every turn normally with an empty
  store and never learned why.

  Measured against the published package with no sink installed: `Agent.create` did not throw, the turn
  answered normally, nothing was written to either the configured path or the default store, and
  stderr said nothing at all.

  `safeCall` stays where it was added for, and that trade is unchanged: a corrupt memory file must not
  abort the turn, and reporting it quietly is right because it is transient and local to one entry. A
  `ConfigurationError` from the resolver is the opposite — permanent, repeating on every turn forever,
  and fixable in one line by the person being kept in the dark — so it goes on the channel a failure
  cannot be dropped from.

  Reported **once per configuration per process**, not per turn. A warning that arrives every turn is a
  warning somebody turns off.

## 4.63.1

### Patch Changes

- 7e651d1: A `Remember` phrase that stores nothing now says so, instead of looking exactly like success.

  `persistMemoryFactIfWritePrompt` had three early returns and a diagnostic on none of them. A phrase
  one token from the supported one — `Remember, please:`, `Remember that:`, `Please remember:` — was
  answered normally and stored nothing, and the caller could only find out by listing the store
  afterwards. The transcript indexer made it worse: the sentence still lands in `sessions/run-*.md` and
  is indexed, so a follow-up question comes back with the right answer and the developer concludes
  memory is on. What they have is full-text search over transcripts — no `MEMORY.md`, nothing to
  commit, nothing a human can edit, nothing that survives transcript pruning.

  The gate is unchanged and deliberately so: a heuristic over user text must not capture aggressively,
  or an ordinary sentence about remembering becomes a durable fact. What was missing was the signal.

  Three paths now report, all through `diagFailure` rather than `diag`, because the user asked for
  something durable and did not get it — and `diag` is dropped entirely when the host installed no
  sink (`#189`):

  - a message that opens with the capture verb and does not match the pattern;
  - a match with nothing after the colon;
  - the write itself failing, which went through `safeCall` and disappeared with it. The swallow
    stays — one unwritable memory must not abort the turn — but it no longer happens in silence.

  The supported forms in the message are interpolated from `MEMORY_KINDS`, never spelled out. The
  reported defect is the accepted vocabulary widening between 4.56.0 and 4.57.0 with nothing announcing
  it; a hand-written list in the warning could go stale exactly the same way, one layer up from the bug
  it explains.

## 4.63.0

### Minor Changes

- 6410e27: **BREAKING (narrow):** `local.sessionDir` no longer decides where memory is written. Use the new
  `memory.directory` option. Facts already recorded are not moved and stay readable — the Claude Code
  store is a read root unconditionally — so a consumer who relied on the old coupling gets their new
  facts in the project store until they set `memory.directory`.

  Memory now has ONE answer to "where does this agent's memory live?", and every path derives from it.

  Fourteen places computed a memory path from `cwd`, and one of them computed a different one.
  `appendFact` relocated when `local.sessionDir` was set; the indexer, the `memory_get` path guard,
  `MEMORY.md`, `sessions/`, `notes/`, `wiki/`, the dream diary and the index database did not — the
  last of those spelled the default layout out again as a string literal, so no search for the shared
  helper would have found it. A relocated fact was therefore written, never indexed, unreadable by the
  tool whose job is reading memory, and shadowed by a second `MEMORY.md` in the store it had left.

  - **New `memory.directory`.** Absolute or `~/`-prefixed. Point it at
    `~/.claude/projects/<encoded-cwd>/memory` to write where the Claude Code CLI reads. A relative
    value is refused with `invalid_memory_directory` rather than resolved: the workspace and the
    process cwd are both plausible bases, and picking one silently is how a store ends up split
    across both.
  - **One resolver.** `resolveMemoryRoot` is the only producer of a root, and it returns a branded
    `MemoryRoot` that every path helper now requires. The brand is STRUCTURAL rather than a
    `unique symbol`: the d.ts bundler inlines a `unique symbol` declaration into every package that
    re-exports it, so `@theokit/sdk-memory` ended up with a `MemoryRoot` its own compiler rejected
    against the SDK's, on values that were the same string. A structural tag refuses a bare `string`
    exactly as well and survives the package boundary. A cwd and a root are both strings, so the brand
    is what makes "every path derives from one resolution" a compiler rule instead of a convention —
    and it is what surfaced the three call sites that were silently reading the wrong directory.
  - **`local.sessionDir` means one thing again:** where session transcripts go.
  - **Unchanged:** WRITE ONE, READ ALL. Recall still covers the configured root, the project store and
    the CLI's store, so relocating the write orphans nothing.

  Everything under the root follows it: `MEMORY.md`, the per-memory files, `notes/`, `sessions/`,
  `wiki/`, `transcripts/`, `dream-diary.md`, `.index/memory.sqlite` and the Lance store. Two of those
  were found by the brand rather than by reading — `index-db.ts` and `lance-index.ts` each spelled
  `.theokit/memory` out again as a string literal, so no search for the shared helper would have
  reached them.

  `Memory.runDreamingSweep` and the SQLite→Lance migration take a `directory` for the same reason: a
  sweep that consolidated notes into the default store while the facts lived elsewhere would be the
  same defect one function over.

  `internal/memory/storage` (semver-exempt sub-path) drops `memoryDir` and `memoryWriteDir` and gains
  `resolveMemoryRoot`, `projectMemoryDir`, `memoryReadRoots`, `asMemoryRoot` and `MemoryRoot`.
  `RecordSessionSummaryArgs` gains a required `memoryRoot`, supplied by the kernel — an implementor
  consumes those args and never constructs them.

  **The `MEMORY.md` budget is a statement about the interop partner, and only that.** The Claude Code
  CLI loads the first 200 lines / 25 KB of an index into every session and drops the rest in silence.
  This SDK never loads the index at all — the `<memory>` block is built from the per-memory FILES,
  ranked and capped — so our recall does not degrade as the index grows. `indexBudgetWarning` therefore
  speaks ONLY when `memory.directory` points at the store the CLI reads, says what is true (the CLI
  drops entries) rather than what is not (memory stops working), and never throws: the fact file and
  the index rewrite are one atomic operation, so refusing the second would lose the first.

  **Two things deliberately do NOT follow the option.** The index DATABASE stays in the project store
  even when the facts move: `memory.directory` may name the directory the Claude Code CLI manages, and
  that CLI has no index format — a binary artefact it does not understand does not belong in a
  directory it owns. What gets INDEXED is still the configured root; only the file's location is held
  back (`docs/memory-decisions.md` § 1). And one path: `legacyMemoryJsonPath`, which locates the
  pre-#389 JSON store. That store was written before the option existed, so pointing it at a
  configured root would look for a legacy file where a legacy file cannot be.

## 4.62.0

### Minor Changes

- 36bb21f: Memory recall is scored with BM25 instead of Jaccard, and rank fusion is damped for stores of
  tens rather than hundreds.

  **What changes for you:** which memories are selected when several are plausible. The store, the
  budget and the API are unchanged; the ordering is not.

  Measured on LongMemEval-S — 500 questions, 54 sessions each — through a public eval harness, with
  its tokenised-substring `grep` adapter as the floor:

  |                         | hit@5     | P@5       | R@5       | p50      |
  | ----------------------- | --------- | --------- | --------- | -------- |
  | Jaccard (4.61.0)        | 80.0%     | 0.236     | 0.670     | 205ms    |
  | `grep` (floor)          | 89.0%     | 0.295     | 0.807     | 2ms      |
  | **BM25 (this release)** | **96.8%** | **0.329** | **0.904** | **20ms** |

  Jaccard lost to a naive substring match. The mechanism was isolated before it was fixed: on a
  preference query, the term that discriminates appeared in 2 of 15 documents while a noise term
  appeared in 14 — and Jaccard weighted them identically. Almost every document scored above zero,
  fusion flattened what ordering remained, and recency decided a relevance question. IDF is the
  whole fix, and the gain concentrates where that predicts:

  ```
  single-session-preference   46.7% -> 86.7%   (+40.0)
  single-session-assistant    89.3% -> 100.0%  (+10.7)
  temporal-reasoning          85.7% ->  96.2%  (+10.5)
  multi-session               94.7% ->  96.2%   (+1.5)
  ```

  Also **10x faster**: the previous implementation called its scoring function from inside sort
  comparators, re-tokenising every fact O(n log n) times per query.

  Rank fusion damping moves from k = 60 to k = 5. Swept rather than chosen — the 500-question corpus
  is insensitive to k once terms are IDF-weighted, while a 15-session corpus goes from 14/15 to
  15/15. The sweep cannot separate 5 from 1, so the tie is broken on the principle that at k = 1
  damping is nearly gone and fusion stops fusing.

  **This improves the reliability of memory poisoning as well as of recall**, and the two cannot be
  separated: the property that makes a planted entry work is the property that makes a real one
  useful. See the accompanying patch note for the re-measured figures.

### Patch Changes

- Corrects a security figure published with 4.61.0, and adds the rule that produced the error.

  The 4.61.0 notes said a planted memory entry made the agent perform the action it described in
  **2 of 6 runs**. Re-measured against the published 4.61.0 itself, it is **6 of 6**. Registering
  the permission engine still blocks it — 6 of 6, with zero errors.

  The old figure was not a smaller version of the same risk; it was a measurement of a different
  thing. It was taken against a retrieval path that did not recall the planted entry at all: on
  4.60.0 the agent answered "Done." and never saw it, while on 4.61.0 it recites the entry
  verbatim. Nothing about the attack changed between those runs — the recall path did.

  **A poisoning rate measured against a retrieval path that does not recall the plant is a
  measurement of how often the attack reached the model, not of how often the model resisted it.**
  Any such figure has to record whether the plant was recalled, or it cannot be compared across
  versions.

  The consequence for anyone depending on this: improving recall is a change to the threat model,
  not something orthogonal to it. The property that makes a planted memory work is the property
  that makes a real one useful. **If anything other than your agent's own deliberate writes can
  reach the memory directory, register the permission engine.**

  Separately, the original proof constructed the engine as `new PermissionEngine({ rules: [] })`.
  The constructor takes the rules positionally, so that was never a rule list, and nothing checked
  because the script was JavaScript. A crash inside the engine and a gated call produce the same
  observation. Re-run in TypeScript with `new PermissionEngine([])`, it gates: 6 of 6 blocked, 0
  runs threw.

## 4.61.0

### Minor Changes

- 85d96ce: Memory files now match the Claude Code layout, and a memory is named after its subject.

  **What changes on disk.** A memory used to be named after its whole text, cut at 64
  characters; it is now named after its topic (~32 characters), the index header is
  `# Memory Index`, and each index line reads `- [Title](slug.md) — summary`. Stores written
  by earlier versions are still read; only new writes land under the new names.

  **Why it matters beyond tidiness.** Naming a memory after its whole text put the entry's
  content into its filename, and a filename is the most exposed field an entry has — it shows
  in directory listings, shell completion, tool logs and stack traces, none of which require
  opening the file. This closes that (#446) by construction rather than by detection: a rule
  about sensitive values would have to recognise one, and secret-pattern redaction cannot
  recognise an arbitrary passphrase. Naming a memory after its subject drops the tail of the
  sentence whatever the tail happens to be.

  **The trade this makes, stated because it is real.** A topic name is a lossy summary, and
  lossy summaries collide — three different facts about the same subject would reduce to one
  filename. Writes with different text now move aside to `topic-2` instead of overwriting, so
  nothing is lost; re-recording the same text still lands on the same file and increments its
  corroboration count.

  `MemoryFact` accepts optional `title` and `description` for callers that want to author them
  rather than have them derived.

  **Not fixed by this release, and measured:** an uncorroborated entry marked `[unconfirmed]`
  influences the model without constraining it (~62%, 95% CI [39%, 82%], n=32), and a planted
  entry phrased as standing policy was sufficient for a live agent to perform the action it
  described in 2 of 6 runs. Registering the permission engine blocked the executive case in
  every run; it is opt-in. Any deployment whose memory directory is writable by anything other
  than the agent's own deliberate writes should register it.

## 4.60.0

### Minor Changes

- 8d072cf: The markdown memory store is now importable by `@theokit/sdk-memory` instead of copied into it.

  `@theokit/sdk-memory` carries its own copy of the store, and `Memory.runDreamingSweep` replaces this
  implementation with the peer's whenever the peer is installed — so the copy that runs is not the copy
  anyone maintains. It stayed on the layout that predates the file-per-memory format, which means
  installing `@theokit/sdk-memory` today makes every memory this SDK has written unreadable. Nothing
  throws: the sweep reports `factsBefore: 0`, a number indistinguishable from an empty store (#430).

  This release ships the half that has to exist first — the `@theokit/sdk/internal/memory-store`
  sub-path, semver-exempt like `internal/persistence` and `internal/memory-adapters`. The satellite
  cannot declare a floor on a version that is not published yet, so its delegation follows in the next
  release rather than riding along with a floor nobody can install.

  theokit#160 fixed this exact shape for the embedding runtime, in this same package pair. Re-syncing a
  copy fixes today's divergence and leaves tomorrow's free to happen.

## 4.59.0

### Minor Changes

- bd44344: Memories this SDK records can now land where the Claude Code CLI reads them, closing the direction
  that was missing: the CLI's memories were already visible here, but everything this SDK wrote went to
  `<cwd>/.theokit/memory`, invisible to the CLI in the same project.

  `local.sessionDir` is the switch, because it is already the option this project documents for that
  interop — point it at `~/.claude` and the CLI can `--continue` a session your agent wrote. A consumer
  who set it has said they share state with that CLI, and memory following is what that sentence
  already implied. There is no new option, and **nothing moves for anyone who never set it**.

  The rule that makes this safe is **write one, read all**. Reads cover the project store, the
  configured session home, and the CLI's own default location, so a consumer whose new facts move keeps
  every fact they already had. The change relocates where the next one lands; it orphans nothing.

  The `MEMORY.md` index is written beside the files it lists rather than in the project store — an
  index in one directory naming memories in another points at files that are not there, and that index
  is what the CLI reads.

## 4.58.0

### Minor Changes

- b39bb5f: A plugin written for the Claude Code CLI now works instead of merely parsing.

  Measured 2026-08-26 against an installed one: a CLI plugin is a BUNDLE — its manifest sits at
  `<plugin>/.claude-plugin/plugin.json`, and what it exists to contribute are the `skills/` and
  `agents/` directories beside it. This SDK's plugin concept is a JS `entry` point, so such a manifest
  already parsed (zod strips the keys it does not know) and then did nothing at all: `name` and
  `version` survived while the seven agents and three skills the plugin provides stayed invisible.

  The manifest agreeing was never the point. Plugin folders under `.theokit/plugins` and
  `.claude/plugins` now contribute their skills and agents, and the CLI's manifest location is read
  without the deprecation warning that belongs to this SDK's own superseded `plugin.json` form —
  telling someone to migrate a file that is canonical where it came from would be wrong.

  Bundles are read AFTER the project's own directories, so a project can shadow a skill or an agent a
  plugin ships without editing the plugin.

  Project-scoped deliberately. The CLI also keeps plugins under `~/.claude/plugins/cache`, behind its
  own installer and enable/disable state; reproducing that is an installation system rather than
  reading a project's configuration, and guessing at someone's enablement would run code they had
  turned off.

- cb1ad68: A project set up for the Claude Code CLI now works without being converted: `.claude/agents`,
  `.claude/skills`, `.claude/hooks.json` and the CLI's own `settings.json` / `settings.local.json` are
  read alongside `.theokit`.

  The formats already agreed — only the directory did not. Measured 2026-08-26: `SkillFrontmatter`
  requires exactly the `name` and `description` the CLI writes into every `SKILL.md`; the hook config
  this SDK parses is documented as, and is, the CLI's `settings.json` hooks shape; and 59 of the CLI's
  agent declarations parse here unchanged.

  `.theokit` is searched first and nothing about it changes. Two rules, and the difference between
  them is deliberate:

  - **Named declarations collide, so the first wins.** Two files declaring an agent or a skill called
    `foo` are one name claimed twice, and the explicit namespace should win.
  - **Hooks accumulate.** They are unnamed lists — two files declaring `PreToolUse` are two sets of
    commands an operator wrote, and keeping one would drop the other in silence.

  `THEOKIT_HOME` deliberately does not move these directories. It relocates cwd-anchored SDK _state_;
  a project's _configuration_ belongs to the repository, and following the override here would change
  where a project's agents come from under the cover of a refactor.

  Known limitation: `SessionStart` and `PreCompact` have no firing point in this runtime, so hooks
  declared for them are skipped with a warn rather than silently accepted. Four CLI events map:
  `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`.

- ad0c320: Rules and memories written for the Claude Code CLI are now read.

  **Rules** — `.claude/rules/*.md` joins the discovery specs at priority 47. The format needed
  nothing: measured over this repository's 32 rule files, none carries frontmatter, and the
  `rules-frontmatter` parser already reads a file without it as `alwaysApply: true`. There was simply
  no spec pointing at the directory.

  47 rather than 46 because B-127 makes these numbers a public contract with room between adjacent
  pairs for a consumer's own source. No published priority moves; a consumer that had chosen 47
  collides, and that is the cost of an eighth default, recorded here rather than discovered later.

  **Memories** — the CLI keeps a project's memories at `<claudeHome>/projects/<encoded-cwd>/memory/`,
  the same encoding the transcripts use. `markdown-store`'s own header named that path as the target;
  #389 converged the format and the ability to reach the directory was never built, so a memory the
  CLI recorded was invisible to an agent working in the same repository. Both stores are read now,
  `.theokit` first. `CLAUDE_CONFIG_DIR` names the home when set.

  Reading only — writes still go to `.theokit/memory`. Writing elsewhere by default would relocate
  every existing consumer's memories, which is the one thing an additive change must not do.

  One fidelity fix came with it: a memory's BODY is the fact, and `description` is the one-line recall
  aid. This SDK writes both the same, so nothing it wrote changes — but the CLI writes a summary above
  the substance, and reading only the summary dropped the fact itself.

- 78bff6c: `THEOKIT_DIR_NAME` no longer appears in `SOVEREIGN_ENV_KEYS`. It was documented there as naming the project config directory, and nothing ever read it — setting it did nothing. If you want the SDK to read configuration from `.claude` alongside `.theokit`, that now happens by default and needs no variable. `SOVEREIGN_ENV_KEYS` is public, so a consumer narrowing a type to it gains one fewer member.

### Patch Changes

- 5f3b1da: Agent files written for the Claude Code CLI now load.

  Two defects, both measured against the 64 agent-directory files on one machine (a project
  `.claude/agents` plus every installed plugin):

  - **`color` made the file a load error.** It appeared in 38 of the 59 agent declarations — it is the
    CLI's label colour and changes nothing about what an agent may do, but the loader rejects unknown
    frontmatter fields, so a majority of real agent files could not be loaded at all.
  - **One README stopped every agent in the directory.** A markdown file with no frontmatter threw
    `subagent_missing_frontmatter`, aborting the whole directory read. `.claude/agents/README.md` is a
    real file in this repository, cited by its own cycle rules.

  The strict-field check is NOT loosened — its reason is sound, and stated where it lives: a dropped
  `sandbox` that an operator wrote believing it confines the child is a silent gate. Fields known to be
  inert for this runtime are now named explicitly, which is the difference between "we know this one
  and it does nothing" and "we have never heard of this". A field that could change behaviour still
  fails loudly, and a file that HAS frontmatter and gets it wrong is still a broken agent. Only the
  no-frontmatter case is skipped, with a warn naming the file.

  Measured after: 64 files in, 59 agents loaded, 5 documentation files skipped. Before: zero.

## 4.57.0

### Minor Changes

- 43e4247: A memory fact's `kind` can now actually be written. `Remember (feedback): prefer tabs` types the
  fact; a bare `Remember:` leaves it untyped, as before.

  The field was added so the local memory store would converge with the format Claude Code uses, and
  it worked in one direction only: the SDK read a kind off an existing memory and honoured it, but no
  path could ever produce one. `appendMemoryFact` rebuilt the fact as `{ text }` alone, so a kind was
  severed at the single chokepoint every write passes through — the round-trip through the file format
  was real and unreachable.

  Only the four kinds the store accepts (`user`, `feedback`, `project`, `reference`) are recognised, so
  an arbitrary parenthetical is never mistaken for one and no fact is silently typed wrong. `modified`
  is still stamped by the SDK and ignored when supplied: a timestamp the caller controls can lie about
  when something was learned, which defeats weighing a note from this morning against one from four
  months ago.

- b85dab4: Session transcripts are now named with a UUID, so the Claude Code CLI can actually `--continue` a
  session this SDK wrote.

  That interoperability is the difference this project claims over a proprietary session store, and it
  did not hold. Measured against CLI 2.1.236: a transcript resumes only when its basename is a UUID —
  `billing-bot.jsonl` and `agent-<uuid>.jsonl` are both ignored, silently, with the session simply not
  offered. Every session written under a human-readable agent id was invisible.

  The filename is now derived from the agent id with a UUIDv8 over SHA-256, so it is deterministic:
  the same agent id always yields the same transcript and nothing has to be persisted to map one back
  to the other. Version 8 is RFC 9562's slot for an implementation-defined scheme, which is what this
  is — v5 would have been the obvious choice but RFC 4122 fixes its hash to SHA-1, and a weak
  primitive in the tree costs a permanent argument with every scanner that sees it. An
  agent id that is already a UUID passes through unchanged, so a transcript Claude Code wrote keeps its
  own name and the two directions stay symmetric.

  Existing transcripts are not orphaned: a session whose file already exists under the old name keeps
  using it, so history continues to accumulate in one place rather than being abandoned for an empty
  file under the new name. Those sessions do not gain `--continue` support — their name is what the CLI
  cannot read — but nothing that was written is lost or hidden.

### Patch Changes

- 18a68a0: A provider that does not take its credential from the caller is no longer refused for lacking one.
  `createLocalAgent` read the provider descriptor two lines below the `throw` that guaranteed
  execution never reached it, so `ollama/llama3.2` failed with `missing_api_key` before any runtime
  work began — and so did every OAuth profile, Bedrock and Vertex.

  Only `authType: "api_key"` requires a key from the caller. The other four modes source their own:
  `none` sends no Authorization header at all, and `aws_bearer` / `gcp_oauth` / `oauth_device_code` /
  `oauth_external` build their client with a placeholder and resolve a real token at stream time.

  Fail-closed is preserved in both directions that matter: an unregistered provider prefix yields no
  profile and is still refused, so a typo cannot become a free pass; and a provider that does
  authenticate is refused exactly as before.

- 4565e43: `zod` is now a regular dependency, so `npm install @theokit/sdk` produces a package that imports.

  It was declared as an OPTIONAL peer dependency while 27 source files imported it — 14 of them at
  module scope, on the paths that load agent context, read credentials and parse persistence. npm
  honoured the declaration and did not install it, so a fresh consumer hit
  `Cannot find package 'zod'` on the first line of the quickstart, from `dist/index.js` itself. 12 of
  the 33 published subpaths could not be loaded at all.

  Every suite in this repository runs inside the workspace, where `zod` is hoisted whether or not the
  package declares it — which is why 5000+ green tests, `publint` and `attw` all saw nothing. The
  release chain now packs the tarball, installs it outside the workspace and imports every declared
  subpath, so this class of defect fails before publishing rather than after.

  Consumers already on `zod ^4` are unaffected: the ranges overlap and the tree still resolves to a
  single copy, so a schema you build still crosses into the SDK as the same type.

## 4.56.0

### Minor Changes

- b08f696: `MessageBus.request` now rejects a timeout with `A2ARequestTimeoutError`, carrying
  `code: "a2a_request_timeout"` plus the peer's address and the limit as fields.

  It used to reject with a plain `Error` and no code, so the only way to identify a timeout was to
  match the message — the practice `docs/error-codes.md` tells consumers never to rely on, and that
  message embeds the address and the limit, so it changes with context exactly as the document warns.

  The distinction this restores is what a retry policy is built on: a peer that did not answer is
  transient and worth retrying, a peer whose handler threw is likely deterministic. A handler's own
  error still propagates unchanged and is not this type.

- f7e70e4: The memory store now writes the layout the Claude Code CLI reads.

  This SDK's differentiator is that it emits the formats that CLI opens — point `local.sessionDir` at
  `~/.claude` and `--continue` a session your agent wrote. Memory did not hold that line: a fact was a
  bullet under `## Facts`, so pointing a memory directory at `~/.claude/projects/<project>/memory/`
  produced nothing the CLI could read.

  Now each memory is its own file with the frontmatter Claude Code writes — `name`, `description`, and
  `metadata` carrying `type` and an ISO 8601 `modified` — and `MEMORY.md` is the index that points at
  them.

  Legacy `## Facts` bullets are still read, so no store loses what it recorded. The brief encoding that
  put a fact's kind in a trailing HTML comment never reached a published version, so there is nothing
  to migrate from it.

  `parseSimpleYaml` also stops flattening nested maps: `metadata:` with indented keys used to yield
  `metadata: []` plus the nested keys as top-level entries, so `metadata.type` read as `undefined`
  while `type` appeared where it never was.

- 5036f04: A memory fact can now say what it IS and when it was learned.

  `MemoryFact` gains an optional `kind` — `user`, `feedback`, `project` or `reference` — and a
  `modified` timestamp. Without them a durable preference and a project note that went stale were
  indistinguishable: no staleness signal, no way for recall to filter, no basis for selective
  retention, and no way for a surface to separate "what I remember about you" from "what I know about
  this project".

  Additive, so existing stores keep working. A hand-written bullet under `## Facts` still parses and
  stays untyped — a kind is never inferred, because a wrong one makes recall confident about the wrong
  thing. `modified` is stamped by the SDK and ignored when supplied by a caller: a timestamp a caller
  can set is one that can lie about when something was learned.

### Patch Changes

- 7587c00: A confined command that spawns a child no longer loses its output.

  The restricted-network seccomp filter denied `getsockname`, `getpeername`, `setsockopt` and
  `getsockopt`. Those four take an already-open fd, and cBPF cannot dereference one to learn its
  address family — so they were denied on AF_UNIX too, which is what libuv uses for a child's IPC
  channel. Any command that spawned a child died, and the parent's buffered stdout died with it:
  `node --test` returned zero lines through `shell_exec`, and an agent reading test output saw an
  empty string.

  The four leave the denied set. Everything that takes an address or changes an fd's role —
  `connect`, `bind`, `listen`, `accept`, `accept4`, `sendto`, `sendmmsg`, `recvmmsg`, `shutdown` —
  stays denied, and `socket()` still refuses every family but AF_UNIX. Measured across the fix: an
  AF_INET socket is `EPERM` before and after.

## 4.55.0

### Minor Changes

- 1988b1d: Responses-API requests now carry `prompt_cache_key`, so the provider can reuse the cached prompt
  prefix between rounds instead of re-charging the whole system prompt and tool schema every time.

  Measured on a consumer product against OpenAI Codex — same provider, same model, same reasoning
  effort, same task — the SDK sent a THIRD of the bytes (24,691 c vs 76,331 c) and paid 2.8x the tokens
  (24,914 vs 9,036). The difference was not what was sent; it was that theirs was cached and ours was
  not, because no key told the provider which prefix to match.

  The key is derived (SHA-256, truncated, prefixed) from the run's session identity — the id
  `Agent.getOrCreate(sessionId)` keys on — so it is identical across every round of a turn and every
  turn of a session, different for unrelated sessions, and stable across a process restart, while
  disclosing nothing about a caller-chosen session name. Both halves matter: a key that changes per
  round caches nothing, and a key shared between sessions asks the provider to match one conversation's
  prefix against another's.

  Alongside it, a provider profile may now declare `encryptedReasoning: true`. When it does, the
  request adds `include: ["reasoning.encrypted_content"]` and `reasoning.context: "all_turns"`, and the
  transport replays the ciphertext the provider returned immediately before the tool call it produced,
  so the model does not re-derive its chain of thought on every round. It is off by default and on for
  the builtin `openai-chatgpt` profile: `include` is a documented Responses-API field but
  `reasoning.context` is not, and that endpoint is the one where acceptance was observed rather than
  assumed. Every other provider's request body is unchanged.

  `store` stays `false`, now as a recorded decision rather than an unexamined default. Codex sends
  `true`; SDK requests routinely carry a consumer's source code and shell output from machines whose
  operator never agreed to server-side retention, and nothing in the caching work needs it — the cache
  key handles the prefix and the encrypted-reasoning carry is precisely the mechanism for keeping
  reasoning without server-side state.

  Fixes `usetheokit/theokit-sdk#383`.

- 63b0831: A local agent can now withhold the SDK's builtin tools from the catalog it declares to the model,
  and a disabled memory store no longer writes a session transcript into the consumer's repository.

  `AgentOptions.withheldBuiltinTools?: readonly BuiltinToolName[]` names builtins — `shell`,
  `memory_search`, `memory_get` — that this agent must not declare. Absent or empty, every builtin the
  rest of the configuration would register is declared exactly as before, so nothing changes for an
  agent that does not ask.

  The option exists because denying a tool and never offering it are different things. A consumer
  whose sandbox scope cannot admit `shell` could already refuse the call in a `pre_tool_call` hook, and
  paid for the tool twice anyway: 267 characters of schema in every request of every round, plus a
  round the model can spend discovering a refusal it had no way to anticipate. Withholding removes the
  tool from the catalog, so the model is never shown what it cannot have. Withholding also releases the
  name — a withheld `shell` may be replaced by a custom tool called `shell` without the
  `tool_reserved_name` error, since the reservation exists to prevent a collision that no longer
  exists. Builtins still declared stay reserved.

  Fixes `usetheokit/theokit-sdk#381`.

  `memory: { enabled: false }` now suppresses the per-run session transcript at
  `<cwd>/.theokit/memory/sessions/<runId>.md`. It previously did not: that write was gated on the run's
  status and nothing else, so an agent with memory switched off still had the full user prompt and
  assistant reply written into the working directory — someone else's git repository, in the reported
  case. Every other memory surface already honoured the flag, so "memory is off" was true of the
  subsystem apart from the one part of it that creates files. Both writers are covered, the legacy
  call and the `MemoryProvider.recordSessionSummary` port.

  Leaving `memory` unset is unchanged and still writes, because that file is what
  `memory_search({ corpus: "sessions" })` reads once memory is switched on; treating an absent config
  as off would empty that corpus for consumers who asked for nothing. Writing `enabled: false` is the
  opt-out.

  So: if you run an agent inside a repository and were adding `.theokit/` to `.gitignore` to keep
  prompts and replies out of it, `memory: { enabled: false }` now stops them being written at all.
  `memory_search({ corpus: "sessions" })` returns nothing for those runs, which is the trade — no
  transcript on disk, nothing to recall from it.

  Fixes `usetheokit/theokit-sdk#382`.

### Patch Changes

- a3bdbd1: The Responses transport now reads `input_tokens_details.cached_tokens` and `.cache_write_tokens`,
  so a consumer can tell what a turn actually cost.

  `input_tokens` INCLUDES the slice the provider served from its prompt cache. This transport reported
  `cacheReadTokens: 0` regardless, so adding input to output counted tokens nobody is paying for.
  Measured on a three-round turn with `prompt_cache_key` in use: the provider reported
  `cached_tokens: 4608` on every round, and the consumer received 9,835 where 619 were new — 16x.

  The sibling Chat Completions transport has always read the equivalent
  (`prompt_tokens_details.cached_tokens`); this one read `output_tokens_details.reasoning_tokens`
  beside it and skipped this one. The response type declared neither, so it was invisible at the type
  level too.

  It matters beyond an inaccurate number: it makes the SDK look expensive when it is not. Comparing a
  consumer against OpenAI Codex on identical tasks, the gross figure said 2.8x. Codex reports the net
  figure (`non_cached_input + output`). Measured with the same formula on both sides, the same task
  costs 14,317 against 13,560 — inside the run-to-run variance.

  Fixes `usetheokit/theokit-sdk#386`.

## 4.54.0

### Minor Changes

- 0258f3c: Two `theokit` flags that were advertised in `--help` and read by nothing now behave.

  `tasks cancel --reason <r>` records the reason: `TaskHandle` gains a `cancelReason` field, written
  alongside `cancelledAt` for a queued task and alongside `cancelRequested` for a running one. A task
  that is already terminal is left untouched, reason or not.

  **Breaking:** `theokit init --here` is removed. It never scaffolded into the current directory, and
  the writer cannot honour it — the tree is built in a temp directory and moved into place with `rm` +
  `rename`, so a destination equal to `cwd` would mean deleting the directory the process is running
  in. An unknown-option error is immediate and clear where silence was not.

- d485b4e: Fix three unresolved type references in the published declaration file (#335).

  `MemoryProviderFactory` is now exported from the package root. It is the shape a
  consumer must satisfy to write a memory plugin — the public `Plugin` union names
  it in the `createProvider` position — but it carried the internal-visibility
  JSDoc tag, so `stripInternal` deleted the declaration while the union went on
  referencing it. The shipped `.d.ts` named a type it did not declare.

  `AgentBuilderDeps` and the blast-radius symbol used as a computed key in
  `WithBlastRadius<T>` had the same defect on other surfaces and are now emitted.
  Neither is added to the public API — they only needed to exist in the declaration
  file that references them.

  None of this is visible under `skipLibCheck`, which is why it shipped. Consumers
  running type-aware lint saw every type reached through those references degrade
  to `error`, producing `no-unsafe-*` reports on correct SDK calls.

- 181967f: New `RunEvent` member: `mcp_server_ready`, carrying the server name and the tool names it listed.

  `mcp_server_failed` already reached consumers, so a broken MCP server was visible. A server that came
  up was not — the resolved tool table never leaves the agent loop's internals, and no event carried an
  inventory. A consumer could list what was configured and what broke, and could not tell a server that
  came up with twelve tools from one that came up with none.

  Emitted from the same function as its failure sibling, on the other branch. An event rather than a
  getter because the state is scoped to the run: with `mcpLifecycle: "run"` a server may not exist by
  the time anyone asks. Tool names are the server's own, not the sanitized `mcp_<server>_<tool>` form
  the model sees.

  Requested by `usetheokit/theokit#426`.

- f33b52b: `MemoryAdapter.isAvailable()` now disables an adapter that returns `false`, as its mandatory
  presence always implied.

  Nothing called it. Every third-party adapter implements it as "is there a non-empty apiKey", so an
  implementer reasonably read `false` as "disable me" — and it disabled nothing: the client is built
  lazily, so `mem0Memory({ apiKey: "" })` started normally and surfaced mid-conversation as
  `auth_failed`, at the point where a memory write is happening rather than where the operator could
  still fix it.

  An unavailable adapter is now skipped with a diagnostic naming it, so a missing key degrades to
  no-memory and a multi-adapter setup falls back to the ones that work. When every registered adapter
  declines, `write` and `recall` fail with a message saying exactly that — distinct from the message
  for no adapter registered at all.

- 398e7a0: `ModelSelection.url` — a model can name the endpoint it should reach.

  The base URL came only from a process-wide env var (`OLLAMA_HOST`, `OPENAI_API_BASE_URL`) or the
  provider profile's shipped default, so every `ollama/*` model in a process shared one host. An app
  could not run a small model on localhost and a large one on a GPU box, and could not talk to two
  OpenAI-compatible servers at once. The information had nowhere to travel: `ProviderRouterOptions`
  carried no URL field at all (usetheokit/theokit-sdk#332).

  ```ts
  model: { id: "ollama/llama3.3:70b", url: "http://gpu-box:11434" }
  ```

  Precedence is `ModelSelection.url` → the provider's base-URL env var → `profile.baseUrl`. The model
  outranks the env var deliberately: with the env var winning, whoever set it for one model would keep
  hijacking every other one, which is the same bug wearing a hat.

  Leaving `url` unset changes nothing — `ollama/qwen2.5:3b` still resolves to `http://localhost:11434`
  from the profile, with no key and no setup.

  Applied to both transports separately, because they do not share the override: `OllamaNativeClient`
  (the native `/api/chat` path Ollama tool calling requires) and the OpenAI-compatible client, which
  covers `lmstudio` and `llamacpp`. The tests assert the URL the stubbed `fetch` actually received
  rather than the options object handed to the client — an options-level assertion passes with the
  precedence inverted.

- 8d1feaa: `PostAssistantReplyContext` now carries `usedTools`, and `@theokit/sdk-cache` stops caching
  tool-using turns in plugin mode.

  The cache's D266/EC-10 guard exists because replaying an answer produced by a `write_file` / HTTP
  POST / payment call re-serves the text without the side effect having happened. The
  `post_assistant_reply` hook had no tool signal to key on and passed a literal `false`, so the guard
  never fired on the path that runs automatically — only a hand-written `cache.remember(..., {
usedTools: true })` reached it.

  The runtime derives the flag from the run's replayed event stream. A hook handler written against
  the previous shape keeps working; code that CONSTRUCTS a `PostAssistantReplyContext` (test doubles,
  custom emitters) now has to supply the field.

- 9a27a72: Exposes the provider registry: `listProviders()` and `getProviderProfile(name)`.

  The registry was `@internal`, so the SDK was the only thing that could answer "which providers
  exist, and what does each one need?". `theokit` consequently kept its own hand-written list of
  three — against the 46 registered here — and an agent declaring `ollama/qwen2.5:3b` routed to
  whichever API key happened to be set rather than to Ollama (usetheokit/theokit#326).

  A second table that nothing forces to agree with the first is not a cache, it is a future bug.
  These two functions exist so there is one table, and the framework can stop guessing.

  Both register the builtins before answering. Registration is lazy — it happens when an agent is
  created, a run is routed, or a provider is defined — so a caller asking early would otherwise get
  an empty registry and reasonably conclude the SDK knows nothing. Local providers (`ollama`,
  `lmstudio`, `llamacpp`) come back with `authType: "none"`, which is what lets a consumer tell "no
  credential needed" apart from "credential missing" without hardcoding names.

- f692988: The reference docs no longer ship inside the package. `node_modules/@theokit/sdk/docs/` is gone, along with the `harness-capability-map.md` and `error-codes.md` files it carried — the `docs` entry was removed from the published `files` list and the build step that generated it was removed with it.

  The exported TypeScript types are now the only reference surface, and they remain the canonical contract: every public primitive carries its import path, signature and JSDoc example, surfaced by your editor. Nothing about the runtime API changed.

  The scaffolded agent context still ships, unchanged, under `claude-template/`.

- 4556488: **`local.sessionDir` replaces `local.baseDir`** (#301). "Base directory" read as the directory the agent works in, in an interface whose `cwd` is the option that actually means that — so `baseDir: "./"` ran without error and wrote session transcripts into the caller's repository root. `baseDir` still works and still resolves to the same place; it emits a deprecation diagnostic, and `sessionDir` wins if both are set.

  **`isValidTaskId` and `TASK_RESERVED_PREFIXES` now exist at runtime** (#279). The bundled `.d.ts` had declared both as values since 4.51.1 while `dist/index.js` exported neither, so `import { isValidTaskId } from "@theokit/sdk"` typechecked clean and threw at the call site.

  **Thirteen `@theokit/sdk/persistence`, `@theokit/sdk/path-safety` and `@theokit/sdk/mcp-auth` symbols now arrive typed** (#280). Those re-exports resolved to no declaration at all, because each symbol carried `@internal` and `stripInternal` deletes it — while the public barrel went on naming it. They imported and ran, untyped: `atomicWriteText` in particular hid that it is `async`, so a caller could skip the `await` and watch a write report success before the bytes landed.

  **`OTelSpan` and `TelemetryHandle` are exported** from the root entry. Types only; nothing is added to the bundle.

- 566615c: BREAKING: `npx theokit-init-claude` and the bundled `claude-template/` are gone. The
  agent skills they scaffolded now live in [`@theokit/skills`](https://www.npmjs.com/package/@theokit/skills):

  ```bash
  npx @theokit/skills
  ```

  The thirty per-module skills were authored here and copied into that package by a sync
  script, so they existed twice and the copy was the worse of the two — the script
  stripped YAML frontmatter, and the frontmatter is where the `paths:` globs live that
  make a skill load only when you are editing something it covers. They are authored
  there now, with the globs intact.

  Three things a consumer gets that the old scaffold did not offer. It installs for
  every tool rather than Claude Code alone: `.agents/skills/` is read by OpenAI Codex,
  Gemini CLI, GitHub Copilot, Zed and Devin Desktop, and `.claude/skills/` by Claude
  Code. It links instead of copying when it is a real dependency, so the skills follow
  your lockfile rather than freezing at scaffold time. And `--check` fails in CI when
  what is installed has drifted, which is the only thing that stops an instruction file
  from quietly going stale — a stale one is followed exactly as diligently as a current
  one.

  The SDK tarball drops 328 KB. Nothing in `dist/` referenced the template; it was
  scaffold material, never runtime.

- 4397a90: `Theokit.subscribe` accepts an injected `fetch` and `WebSocket`.

  Both were read off `globalThis` at call time, so the only way to exercise the SSE or WebSocket path —
  in our own tests or in a consumer's — was to replace a global for the duration of the call. That is a
  process-wide mutation to test one function, and it makes the transports untestable in any environment
  where patching globals is not acceptable: a worker, a sandbox, an embedded runtime, or a suite running
  files in parallel.

  `SubscribeOptions` now takes optional `fetch` and `WebSocket`, each falling back to the global when
  absent, so existing callers are unaffected. The SSE path, the WebSocket path and the automatic
  transport selection all resolve through the same seam.

  One case still requires replacing the global rather than injecting: asserting the error a caller gets
  when no `WebSocket` exists at all. Node 22 ships a real global `WebSocket`, and a fallback cannot
  express absence — only removal can. That single test says so where it stands.

- 7c7b21a: `theokit init` gains four templates — `chatbot`, `multi-agent`, `rag-agent` and
  `workflow-automation` — and its `telegram-bot` template now installs and
  compiles. It imported `createAgentFactory`, which the SE36 rename replaced with
  `AgentFactory.create`, and pinned `@theokit/gateway` to the SDK's own version, so
  a scaffolded project failed at `pnpm install` before any code ran.

  `@theokit/cli` exports the `eval.config.ts` contract its README tells you to use:
  `EvalConfig`, `DatasetEntry`, `Scorer` and `Score`.

  `@theokit/sdk` exports `Workflow`, `fn` and `agentStep` from the package root.
  `CronCreateOptions.workflow` types against the copy in the cron chunk, while the
  `./workflow` subpath emits its own declaration of the same class — so a workflow
  built the documented way was rejected by `Cron.create` on a private-field
  mismatch. Importing both from the root now gives one identity.

### Patch Changes

- 1cb6607: Adding a published sub-entry to the SDK now fails fast and names every file still missing, and the
  ACP smoke test actually sends the request its name promises.

  Thirty-four sub-entries are published, and adding one required editing four files that nothing forced
  to agree: the package's `exports`, the bundler's entry list, the declaration-build include, and the
  declaration-mirroring script's target list. Only the first omission failed quickly. Skipping the last
  two broke nothing visible — output was emitted, typechecking passed, the whole suite passed — and the
  only gate that noticed ran at pre-push, about ten minutes in, where the error surfaces on whoever
  pushes next rather than on whoever caused it. A consistency check now derives the expected set from
  `exports`, the file that decides what is actually published, and reports every place that disagrees.
  It runs at the front of the validation chain, not at the end of it.

  Separately, the ACP smoke test was named for initializing a session, prompting, cancelling and
  shutting down, and its docblock promised a response with a stop reason. It never sent a prompt. Two
  defects in one: a name that tells the reader a path is covered, and a real gap on the protocol's main
  path. It now sends the request over the wire and asserts the stop reason it gets back — verified by
  mutating the handler to return a different reason and watching the test fail.

- 034da4d: A model id could stall the process for minutes. The Anthropic price lookup normalised dots with
  `/(\d+)\.(\d+)/g`, which on a long run of digits containing no dot consumes to the end of the
  string at every start position and backtracks — quadratic in a value the caller supplies.

  Measured: 12,500 digits took 762 ms; 25,000 took 3 seconds; 200,000 took **154 seconds** with one
  CPU pinned. For an SDK built to run inside a server handling other people's requests, that is a
  denial of service reachable from a single field.

  The same input now takes about 4 milliseconds. The pattern matches one dot between two digits
  using lookarounds, so there is nothing for the engine to backtrack over.

  One behaviour difference, and it is checked rather than assumed: a model id with two dots between
  digits (`1.2.3`) normalised to `1-2.3` before and `1-2-3` now, because the old pattern swallowed
  the middle digit into its first match. No id in the provider catalog has two — measured across all
  34, of which 14 have exactly one.

  Separately, reading a transcript's tail called `statSync(path)` and then `openSync(path)`, and the
  size from the first call drove every read offset against the descriptor from the second. It now
  sizes the descriptor it reads.

- 803e3ef: `MessageBus.send` discarded the handler's promise. `MessageHandler` may return one and `request`
  awaits it; only `send` dropped it, so a rejecting handler became an unhandled rejection — fatal
  under Node's default `--unhandled-rejections=throw` — while `await bus.send(...)` resolved cleanly
  and the sender learned nothing.

  Fire-and-forget means the sender does not wait for the result. It does not mean nobody is told when
  delivery fails. The rejection is now caught and reported, naming the target agent and the reason,
  and `send` stays non-blocking.

  `AgentMailbox.send` forwards into this path and is fixed with it.

- ce6a591: Fix `ReferenceError: process is not defined` in the browser, which blanked every page of any app built on `theokit@0.48.x` (usetheokit/theokit#317).

  `errors.ts` is imported by the client bindings framework consumers ship to the front end, and it pulls in the redaction and retry modules with it. Two of them read a bare `process.env` — one at module scope, in `internal/security/redact.ts` — so the read threw while the module graph was still evaluating, before a single component rendered. The page went blank with one console error naming no cause.

  Environment reads on that path now go through `readEnv()`, which resolves `globalThis.process?.env?.[name]`: unchanged on the server, `undefined` in a browser, and still replaced at build time by bundlers that inline `process.env.X`. Redaction stays **enabled** when the flag cannot be read, since unreadable must mean unset rather than disabled.

  `diagFailure` no longer relies on a `try/catch` swallowing the same ReferenceError to reach its fallback.

  `tests/security/browser-safe-env.test.ts` walks the import graph reachable from `errors.ts` and fails on any bare `process` in it — a stronger guard than the two modules that happened to break this time.

- aea04f4: Fifteen tests that quietly reported success on machines missing a native dependency now report as
  skipped.

  Each was shaped `if (!(await probe())) return;` as the first line of the test body. A guard written
  that way returns before any assertion runs, and the runner counts the case as passed — so a machine
  without `better-sqlite3`, without the vector stack, or running as root was indistinguishable from one
  where every assertion held. The skip was invisible in the count, which is the only place anyone would
  have looked.

  Measured on the same six guards in one package, forced on:

  ```
  old shape   31 passed,  0 skipped
  new shape   25 passed,  6 skipped
  ```

  Across all three packages the conversion moves fifteen cases from a silent pass to a reported skip.

  A full triage of every occurrence of this shape was done before changing anything, because the shape
  alone does not identify the defect. Of thirty-three occurrences, fifteen were silent skips; the other
  eighteen are legitimate and untouched — seven are type narrowings placed immediately after an
  assertion that has already reported the failure, and eleven are ordinary control flow inside
  callbacks, loops and handlers.

- 1471fd7: The `tests/chaos` and `tests/load` families no longer report resilience coverage they do not have.

  Every file in both directories exercised `node:fs`, `node:http` and `node:child_process` without
  importing a single line of SDK source, and two of their assertions could not fail at all:
  `result.code !== undefined || result.signal !== null` is always true when `code` is `number | null`,
  and `typeof process.uptime === "function"` cannot be false in a process alive enough to run the
  assertion. The directory names promised that OOM, SIGKILL-mid-stream, filesystem partition and
  generator leaks were covered against the product. They were not.

  The OOM test now asserts what it observes: that the heap-capped child aborts rather than exiting
  cleanly, and that its allocation loop never printed `survived`. Measured — V8's out-of-memory is a
  fatal process abort, not a catchable exception, so the child's own `catch`/`exit(7)` never runs and
  the assertion does not pretend otherwise. Verified to go red when the heap cap is raised so the child
  survives.

  The generator-leak test is rewritten against real SDK code. It previously asked
  `FinalizationRegistry` whether a generator had been collected, behind a `globalThis.gc` guard nothing
  in the repository satisfied, so it reported a pass without executing its assertion for its entire
  life; supplying the flag makes it fail, and no window can fix that, because the specification gives
  `FinalizationRegistry` no timing guarantee at all. It now asserts cleanup through the task event
  stream's own subscriber count — deterministic, no GC and no timers — and it is verified by mutation:
  removing the iterator's `return()` turns it red.

  That rewrite also corrects the premise it was built on. Breaking out of a `for await` loop does not
  leak a generator; the iteration protocol calls `.return()` on your behalf, on `break` and on `throw`
  alike. Only an iterator taken by hand and abandoned escapes cleanup, and that is the shape now
  asserted.

  The scaffolds that remain unwired each carry a todo naming the SDK path they stand in for, an owner
  and a sunset date, and each directory carries a README stating plainly what it does and does not
  cover.

- 521f8c7: A disposed `CloudAgent` now refuses `send()`, as `LocalAgent` already did.

  `CloudAgent` tracked a `disposed` flag but consulted it only to make `dispose()` idempotent — `send()`
  never checked it. So after disposing a cloud agent, sending still started a real run and resolved with
  a live `CloudRun`, while the identical call on a local agent rejected. A caller reaching a torn-down
  handle through a stale reference, a retry, or an `await using` scope that had already exited got work
  started on an agent they believed was released.

  `send()` now throws `AgentDisposedError` (code `agent_disposed`) before constructing anything, matching
  `LocalAgent`. `dispose()` keeps its own idempotence, so `await using` double-dispatch is unaffected.

  Thrown rather than returned as a failed run: the error is not retryable and a disposed handle never
  becomes un-disposed, so a rejected run would invite retry loops around a condition that cannot clear.

- d0c800c: A real cloud run now reports a `RunStatus` the public type actually declares
  (#341). The SSE transport cast the server's terminal token straight into
  `RunStatus`, and the server sends `FINISHED` while `RunStatus` is lowercase — so
  `result.status === "finished"` never fired on a successful cloud run, and
  `throwOnError`, which keys on `"error"`, never fired on a failed one. Silently,
  on the primary cloud path.

  Server tokens are now mapped case-insensitively onto `RunStatus`, and an
  unrecognised one fails the run with an actionable message instead of defaulting
  to `"finished"`. `EXPIRED` settles as `"error"`: a run that expired did not
  finish. The wire-level `SDKStatusMessage.status` stays uppercase — that is its
  declared union — but is validated rather than cast.

- 969b36e: `Cron.create()` now accepts zero-padded fields and refuses malformed ranges, matching the scheduler
  that actually runs the job.

  The validator parsed each field shape differently. Literals and steps carried a `String(n) === field`
  round-trip; ranges did not. So `"5abc * * * *"` was refused while `"1-5abc * * * *"` was accepted —
  the same malformed input, two answers, decided by which shape the user happened to write it in. The
  accepted ones did not become working jobs: they were refused later by croner at fire time, where the
  failure is a scheduling error nobody is watching rather than a rejected call the caller can fix.

  The round-trip also refused `"07 * * * *"`, because `String(7) !== "07"`. Measured against croner 9,
  the scheduler this SDK fires jobs with: it accepts `"07 * * * *"` and fires it at :07, accepts
  `"01-05"` and `"*/05"`, and refuses `"5abc"`, `"1-5abc"`, `"1abc-5"`, `"0x5"`, `"5.9"`, `"+5"` and
  `"1e1"` as illegal characters. Validating stricter than the engine rejects schedules that would have
  run correctly; validating looser only defers the failure. Both directions were wrong, in different
  field shapes, for the same reason.

  One digits-only predicate now decides every shape, reproducing croner's answer on each case above.
  Zero-padded expressions that were previously rejected are accepted; malformed ranges that were
  previously accepted are rejected at `Cron.create()` with `ConfigurationError` / `invalid_cron`, which
  is where the caller can still do something about it.

  Also removes a defensive branch in the same validator that no caller could reach: its only caller ran
  with exactly five fields against a five-entry table, so the "field index out of range" guard stayed at
  zero executions through 37 tests written specifically to enter it.

- ba8ebeb: Remove four unused internal exports surfaced once the dead-code gate stopped
  skipping `src/internal/` — `isSqliteVecLoaded`, `listNotes` (with its `NoteFile`
  type), `MemoryFileEntry`, and the derived `SpanName` union. None had a caller;
  all four lived behind `@internal`, so no public export changes.

  Two docblocks corrected in the process. `session-loader` claimed to return
  `MemoryFileEntry`-shaped records against a two-field type where the interface had
  four, with the path field named differently. `span-names` described the removed
  union as the mechanism preventing span-name drift; the `as const` map is what
  does that, and emitters read keys off it.

  The HITL approval middleware is now documented as not wired — it is constructed
  nowhere outside its own test file — with the timeout-versus-denial semantics
  pinned by characterization tests. Behaviour unchanged.

- d610c2a: Device login now reports a non-JSON response as a typed error instead of a raw `SyntaxError`.

  Every failure in the OAuth device flows is supposed to reach the caller as an `AuthCallbackError`
  carrying a code the CLI can branch on. Three of the four entry points broke that contract: they
  parsed the response with `res.json()`, so an endpoint answering with HTML — a captive portal, a
  corporate proxy's sign-in page, a load balancer's error page — rejected with a `SyntaxError` that no
  `catch` in the module handled. It escaped untyped past callers prepared only for `AuthCallbackError`.

  Affected: `requestDeviceCode`, `requestOpenAIUsercode`, and the two-step poll inside
  `openaiDeviceLogin`. The RFC 8628 poll loop was already safe and is unchanged.

  The message now quotes the body (truncated), because "not JSON" and "not JSON, and it looks like a
  proxy login page" are different diagnoses for whoever is holding the terminal — and sending someone
  to debug the provider when the fault is their own network is the expensive kind of wrong.

- e3f2a82: Public-API documentation reviewed file by file, and corrected wherever it disagreed
  with the code. The docblocks ship in the `.d.ts`, so these read as behaviour changes
  in an editor even though no behaviour changed.

  The corrections that change what a caller would do:

  - **`sdk-cache` documented its own premise backwards.** The header example labelled a
    semantic hit as if it avoided the provider call. `asPlugin()` returns the cached
    answer as `recalledContext`, which the agent loop injects as a `<memory-context>`
    block _before_ the prompt — the request still goes to the provider. The two modes
    are now labelled separately, with a table saying which one short-circuits and which
    one seeds.
  - **`sdk-handoff`'s five error classes said "throw".** Under the plugin wiring the
    handler never throws; every failure becomes a tool result `{"ok":false,…}` handed
    back to the model. Each class now says where it is actually observable. The header
    also told readers to `import { Handoff } from "@theokit/sdk"`, from which it was
    extracted.
  - **`sdk-budget`'s `charge()` claimed idempotency across concurrent calls.** The mutex
    serialises, it does not deduplicate: two identical calls record twice. Related, and
    newly documented: with `maxUsd` set, a model missing from the pricing table denies
    every request rather than passing it — and the table matches by exact string, so
    `"openai/gpt-4o"` does not match `"gpt-4o"`.
  - **The three `memory-*` adapters advertised an env-var fallback they do not read**,
    and their peer dependencies are required rather than optional. Their behavioural
    differences are now stated where they break the "interchangeable adapter"
    assumption — honcho ignores `k` and always throws on `delete`; mem0 recalls across
    sessions by design; supermemory ignores `sessionId` entirely.
  - **`sdk-memory`'s `truncated` flag was documented as its own inverse**, and its
    dreaming sweep claimed a mutex it never takes against the writer it names.
  - **`sdk-tools`** corrected `run_vitest`'s unreachable `no_vitest` code, `truncation`'s
    replacement-character claim, and two return shapes missing a live error code.
  - **`acp`/`cli`** corrected sixteen statements including a named error class that is
    not the one raised, a handler documented as calling `fork()` that refuses
    unconditionally, handlers described as pure that mint ids and mutate a store, a
    config loader credited to Zod in a package that does not import it, and a `--force`
    scaffold described as atomic that deletes the destination before the rename.

  Undocumented public symbols were documented across every package, with each claim
  checked against the implementation rather than inferred from the name.

- e368fc1: Every published declaration file now compiles without `skipLibCheck` (#345). The
  DTS rollup emitted symbols as a re-export from a chunk while omitting them from
  that chunk's `import`, and dropped type-only imports from external packages —
  leaving 51 unresolved references across ten of the twelve packages. Nothing broke
  at runtime, and `tsc` stayed green for anyone with `skipLibCheck` on, but a
  consumer running type-aware lint saw every type reached through one degrade to
  `error`.

  The declarations are repaired at build time from the compiler's own diagnostics.
  No source or API change.

- 3ac2b08: `LiveAgentRegistry` is no longer offered as a constructible value by the published
  declaration. The source exports it type-only — the runtime singleton is reached
  via `Agent.registry` — but the DTS rollup emitted `declare class` and re-exported
  it as a value, while `dist/index.js` never exported it at all. A consumer writing
  `new LiveAgentRegistry()` typechecked and failed at runtime.
- 29ebaa1: Three places where a value was reported that nobody had actually selected.

  **An empty `POSTHOG_API_KEY` no longer masks a valid `POSTHOG_PROJECT_API_KEY`.** The adapter read
  `POSTHOG_API_KEY ?? POSTHOG_PROJECT_API_KEY`, and `??` treats `""` as present. Leaving a variable
  blank in a `.env` or a CI config is the ordinary way to say "unset", so a blank primary key silently
  disabled telemetry while a working key sat in the sibling variable — and telemetry going quiet is the
  one failure that reports itself as nothing at all. Empty and whitespace-only values now fall through.
  The same trap on `POSTHOG_HOST` is closed with it.

  **The provider inspector reports the model the route resolves to.** `extractModelName` documented
  itself as surfacing the name from the prefix split and instead returned a hard-coded default, so a
  route configured as `anthropic:claude-opus-4` with no explicit `route.model` reported
  `claude-3-7-sonnet`. That field exists to let a caller confirm which model a route resolves to; a
  wrong answer there is worse than no answer, because it is indistinguishable from a right one. The
  name is now derived from the model id the route actually carries, and the default-model lookup that
  produced the literal is deleted rather than left as a decoy.

  **An errored ACP run no longer reaches the client as `end_turn`.** The stop-reason mapping fell
  through to `end_turn` for any run status it did not recognise, so a failure was reported over the
  wire as an ordinary completed turn — invisible to every ACP client, which is the swallowed-error
  shape the project's error-handling rules forbid by name. The protocol's `StopReason` has no error
  value, so an unmapped status now surfaces through the JSON-RPC error channel the handler already uses
  for every other failure, with a message naming the status that was not mapped. A dead branch
  returning `end_turn` twice is removed in the same pass.

- 0bc18f6: Adds negative-case tests over two modules whose typed errors were never entered by any test.

  A sweep of the SDK found 340 `throw new *Error` sites with roughly a third never executed. The error
  hierarchy exists so callers can branch on a typed code, and the project's own testing rule requires a
  negative case to assert the specific error and message rather than merely that something threw — so
  an untested throw site is a contract nobody has checked.

  The hook-source loader is now fully covered on its failure paths: an unreadable hooks file, malformed
  JSON, a non-object root, a non-array event group, and an invalid command shape. Each asserts the
  class, the code and a message substring. One pre-existing test that asserted only
  `.rejects.toThrow(/hook/i)` is upgraded to the same standard — matching a regular expression against
  a message is not the same as identifying which guard fired.

  Agent-helper resolution gains the same treatment on four of its five uncovered throw sites. The
  fifth is left untested on purpose and recorded: its condition cannot be false for any caller, because
  a sibling predicate that feeds it returns a constant. Writing a test for it would require mocking
  that predicate away in order to reach a line real callers cannot, which is the decoy pattern this
  project has already removed three times.

- b5b5e77: `humanizeModelName` stripped trailing slashes with a pattern that backtracks. On a model id ending
  in a long run of slashes, the engine consumed to the end of the string at every start position:
  25,000 slashes took half a second, 100,000 took **31 seconds** with one CPU pinned — to render a
  label.

  The trim is now a single linear pass. Behaviour is unchanged: a trailing slash is still stripped,
  several are still stripped, and an id without one is untouched.

- 14ccb69: A run that exhausts its iteration budget now says so (#338 item 4). It reported
  `status: "error"` with an empty result and no error detail — byte-for-byte the
  shape a provider rejection produces, so a caller could not tell "the model ran out
  of turns" from "the provider refused the request". `RunResult.error` now carries
  `code: "iteration_limit_reached"`, the limit that was hit, and the name of the
  option that raises it.

  `LocalOptions` documents two behaviours that were reported as surprises: a `shell`
  tool is registered on every local agent even when you pass `tools: []`, and a
  finished run writes a transcript with the full prompt and reply to
  `.theokit/memory/sessions/` under the workspace. Behaviour unchanged; both now
  appear where a consumer meets them.

- fbf6721: Remove three unused error classes from the internal iteration-budget module
  (`IterationBudgetExhaustedError`, `CompressionExhaustedError`,
  `CompressionIneffectiveError`). They were never thrown: the budget reports
  exhaustion by return value (`recordCompression()` answers
  `{ allowed: false, reason }`), which is the shape the agent loop actually reads.
  They were left over from an earlier exception-based design and advertised a
  contract the module does not honour. No public export changes — all three lived
  behind `@internal`.
- 240ae12: `LocalSandbox` now appends the `...(truncated)` marker when a command's output exceeds
  `maxOutputBytes`, as `ExecuteResult` has always documented.

  Node caps `execFile`'s buffer AT `maxBuffer`, so for ASCII output the string came back exactly at
  the cap — never _greater_ — and the length test that gated the marker never fired. Callers were
  told to branch on a marker that was never written, and every derived helper (`readFile`, `glob`,
  `grep`, `listDir`) returned a silent prefix. Since a cut command reports `exitCode: 1` like any
  other failure, the marker is the only thing that distinguishes lost output from a failed command.

  `LinuxSandbox` routes through the same `execute` and is fixed with it.

- da98560: A malformed API key for a named provider is now refused when the agent is created, instead of failing
  later wherever the key is first used.

  The strict shape check existed and could never run. Deciding whether a key was headed for a provider
  reused the predicate that decides whether a local runtime is available — and that one always answers
  yes, because the SDK ships a local provider as a builtin. So the answer was no for every possible
  input: the strict branch and the provider-prefix check were unreachable, and a key that could not
  possibly work was accepted at the boundary.

  The two questions are now answered separately. Whether to drive the real local runtime is still
  decided where it always was. Whether a key reaches a provider that authenticates with it is decided by
  that provider's own declared authentication type, so a provider that ignores keys entirely — the local
  ones — accepts any shape, exactly as before.

  Both unknowns stay permissive on purpose: an unrecognised model identifier or an unregistered provider
  skips strictness. Rejecting a valid key blocks someone outright, while accepting a malformed one for a
  provider we cannot identify only restores the previous behaviour for that case.

  **This can newly reject keys that previously reached agent creation.** A short placeholder key paired
  with a real provider prefix is the case to look for — two test suites in this repository were relying
  on exactly that. Keys for local providers, fixture keys, and any setup with a base-URL override are
  unaffected.

  Also removes an authentication error that could not be raised: its condition depended on the same
  always-true predicate, and the check that now does its job is the strict one above.

- 510ee70: The MCP OAuth token store now honours `THEOKIT_HOME`. When the variable is set, the store lives at `$THEOKIT_HOME/mcp-tokens.json`; when it is not, it stays exactly where it was, at `~/.theokit/mcp-tokens.json`.

  `internal/mcp/token-storage.ts` was the only module on the credential path that ignored the variable this SDK isolates state with, and the consequence was not confined to configuration preference. `vitest.setup.ts` isolates every test in `@theokit/sdk` by pointing `THEOKIT_HOME` at a fresh tmpdir; it backs `HOME` up and never sets it. A home-anchored module that ignored `THEOKIT_HOME` therefore resolved to the developer's real `~` while the suite believed it was isolated — and it did resolve there: a default-config run of the suite deposited four refresh-token entries (`test-srv`, `srv-2`, `srv-race`, `srv-roundtrip`) into `~/.theokit/mcp-tokens.json` at mode 0600, written by the OAuth golden tests. Every key in that file was verified to be a test fixture rather than a real credential, and this predates the per-call path resolution shipped earlier — the old module constant resolved to the same real home.

  A suite that is wrong about its own isolation is a false green about the property the rest of its greens rest on, which is why this shipped as a defect rather than as a preference.

  **This is the code catching up to a contract the SDK already published, not a new policy.** `src/project-env.ts:47-49` documents `THEOKIT_HOME` as _"Locates the SDK home — sessions, and the credential store beneath it"_, and lists it as a sovereign key precisely because it governs where credentials live. The public contract already said the token store sits under the variable. This module was the half that disagreed, so what changes here is not the promise — it is the code finally keeping it.

  **The resolver adopted is `transcriptRoot()`'s, not `getTheokitHome(cwd)`'s.** The transcript is the sibling with the matching shape: home-anchored default, `THEOKIT_HOME` override, trimmed and empty-guarded — and its own docstring records that before M94 it ignored the variable, so "whoever set it had their state split in two silently", which is this defect verbatim. M94 ADR-2 already accepted that migration for identically-shaped state. `getTheokitHome(cwd)` falls back to `<cwd>/.theokit` instead, so adopting it would have moved the token file of everyone who does **not** set the variable — and to a _different place per working directory_, making whether you are logged in a property of which folder you launched from. That is a regression for every user, not a migration.

  **The migration this does carry, stated rather than buried.** A user who already holds `~/.theokit/mcp-tokens.json` **and** sets `THEOKIT_HOME` stops seeing those tokens: `getTokens` returns `undefined`, the caller surfaces it as "not logged in", and the OAuth flow re-runs. Nothing is deleted and nothing is overwritten — the old file stays where it is and is found again the moment the variable is unset. No migration step is performed on the user's behalf, because silently relocating a credential file is a worse failure than a re-auth, and a store that moved a token without being asked would be indistinguishable from one that lost it. Users who do not set `THEOKIT_HOME` — the default — see no change at all.

  **Two further consequences for those who do set it**, both on the directory-permission path rather than on path resolution.

  The store no longer re-permissions a `THEOKIT_HOME` it did not create. `ensurePrivateStoreDir` chmods the store directory 0700, and that was written unconditional on purpose: `mkdir`'s mode applies only at creation, so a machine that ran an older build already has a loose `~/.theokit`, and a fix reaching only fresh installs misses the population that has the problem. But that reasoning names its own population — directories _this SDK_ created. Once `THEOKIT_HOME` is honoured, an unconditional chmod also reaches a root the operator chose and shares with sessions, transcripts, personality and credential-pool state, which `paths.ts` documents as a multi-tenant deployment knob and which no other consumer of the variable imposes a mode on. Measured: it silently demoted a 0775 `$THEOKIT_HOME` to 0700. The retro-fix now keeps its population and loses the one it never had; a directory the SDK creates is still born 0700 wherever it points.

  The consequence of not repairing it is that `getTokens` **refuses** — a typed `CredentialError` naming the directory and the `chmod 700` that fixes it — rather than returning `undefined`, when `$THEOKIT_HOME` is group- or world-writable. That is the intended end state, and the two alternatives are worse: silently tightening the operator's root breaks a deployment to protect them from a choice they may have made deliberately, and silently returning the token hands the caller a refresh token that any local user could already have swapped. One asymmetry is left unfixed and is not hidden: the write path has no matching gate, so `setTokens` writes into such a directory and the next `getTokens` refuses it.

  An empty or whitespace-only `THEOKIT_HOME` falls through to the home-anchored default. That guard is load-bearing in a way the sibling `HOME` guard is not: without it, `THEOKIT_HOME=""` resolves the store to a **cwd-relative** `mcp-tokens.json` and `THEOKIT_HOME="   "` to a directory literally named three spaces. Neither falls back to anything — both are new locations invented from an unusable value.

  Pinned in both directions, per `rules/testing.md § 4.2`: one test asserts the store follows the override and leaves the home default untouched, one asserts the read path looks there too (the file is placed by hand rather than through `setTokens`, so a roundtrip cannot pass by having both halves agree on the wrong path), and two assert that an unusable value leaves the home default in place. Verified by mutation, six mutants and six deaths: removing the override branch, relaxing the empty guard, dropping the `.trim()`, hard-coding the old path back into the warning, chmodding unconditionally, and dropping the chmod entirely each kill a test named for the property it breaks. A seventh — guarding the chmod on "we just created it" as well — killed nothing, because a umask only clears bits and 0700 carries none in the group/other range, so `mkdir(0700)` is private under every umask. That clause was deleted rather than pinned with a test written to justify it.

  The keytar-absent fallback warning now names the **resolved** store path instead of the literal `~/.theokit/mcp-tokens.json`. That literal was correct until this change; afterwards it would have sent anyone who sets `THEOKIT_HOME` to look at a file the store no longer writes, and a diagnostic that names the wrong location costs more than one that names none — the reader stops looking once they find it empty.

- 1362583: The MCP OAuth token store now resolves its path when an operation runs — reading the same environment variable `os.homedir()` reads on that platform (`USERPROFILE` on Windows, `HOME` elsewhere), with `os.homedir()` itself as the fallback — instead of binding a path once when the module is first imported.

  `internal/mcp/token-storage.ts` held `const FILE_PATH = join(homedir(), ".theokit", "mcp-tokens.json")` at module scope. A constant at module scope captures ambient global state at import, so the store kept reading and writing under whichever `HOME` was set at that moment and never noticed a later change. It made the module's correctness a property of _when_ it was imported, which is not a property a credential store should have.

  Reading the environment first is not a stylistic preference, and **the variable read is per platform because `os.homedir()` itself is**: on POSIX it prefers `$HOME`, on Windows it reads `USERPROFILE` and never consults `HOME`. Mirroring that split keeps this a binding-time fix rather than a behaviour change. In a normal process on either platform the resolved path is identical to what shipped before.

  They diverge in exactly one place — inside a worker thread, `process.env` is a JS-level copy while `os.homedir()` is a native call reading the real process environment, so a home moved inside a worker is invisible to `homedir()`.

  An empty or whitespace-only value falls through to `homedir()`. Being precise about what that buys, because an earlier draft of this note overstated it: on POSIX it is close to a no-op, since `homedir()` returns the same empty value, and an empty home resolves the store to a CWD-relative `.theokit/mcp-tokens.json` either way. It earns its place on Windows and for a worker whose environment copy was blanked.

  **The Windows OS is untested; the platform branch is not.** Every POSIX-mode test in `mcp-token-store-modes.test.ts` is guarded by `it.skipIf(!POSIX)` so it does not run on Windows, and CI runs ubuntu only, so nothing here exercises real Windows chmod semantics or libuv's `USERPROFILE` lookup. The branch SELECTION does run everywhere: one test spies `process.platform` and asserts the store follows `USERPROFILE` rather than `HOME`. The split itself is reasoned from `os.homedir()`'s documented per-platform source, not from a run on Windows.

  The path is resolved once per operation and passed down, including into the directory-permission step. Resolving it per use would let a read and the write that follows it disagree if `HOME` moved in between, or lock down one directory while the token lands in another.

  **Behaviour change, both directions.** A process that moves `HOME` after importing the SDK now has its tokens follow the new home. On the write path that is the safer reading — the alternative writes credentials to a location the caller no longer considers theirs. On the read path it has a cost worth naming: tokens stored under the previous home are no longer found, so `getTokens` returns `undefined` and the caller sees "not logged in" rather than an error. Following the current home is still the right trade for a credential store, but it converts a stale-write risk into a silent-re-auth one, and both sides are stated here rather than only the favourable one.

  `THEOKIT_HOME` is deliberately not honoured by this store. `transcriptRoot()` does honour it and M94 ADR-2 accepted that migration for the sibling module; doing the same for credentials changes what existing token holders see, which is a product decision rather than a prerequisite for making this module independent of the execution model.

  Found while measuring whether mutation testing is viable on this package: the directory-permission tests passed only because `vitest.config.ts` pins the `forks` pool with `fileParallelism: false`. A tool that controls test execution refused to start against that baseline. The suite now carries a regression test that holds under the default config **and** under `--pool=threads`.

- 2cdadcc: The memory index's `LIKE` fallback — used when FTS5 cannot tokenise a query, which is the normal
  path for CJK text — escaped `%` and `_` but not the backslash that its own `ESCAPE '\'` clause
  depends on. A query containing a backslash produced a pattern where the inserted escape was
  consumed escaping the user's backslash, leaving the next wildcard live:

  ```
  search for   x\%y
  old pattern  %x\\%y%     the % is unescaped — matches anything between "x\" and "y"
  ```

  So a literal search silently became a scan, returning rows the caller never asked for. Escaping the
  backslash first fixes it, and the rule now lives in one function with the ordering argument written
  next to it.

  Separately, `ContextManager` called `stat()` on each source file and discarded the result before
  reading it. `readFile` already fails when the file is gone, so the extra lookup added nothing but a
  window in which the path could resolve to a different file between the two calls. It is gone.

- 1c94ad3: The "Missing API key" refusal now names the provider credential you actually have
  (#338 item 5). With `OPENROUTER_API_KEY` exported and `THEOKIT_API_KEY` unset,
  the old three-word message named neither — while the SDK consults that exact
  variable a moment later to decide whether to drive a real runtime, so the
  environment looks configured to whoever set it up. Reported as three hours of
  diagnosis on the wrong cause.

  Resolution is unchanged: a provider key is still not adopted from the
  environment, because with two of them exported there is no non-arbitrary answer
  to which one was meant. The message says where to put it instead. Names the
  variables, never their values.

- 3ad398d: `ModelSelection.url` names the endpoint a specific model lives at, and it was handed to every
  provider in a fallback chain. A fallback therefore inherited the primary's host and could never
  reach its own — so a configured failover silently retried the same dead endpoint instead of moving
  on.

  Measured against two servers with the primary refusing every request: with `model.url` set, the
  primary received 6 requests and the fallback 0. Pointing each provider with its own
  `*_API_BASE_URL` instead gave 3 and 1.

  The per-call URL now reaches only the provider the model id names. Each fallback resolves its own
  endpoint from its profile and its own `*_API_BASE_URL`, which is what makes a fallback a different
  destination rather than a retry.

- a8cf443: `ModelSelection.url` names the endpoint a call should reach, and it reached only two of the four
  transport branches. On `anthropic_messages`, `bedrock` and the Responses API it was silently
  dropped: a run explicitly aimed at a local host went to the vendor instead, with the caller's key,
  and nothing said so.

  Measured on the anthropic branch: the local server recorded zero requests and the run failed with
  `Anthropic API error: auth_failed (HTTP 401)` — a 401 from `api.anthropic.com`, after the caller
  had named a different host.

  All four branches now honour it, and it outranks the process-wide `*_API_BASE_URL` on each, which
  is the contract the field's own documentation states. Nothing changes when it is absent.

- aadc9dd: Seventeen more negative-case tests now identify which failure they caught, and a registry test suite
  stops sleeping to make timestamps differ.

  Most of those assertions turned out to be under-asserting rather than untestable: twelve of them sat
  on errors that were **already typed**, and simply checked that something threw. They now name the
  class, the stable code and a message fragment — which means a change that swaps one failure for
  another is caught, where before any error at all satisfied the test.

  Four remain matched on a message fragment because the underlying error genuinely has no type yet, and
  one of those is filed separately: a public entry point throwing a plain error gives callers nothing to
  branch on but a string that changes whenever someone improves the wording.

  Four more were reclassified out of scope after reading the source rather than the name: they raise
  errors owned by Node, by the schema library, or by a database driver, and pinning a third-party class
  buys little.

  Separately, the live-agent-registry tests slept thirteen times — some to force last-used timestamps
  apart so eviction ordering could be asserted, others to let fire-and-forget cleanup finish. Both are
  now driven by the test clock, a mechanism this same file already used elsewhere and which needed no
  production change. The file runs in a fraction of the time and no longer depends on how busy the
  machine is.

- a1cae95: Removes an unreachable `ollama` arm from the provider base-URL resolver. `OLLAMA_HOST` is unaffected
  and keeps working exactly as before.

  The router's base-URL env switch carried a `case "ollama"` returning `process.env.OLLAMA_HOST`. It
  never ran. Ollama is served by its own native client, which the transport selector returns before the
  OpenAI-compatible branch — the only place that switch is consulted — so the arm was unreachable from
  the first line of the function containing it. Measured two ways: line coverage over the router and
  provider suites puts the arm at 0 entries while all four siblings are entered, and a probe that
  replaced its body with a throw was never triggered by any test, plugin profile or alias.

  The one construction that could reach it is a provider profile whose `name` getter returns a
  different value on successive reads — a profile contradicting itself. Run against the old code, that
  path shows what the line actually did: it pointed the **OpenAI-compatible** transport at the Ollama
  host, producing `…/v1/chat/completions` against an Ollama daemon. That is the failure mode ADR D191
  exists to prevent — models emitting raw tool JSON as plain text. So this is not merely an inert line
  being tidied away; it is a latent bug being removed on the only path that reached it.

  The line also cost real time as a decoy: it reads exactly like the mechanism implementing
  `OLLAMA_HOST` and is not. A repair pass mutated it, measured a green suite, and concluded the real
  override was untested. The real one lives on the native branch and is now pinned by a test asserting
  that an ollama request reaches `/api/chat` at the configured host, so the routing this removal
  depends on cannot change unnoticed.

- 8226bc6: Fourteen negative-case tests now identify which guard fired, and a scheduled job keeps test-order
  independence honest.

  Assertions that only checked "something threw" now assert the error class, its stable code and a
  message substring — for concurrency validation, retry configuration, path traversal, filename
  validation and credential loading. Each conversion was verified by mutating the production error's
  code and watching the corresponding test fail, so the assertions are pinned to the real constants
  rather than to a copy of them.

  Forty-five remaining sites are deliberately left alone and grouped with reasons: ten raise validation
  errors owned by a third-party schema library, thirteen surface Node's own errors, and twenty-two are
  plain untyped errors in our code where there is no class or code to assert yet.

  Separately, the suite runs one file at a time, and a comment in the configuration said that was
  covering up a leak. Measured: with file-level parallelism restored the suite is fully green, twice
  over — the two leaks that comment named have since been fixed. Restoring _within-file_ concurrency
  plus randomised order does still fail, reproducibly, in one file that shares a mutable counter
  between its cases; that is filed on its own and is not fixed here.

  The default gate is unchanged. A separate weekly job runs the suite in shuffled order so the
  remaining coupling keeps surfacing instead of staying suppressed by the serial default.

  Also documented for contributors: what makes a wait trustworthy, and why a premise that justifies
  deleting something needs checking in a way that a premise justifying keeping something does not.

- e699569: **The repository moved to the official `usetheokit` organization.** Every `repository`, `bugs` and `homepage` field now points there, along with the README, `CONTRIBUTING.md`, `SECURITY.md` and the issue templates. Existing clones and any URL already published keep working — GitHub redirects a transferred repository permanently — so this is a correctness fix for the metadata npm renders, not a break.

  **The Apache-2.0 text every package ships was replaced with the official one.** The copy distributed until now had paragraph 4(d) truncated: it read "except as required for describing the origin of the Work and reproducing the content of the NOTICE file", dropping "reasonable and customary use" from the licensed clause. §4(d) governs what a redistributor must do with attribution notices, and the omission narrowed it.

  That matters more than a typo would. The manifests declare the SPDX identifier `Apache-2.0`, which is an assertion that the terms are _the_ Apache-2.0 terms — a licence scanner resolves the identifier and never reads the file. A consumer's compliance review, which does read the file, would find a body that no longer matches the identifier and has no name of its own. Every `LICENSE` in this repository is now byte-identical to the canonical text, with the appendix filled in.

  Nothing else about the terms changed: the licence is the same licence it has always been meant to be, and no package changes what it grants.

- 6950332: A `PermissionRule` argument matcher written as a predicate was invoked with `undefined` when the
  call supplied no such argument. The string and RegExp forms already treated a missing argument as
  "does not match"; the predicate branch returned before that guard.

  Both directions were wrong, and the first is a permission escape: an allow rule like
  `(v) => v !== "prod"` returns `true` for `undefined`, so a call that supplied nothing produced an
  explicit allow — a matcher written to narrow, widening. A deny rule like `(v) => v.includes("rm")`
  raised `TypeError` out of the permission gate instead of denying.

  A rule that declares an argument is a rule about that argument. A call that omitted it no longer
  satisfies the rule, whatever form the matcher takes.

- 9e6828e: When the API key's own prefix or an explicit `providers.routes` entry overrides the provider named
  in the model id, the SDK now says so once per process, naming both the provider asked for and the
  one used.

  The precedence itself is unchanged and deliberate: an explicitly-passed key is ground truth about
  which endpoint will actually be reached, so a `sk-or-` key beats an `openai/...` prefix. What was
  missing was the sentence. A caller writing `model: { id: "custom/model" }` and receiving
  `openai API error: auth_failed` had no way to learn their prefix had been overruled, because the
  error names only the winner.

  Nothing is emitted when the model id carries no prefix, or when the prefix is what was used.

- e3f2a82: Every symbol these packages declare in `exports` now reaches the `.d.ts` they publish.

  Sixty-six declarations across twenty-three published files did not compile, and four entry
  points silently omitted names their own barrel exports — `@theokit/sdk/internal/security`
  dropped seven at once. Runtime was never affected; this is types-only. A consumer with
  `skipLibCheck` on saw nothing, and a consumer running type-aware lint saw every type reached
  through one of them degrade to `error`.

  The cause was `stripInternal`, which deletes a declaration when the literal `@internal`
  appears in ANY leading comment range of it. The tag was being used here to mean "outside the
  semver contract" — `internal/persistence/sqlite-open.ts` said so in those words, on a subpath
  the manifest publishes and a back-compat test pins. The compiler reads it as "erase this", and
  the two meanings only diverge in the published artifact. It now says the semver exemption in
  prose, and the tag is gone from the symbols that are published.

  Two further mechanisms had the same cause and a wider blast radius. A tag in a BARREL header
  deleted the first `export … from` beneath it; a tag in a MODULE header deleted the following
  `import`, so `import { z } from "zod"` vanished and every type it bound became
  `Cannot find name`. Nothing was added to any `exports` map and no `export` line changed — a
  deleted import was never privacy, only a broken declaration.

  `@theokit/sdk-handoff`'s `./internal` entry left `SDKAgent` and `CustomTool` unbound, from a
  different defect: the declaration repair only ever looked at `exports["."]`, so it fixed each
  package's main entry and shipped the rest unrepaired. It now covers every declared subpath, and
  binds the side-effect import form (`import '@theokit/sdk';`) the rollup emits with the names
  stripped out.

  Three gates were widened or added so this cannot return silently: the declaration typecheck
  now covers all 45 published entries rather than 12, a new export-parity check fails when a
  source barrel exports a name the emit omits, and public-API documentation coverage is gated at
  100%.

  Two consequences worth naming rather than discovering. `coerceToKnownAgentRunErrorCode` — the
  boundary helper the 4.x release notes point at as the migration path off the open
  `AgentRunErrorCode` union — was tagged internal and therefore absent from the published types; it
  is now exported and documented, which is a small addition to the public surface. And
  `packages/sdk/typedoc.json` sets `excludeInternal: true`, so the generated API reference gains the
  ~57 symbols whose tags were removed. That is the intended direction: those symbols are published,
  and the reference now says so.

- ac08996: `sanitizeIdentifier` now reports every rejection as `ConfigurationError` with code
  `invalid_identifier`.

  It used to throw two classes and the input chose which: a NUL, C0 control char or DEL produced
  `PathTraversalError` (code `path_traversal`), everything else produced `invalid_identifier`. A
  caller branching on the documented code — the shape an HTTP handler uses to answer 400 — rethrew
  for exactly the input class an attacker controls, so a rejection surfaced as a 500 and the 400/500
  split became an oracle for which branch was reached. The input was rejected either way; this was
  never a traversal bypass.

  The message still names the offending byte (`<nul-byte>`, `<control-char-0x1f>`), which is the part
  the second class existed for. `@theokit/sdk/workflow` validates step ids through this function and
  inherits the fix.

- 96b28ba: Test-harness repairs: an unmeasurable socket probe now reports as skipped instead of passing, and a
  fixed sleep is replaced by polling the real value.

  The CLOSE_WAIT socket monitor returned a bare `null` when it could not measure — off Linux, or when
  `ss` was unavailable — and the caller treated that as a pass. An environment where the probe could
  not run was therefore indistinguishable from one where the assertion held. It now returns an explicit
  unavailable result with a reason, the caller reports the case as skipped and names that reason, and
  the assertion helper refuses an unavailable result rather than quietly doing nothing.

  The same test slept a fixed 500ms to let the operating system finish tearing sockets down. The OS
  decides that timing, not the test process, so the wait is now a poll against the real count with a
  deadline. The threshold moves to the value the harness's own docblock documents; the number at the
  call site had never matched it and never explained itself.

  A shared polling helper replaces three more fixed sleeps in the semaphore tests, where the queue
  depth is a real signal that can be waited on, and absorbs one hand-rolled poll loop that had already
  been written by hand elsewhere.

  Every change is verified by mutation rather than by construction: mutating the production semaphore's
  pending-count turns the converted tests red, and three mutants of the socket monitor each kill the
  test named for them.

  Honest limit, recorded in the test and tracked separately: the CLOSE_WAIT assertion still cannot
  detect a real leak. Removing the driver's own socket cleanup entirely leaves the count at zero,
  because Node completes the FIN handshake on its own and the fixture server closes idle sockets. This
  change makes the test honest about what it cannot measure; it does not give it detection power.

- f53ee6a: A stream cut mid-flight now delivers the text that already arrived, instead of dropping it.

  Measured on a 200-chunk answer severed just before its terminator: the provider sent 1490 characters
  and the consumer received none. Truncated streams are routine — proxy timeouts, load-balancer idle
  limits, mobile links — and every one of them turned a mostly-complete answer into nothing, the more
  so the longer the answer. The run is still reported as errored; what the caller gets back is the
  choice of whether a partial answer is usable.

  A body read that fails mid-stream is also routed through the transport-error mapper, so it reads
  `openai transport failure on /v1/chat/completions: terminated` and carries `code:
"transport_failure"` instead of undici's bare `terminated` with no code. `RunResult.usage` is
  documented as absent for such a run: the counts arrive with the terminating frame a severed
  connection never delivers.

- 1af99fa: `maxDelegationDepth` now bounds the delegation chain it always claimed to.

  The check ran once at tool-construction time against a `parentDepth` argument nothing in the SDK
  incremented, so under the documented `SubAgent.create(spec)` call it could never fire and a
  subagent whose tools include another subagent recursed unbounded. Depth is now counted at dispatch
  and travels with the run, so nesting is bounded without threading a counter by hand.

  A caller that does thread `parentDepth` keeps its existing behaviour — the threaded value offsets
  the chain depth, and an already-impossible spec is still refused at construction.

- 8f8d3eb: Breaking out of a subscription now closes the underlying connection instead of leaving it open.

  `Theokit.subscribe`'s SSE transport released its stream reader on exit but never cancelled it. Per
  the Streams specification those are different operations: releasing detaches the reader and leaves
  the stream — and therefore the `fetch` response and its socket — open until something else cancels it
  or reads it to completion. So the ordinary consumer shape, breaking out of the loop early, left a
  connection dangling every time. The WebSocket transport already closed its socket correctly; only the
  SSE half was affected.

  The reader is now cancelled on early exit, best-effort and skipped on natural completion, where the
  stream is already finished and cancelling would only risk surfacing a spurious rejection.

  This is the leak a load test in this repo has claimed to detect for some time and never could. That
  test drove raw sockets with no SDK code in the path at all, and passed whether or not anything
  cleaned up — measured by deleting its own cleanup call and watching the count stay at zero, twice.
  Its claim is now withdrawn in the test itself and in that directory's README, and the real property
  is asserted where the code actually lives: a test that drives the SSE and WebSocket transports
  through injected mocks, with no network and no operating-system probing, and that fails when either
  transport stops cleaning up.

  Also included: the plugin manager's seven manifest-validation errors now each have a test asserting
  the specific error class, code and message, plus cases each guard must accept — a guard tested only
  on what it rejects cannot be told apart from one that rejects everything.

- 883f473: Seventeen module docblocks that opened with `@theokit/...` are rewritten to open with a sentence.

  A JSDoc block whose first line begins with `@` has no description: TypeScript parses the whole block
  as that tag's value, so `getDocumentationComment()` returns nothing and editor tooltips, TypeDoc and
  this repo's doc-coverage instrument all report the symbol as undocumented while the source plainly
  documents it. The affected files are the `server/auth` and `subscription` surfaces; the same words
  now appear in an order the tooling can read.

  A new `quality:doc-tag-first` gate fails the build on the shape, so it cannot come back.

- 36e5879: The task-registry tests wait for the state they need instead of sleeping.

  Twelve waits in that suite were fixed sleeps between 10ms and 200ms, each chosen to be "long enough"
  for the registry's fire-and-forget work to reach a state. The state is observable — the registry can
  be asked for it — so the sleep was guessing at something the test could simply read. Under load those
  guesses stop being long enough, which is how a suite acquires flakes that only appear on a busy
  machine or a slow runner.

  Each now polls the real state with a deadline. A passing run is never slower than the sleep it
  replaced, because it returns the moment the state arrives; a state that genuinely never arrives fails
  with the state it was waiting for, rather than an assertion on stale data.

  The shared polling helper was widened to accept an asynchronous condition rather than growing a
  second near-identical copy for the case where the value has to be awaited.

- b68704b: `JsonFileTaskStore.list()` no longer hides tasks past the 256th file.

  The 256-entry cap was applied to the raw directory listing, before `state`, `kind` and the
  `submittedBefore` / `submittedAfter` window were considered — so past 256 task files the visible
  set was an arbitrary, readdir-ordered subset, `submittedBefore` narrowed within that subset instead
  of paging beyond it, and `evictTerminalOlderThan()` left eligible handles behind however many times
  it was called.

  The cap is now a bound on concurrent file reads, which is the cost it was meant to control, and
  results come back newest-first so `submittedBefore` works as a cursor. Eviction sweeps the whole
  directory: one call now means everything eligible is gone.

- 9ab1f0d: The test suite runs its files in parallel again.

  It had been pinned to one file at a time, with a comment explaining that the serialisation was holding
  back two leaks: tests mutating the home directory environment variable, and a process-wide registry
  accumulating entries across tests. Both were fixed elsewhere, and nobody went back to ask whether the
  constraint still had a reason. It did not — what actually prevents the home-directory race is that
  each file already gets its own subprocess, which is a separate setting and unchanged here.

  One genuine coupling had to be removed first: a contract test kept a file-level counter that three of
  its cases each expected a specific value from, which only holds if they run in declaration order. Each
  case now owns its own identifier, so nothing is shared to race over.

  Within-file concurrency stays capped at one, deliberately. The more aggressive configuration —
  concurrent cases plus randomised order — remains a separate periodic probe rather than part of the
  gate, and a test now pins that split so it cannot drift quietly.

- 464c390: Repairs four quality gates that were measuring something other than what they claimed.

  **The Portuguese-language lint no longer scans files git does not track.** It walked the tree with
  `readdir` and skipped only dot-directories, so it flagged untracked files CI never sees — going red
  on a developer's machine while CI stayed green — and simultaneously missed `.github/workflows/`,
  which CI very much does have. A red that CI cannot reproduce is what teaches people to reach for
  `--no-verify`. The scan is now driven by `git ls-files`, which fixes both halves at once: untracked
  files disappear by construction, and tracked dot-directories come into scope. Portuguese text the
  lint could not previously see in the CI workflow is translated as part of the change.

  **The pre-push Biome gate has the same repair.** `biome check .` walked everything on disk;
  `biome.json`'s `vcs.useIgnoreFile` skips gitignored files but not untracked-but-unignored ones, which
  is exactly the class that broke the gate. Measured: the tracked-only scan and the walk-everything
  scan process the same 1686 files on a clean tree, so scoping to tracked files costs no coverage.

  **The pre-commit typecheck no longer typechecks all fifteen packages on every commit.** It is scoped
  to the packages the diff actually touches, with a guard the item this came from insisted on: the run
  reports how many packages it selected, and a selection of zero fails loudly instead of exiting 0.
  That silent-zero case is real — a stale or unfetched ref makes the scoped filter select nothing while
  turbo reports success — and swapping an expensive honest gate for a cheap silent one would have
  reproduced the defect being repaired. The full unscoped verdict still runs at pre-push and in CI.

  **Dead Vitest 4 settings are removed rather than migrated.** The config carried a `poolOptions` block
  that Vitest 4 no longer reads, printing a deprecation warning on every run. Migrating those keys
  would not have revived the knob they configured: `fileParallelism: false` overwrites the worker count
  unconditionally, so the `SDK_TEST_MAX_FORKS` environment variable was inert by two independent paths.
  The block and the variable are deleted, `fileParallelism: false` is kept (test-order safety currently
  depends on it), and Vitest 4's actual replacement for the isolation setting is declared explicitly.

- c7385d2: Test runs no longer claim every core on the host.

  None of the package configs capped `maxWorkers`, so vitest's default applied: `os.availableParallelism()`,
  one fork per core, each booting a full test environment. The repo's `test` script is
  `turbo run test --filter='./packages/*'`, so that default is paid once per package _concurrently_ —
  nproc forks times turbo's concurrency, on nproc cores. Measured on a 12-thread machine during an
  unrelated investigation, two vitest pools alone were enough to reach load average 33.89 with the
  desktop unusable; a full fan-out is several times that.

  `@theokit/sdk` is the interesting case. B-104 recorded on 2026-08-19 that the `poolOptions.forks.*`
  block was 100% dead in Vitest 4, deleted it, and noted that `fileParallelism: false` was forcing
  `maxWorkers` to 1 unconditionally, so a fork-count knob could not act. B-059 then flipped
  `fileParallelism` to `true` on 2026-08-20, which made the knob able to act again — and nothing
  reintroduced one, so the package silently went back to the uncapped default. That comment has been
  corrected along with the config; it claimed no knob existed, which is no longer true.

  The cap leaves 4 cores free (`Math.max(2, cpus().length - 4)`), scaling with the runner rather than
  hard-coding one machine's core count. It costs no wall-clock: measured in `theokit-ui`, the full
  suite ran 73.96s at 4 workers against 74.36s at 12, so the parallelism above the cap was already
  noise. Verified as resolved config rather than as file contents — `createVitest` reports
  `maxWorkers: 8` on a 12-thread host, which is the formula, not the default.

  This changes no published behaviour; it is test tooling only. Refs usetheokit/theokit-ui#51.

- 9f5cc20: A test run can no longer write into the developer's real home directory.

  The shared test setup gave every test an isolated `THEOKIT_HOME` in a fresh temporary directory, and
  backed up `HOME` alongside it — but never actually set `HOME`. So any module reading `HOME` or
  `os.homedir()` directly, instead of consulting `THEOKIT_HOME`, resolved to the real home and wrote
  there. That was not hypothetical: the MCP token store did exactly this, and a real `~/.theokit`
  credential file was observed accumulating test fixtures and changing timestamps across an afternoon
  of runs.

  That one module was fixed previously. This closes the gap itself, so the next module that reads the
  home directory without going through `THEOKIT_HOME` cannot repeat it. Isolation is now enforced by
  the setup rather than by each module remembering, which is the difference between a property and a
  convention.

  Verified the way the problem was originally found: the golden MCP suite was run with `HOME` pointed
  at a throwaway sentinel directory, and nothing was written to it.

  Also included: the dependency-boundary check now cruises the test tree as well as the source tree,
  and the code-quality gate refuses to report success when it audited no languages at all — previously
  a gate with nothing enabled returned a pass, which is indistinguishable from a clean run.

- 5fac0f6: Test-suite hygiene: scratch directories are cleaned up, the working directory is no longer mutated
  process-wide, and the agent registry starts empty in every test.

  Fifty-nine test files created temporary directories and never removed them, so a full run left its
  debris behind on every machine that executed it. Each now removes its directory when the test
  finishes, through the same retry-hardened helper the workspace fixture already used — the retries
  matter because a directory holding a file another handle has open cannot be removed on the first
  attempt.

  Three tests changed the process's working directory to exercise code that reads it. `process.chdir`
  is process-wide, so a test doing that mutates the environment of every other test sharing the worker,
  and the two production paths involved hardcode the current directory with no override to pass. They
  now replace the reader rather than the process state. A lint test bans any future live `chdir` under
  the test tree, so this does not return for a fourth time.

  The agent registry is a process-wide map that does not follow the per-test home directory, so entries
  accumulated across tests and individual files had taken to clearing it by hand — which only works for
  the files that remember. It is now cleared by the shared setup, unconditionally.

  One test file was removed rather than repaired: it exercised a locally-declared copy of a concurrency
  helper instead of the real one, so nothing it asserted could fail when production changed. Its one
  genuinely distinct assertion — that three tasks overlap under a barrier — moved to a test that drives
  the real function, and was verified by stubbing that function to return nothing and watching four
  tests die.

- e685ccb: The model catalog was fetched with `res.text()` and written to the cache with no size limit. The
  default source is trusted, but `THEOKIT_MODELS_URL` lets an operator point the fetch anywhere, and
  a host serving a multi-gigabyte document would have been materialised in memory and then written
  to disk.

  The fetch now refuses anything over 32 MiB — roughly 40x the real catalog. The declared
  `content-length` is checked before the body is read, and the received size is checked after,
  because a server that omits or misstates the header is exactly the one worth bounding.

  A refused catalog is handled the way every other refresh failure already is: the SDK keeps serving
  the data it had, and says so.

- 7fd8c7e: Removes two guards no caller could reach, makes `Batch`'s `concurrency` option actually bound
  `onResult`, and stops three `Agent` APIs from accepting documented options they discarded.

  **`concurrency` now bounds `onResult`.** The semaphore slot was released before the result callback
  ran, so a batch configured with `concurrency: 2` could have any number of `onResult` callbacks in
  flight at once. Callers using that option to protect a rate-limited downstream — the reason to set it
  at all — were not protected. The callback now runs inside the slot it belongs to. A test that had
  pinned the old behaviour as a contract is inverted, because it documented the bug as a promise.

  **Three `Agent` APIs honour their options or stop accepting them.** `Agent.get` and `Agent.listRuns`
  took a `cwd` and ignored it, so they answered about the wrong workspace; `Agent.list` took
  `includeArchived`, `limit` and `cursor` and ignored all three. Each is now wired, with pagination
  opt-in so the default ordering is unchanged. Two options are removed rather than half-implemented:
  `prUrl`, which would need the on-disk registry to retain per-repo URLs, and `ListRunsOptions.runtime`,
  which is redundant once an `agentId` pins the runtime. Silently discarding a documented option is
  worse than not offering it, because the caller has no way to detect it.

  **One unreachable guard is deleted.** The Vertex client's fetch wrapper branched on `URL` and
  `Request` input forms its only caller never produces, and on a URL condition that caller always
  satisfies. It is removed rather than annotated: a defensive branch nothing can reach is a decoy that
  reads like working machinery, and this project has spent real time on several of them.

- 60010b4: Provider-reported token usage is validated before it reaches `run.usage`, the cost calculation and
  `@theokit/sdk-budget`.

  A negative count used to be billed as a negative cost and moved a budget gate downward; a numeric
  string was concatenated rather than summed, producing `"0100050"` where a total was intended. Both
  now drop with a diagnostic naming the field, and a numeric string parses. Fractional counts are
  floored rather than discarded.

  Magnitude is deliberately not checked: any ceiling here would be invented, rejecting a legitimate
  large batch while still passing anything just under it. That is a budget policy, and
  `@theokit/sdk-budget` is where a cap belongs.

- 25b7eee: `Workflow` is now one type across `@theokit/sdk` and `@theokit/sdk/workflow`.

  The two entries were built by different declaration pipelines and each emitted its own
  `declare class Workflow`. A class with a private field is compared nominally, so the documented
  combination — `import { Workflow } from "@theokit/sdk/workflow"` passed to `Cron.create` from the
  root — was rejected with "types have separate declarations of a private property '\_options'".
  Nothing in-tree crosses that boundary, because in-tree code imports from `src/`.

  Both entries now resolve to a single declaration, and a new `quality:dts-identity` gate fails the
  build if any exported class is ever declared twice across published entries again.

## 4.53.0

### Minor Changes

- 5cc5a81: Adds the `@theokit/sdk/mcp-auth` subpath: the OAuth PKCE flow for remote MCP servers
  (`runPkceFlow`, `refreshAccessToken`) plus the token storage the two of them need
  (`getTokens`, `setTokens`, `lockedRefresh`).

  The implementation already existed and was tested; nothing exported it. A consumer
  connecting to an MCP server that requires OAuth had to write RFC 7636 PKCE by hand — not
  because the package lacked the code, but because there was no way in.

  `lockedRefresh` ships alongside deliberately: two callers noticing an expired token at the
  same moment will both refresh, and under a rotating refresh token the second one loses.

- 5112ac3: Two fixes on the transcript persistence path.

  `readJsonlTail`'s `sinceMarker` matched the marker as a substring of the raw line, so a
  transcript entry whose own text contained the marker word truncated the read there. The
  caller asks for everything after the last compaction and silently got less. The marker is
  now matched as a record FIELD (`subtype`, then `type`), which is what it always meant.

  `appendJsonl` created the transcript directory with the umask, so under `umask 002` it was
  born `0775` — group-writable — while the file inside it was carefully pinned to `0600`. A
  private file in a directory others can write can be replaced wholesale. The directory is now
  created `0700`, matching the file, and matching what `assertSecureModes` demands of the
  shared `~/.theokit` tree.

### Patch Changes

- cbb70c5: Security: the MCP OAuth token store now locks down its directory, and the shared permission gate stops refusing every store on Windows.

  `setTokens` wrote through `atomicWriteJson`, whose parent-directory `mkdir` carries no mode, so `~/.theokit` was born 0775 under the common umask 002. The `chmod 600` on `mcp-tokens.json` then protects the wrong thing: write permission on a DIRECTORY is permission to unlink and recreate its contents, so another local user could replace the file wholesale — and the secret is a refresh token, so replacing it changes which account the agent authenticates as. The read path had no permission check at all, so the swap would be picked up silently.

  The directory is created 0700 and `chmod`-ed unconditionally, because `mkdir`'s mode applies only at creation and the machines that need this fix already have the loose directory. Reads go through `assertSecureModes` — the same gate the credential file uses, deliberately the same implementation rather than a second dialect of the same rule.

  Separately, `assertSecureModes` was unconditional and Windows has no POSIX mode bits: `statSync().mode` is synthetic there, so the gate refused every valid store and the credential path was unreadable on that platform. It now returns early on `win32`.

  Behaviour change worth knowing: `getTokens` now THROWS `CredentialError` on a group- or world-writable store directory where it previously returned the tokens. That is intentional — returning them would hand back what may be an attacker's refresh token as if it were the user's — but a consumer catching nothing around `getTokens` will see the error surface. The fix on the operator side is `chmod 700 ~/.theokit`.

## 4.52.1

### Patch Changes

- **`providerFromApiKeyPrefix` now appears in `dist/auth/index.d.ts`.** Fixes #283.

  It shipped at runtime and was absent from the type declaration, so a TypeScript consumer could not
  import it: `TS2305`. The same defect the export existed to close, one layer down.

  Root cause, and it is worth naming precisely: `tsconfig.base.json` sets `stripInternal: true`, and
  TypeScript matches that tag **anywhere in an attached JSDoc — prose included**. The docblock above
  the export explained the fix by describing the module as having been marked internal, and naming the
  tag deleted the very line it documented.

  Guarded by outcome rather than by word: a test asserts that every runtime export of
  `@theokit/sdk/auth` appears in the emitted `.d.ts`. A grep for the tag would forbid the word instead
  of the failure, and would not catch the next way a declaration goes missing.

## 4.52.0

### Minor Changes

- 40125a5: **`providerFromApiKeyPrefix` becomes reachable from `@theokit/sdk/auth`.**

  "Which provider issued this key?" was already answered here — in
  `internal/local-agent/real-local-run-provider.ts`, marked internal and exported from no entry
  point. A measured consumer needs it at login (`opts.provider ?? inferProvider(key)`), could not
  import it, and wrote its own copy. A capability that exists and cannot be reached costs exactly
  what an absent one costs.

  Two things separate this from a re-export:

  1. **The longest prefix wins, by construction.** The internal version walked a hand-ordered array
     and was correct only because `sk-or-` and `sk-ant-` happened to precede `sk-`. Order-as-
     convention breaks the first time somebody appends a longer prefix or sorts the list for
     readability — silently, resolving an Anthropic key as OpenAI. The ordering is now derived from
     prefix length.
  2. **No provider-profile gate.** That gate belongs to the local-run path, which will not name a
     provider it cannot construct. A caller asking "whose key is this?" at login has no profile
     registered yet, and returning `undefined` there would answer a different question.

  The prefix table no longer exists in two copies: `inferProviderFromApiKey` delegates and keeps only
  what is its own policy.

## 4.51.1

### Patch Changes

- 219fe14: Add `diagFailure`: a diagnostic reporting a user-visible failure falls back to stderr when no sink is installed, instead of being dropped.

## 4.51.0

### Minor Changes

- 265f51d: Add `evaluateBlastRadius` and `withBlastRadius`: a tool declares the scope it reaches and whether its action is reversible, and the approval layer gates on those rather than on the tool's name.
- c24a8d8: Add `guardSessionDestruction`, `decideApproval` and `describeCredential`: three rules every agent product rebuilds — refusing to destroy a live session, deciding a tool call by precedence, and reporting a credential's presence without its value.

### Patch Changes

- 5c08eb9: Containment guards in `safePathJoin` and `memory_get` now compare paths after symlink resolution, so a link inside the root pointing outside it is refused.

## 4.50.0

### Minor Changes

- 7e6a0d4: Add `planReaping`: decide which session artifacts may be deleted — and never delete them. Tri-state (keep / reap / undetermined), a keep-last floor, and liveness that outranks age.

## 4.49.0

### Minor Changes

- d0d62bd: Add `auditEnvReachability`: report config keys with no environment path and no documented opt-out, and opt-outs that no longer exempt anything.

## 4.48.0

### Minor Changes

- d9ddcbe: Add `recordWiring`: report which project entities a build requested, which it wired, and which a trust posture withheld — derived from the values handed to the builder rather than from re-reading configuration.

## 4.47.0

### Minor Changes

- d511e6a: `resolveTrustPosture` — decide what a project directory is allowed to switch on.

  A product that reads a repository must answer this before it builds anything: are that repository's
  hooks honoured, are its MCP servers started, do its instructions enter the persona? The stakes are
  not configuration-shaped — a hook is arbitrary command execution on every tool call, and an MCP
  server is an external process SPAWNED while the agent is built, before any per-tool approval exists
  to refuse it.

  The arithmetic is small; the invariant is the point. Untrusted means EVERY declared capability is
  off, and `allows` is built FROM the declared list, so a product that adds a ninth capability cannot
  forget to gate it. That failure is invisible when it happens: the new capability simply works in a
  directory where it should not.

  It deliberately does NOT decide what "trusted" means. Where the record lives, what the environment
  variable is called, whether a legacy alias is honoured — all the consumer's, because all of it is
  that product's vocabulary. `source` is reported (`env` / `store` / `default`) because "trusted
  because the operator recorded this directory" and "trusted because a blanket switch is on" are
  different facts, and only the second stays on across every directory the process opens.

  Additive. Nothing calls it yet.

## 4.46.0

### Minor Changes

- dbead57: `foldLayers` / `verifyLayerOrdering` — combine configuration layers in a declared order.

  Later layers win, `undefined` never overwrites, and named keys ACCUMULATE instead of being
  replaced. That last rule is not a nicety: with plain last-wins a project file DISPLACES the user's
  entries for a list-valued key rather than adding to them, and for a key like `hooks` — arbitrary
  command execution on every tool call — that is the difference between a repository adding a hook and
  a repository removing yours.

  `verifyLayerOrdering` refuses a chain that is not strictly ascending, naming both layers and both
  precedences. Tolerating it would make resolution depend on array order rather than on declared
  precedence: two sources of truth for one decision.

  The layer NAMES are the caller's, supplied as data — one product's chain is
  defaults/user/project/profile/env/cli and `profile` is that product's idea. Entries may omit
  `precedence` to mean "this array is already the order".

  Additive. Nothing calls it yet.

## 4.45.0

### Minor Changes

- f9a29f5: `applySecurityFloor` — a lower-trust configuration layer may tighten a security setting, never loosen it.

  Layered configuration usually resolves last-wins, and for the keys that decide confinement that is a
  hole: a project layer outranks the user's own file, so a cloned repository can hand itself the most
  permissive sandbox and the operator's global choice loses silently, at the moment the directory is
  opened. Nothing fails; the confinement is simply gone.

  The rule is generic and the vocabulary is not, so the vocabulary is parameters: which values count
  as more permissive, which layers are restricted, and which layer is the operator's explicit
  override. A second product supplies its own without inheriting the first's words.

  The override is returned verbatim even when outside the vocabulary — validating the operator's flag
  is the consumer's job, and silently dropping an unrecognised one is worse than passing it through. A
  value outside the vocabulary in a RESTRICTED layer is ignored instead: a typo in a repository's
  config must neither become the effective setting nor read as maximally permissive.

  Additive. Nothing calls it yet.

## 4.44.1

### Patch Changes

- 0cabe27: `pnpm release` now verifies its tags reached the remote instead of trusting an exit code.

  `changeset publish` creates one annotated tag per published package and pushes them, then reports
  success on its own exit code — and an exit code is not evidence a ref transferred.

  Measured 2026-08-11: `git push` contacts the remote BEFORE `pre-push` runs, `pre-push` runs the full
  `pnpm validate` for around eleven minutes, and by the time the transfer begins the server has
  dropped the idle connection. Git dies of SIGPIPE (exit 141) silently — no error text, nothing
  transferred, output ending in `✓ pre-push gates passed`. A missing release tag is not noticed that
  day; it is noticed weeks later by whoever is bisecting.

  `scripts/verify-release-refs.mjs` compares the tags at a revision against `git ls-remote`, and is
  wired into `pnpm release` after `changeset publish` rather than offered as a wrapper — a wrapper
  only helps whoever remembers to call it.

  Three distinct exit codes, because collapsing them is the failure being removed: `0` verified,
  `1` a tag never reached the remote, `2` could not check (unreachable remote, or a revision that does
  not resolve).

## 4.44.0

### Minor Changes

- 8cfc61b: `loadProjectEnv` — read a project's `.env` without letting it move the credential store.

  `process.loadEnvFile()` reads the PROJECT's `.env` into `process.env`. That is right for a provider
  key and is the documented way to configure a scaffolded product. It is a hole for the handful of
  variables that decide WHERE credentials live and WHAT is trusted: a cloned repository is untrusted
  input, and a `.env` inside it is untrusted input the runtime is about to treat as configuration.

  Without a guard, a repository shipping `THEOKIT_AUTH_HOME=/tmp/attacker-store` redirects the
  credential store the moment the product starts in that directory — before any trust prompt, because
  locating the store is what happens first.

  `loadProjectEnv(env?, load?)` captures the sovereign keys before the load and restores them after,
  including restoring "was not set" by deleting the key. `SOVEREIGN_ENV_KEYS` names them explicitly —
  `THEOKIT_HOME`, `THEOKIT_AUTH_HOME`, `THEOKIT_DIR_NAME`, `THEOKIT_TRUSTED_PROVIDERS`,
  `THEOKIT_REDACT_SECRETS`, `THEOKIT_OAUTH_TX_SALT` — because a convention ("anything ending in
  `_HOME`") silently changes meaning as variables are added, in both directions.

  `THEOKIT_API_KEY` is deliberately NOT sovereign: a project supplying its own provider key is the
  intended path, and a key the project supplies is a key the project already has.

  Additive. Nothing calls it yet; existing behaviour is unchanged.

## 4.43.0

### Minor Changes

- b9bf261: `globbed` discovery now understands `**`.

  A spec whose pattern contains a globstar finds files at every depth — `.theokit/rules/**/*.md`
  returns `rules/top.md` as well as `rules/deep/nested/inner.md`. Patterns with a single `*` keep
  their flat meaning, and no default spec changed: the capability is new, the behaviour of every
  existing consumer is not.

  The previous implementation split the pattern at its last `/`, treated the prefix as a literal
  directory and read it once — documented as "nested directories deferred to v2". The deferral was
  deliberate; what turned it into a defect was measured from a consumer. A product whose own rule
  loader descends recursively could not migrate onto the `theokit-rules` spec without silently
  dropping every nested rule, on the path that decides whether a repository's hooks execute. Worse,
  writing `**` explicitly matched NOTHING — the directory part resolved to a literal `**`, so the
  pattern lost even the top-level file it used to find.

  Implemented with `fs.promises.glob` rather than a hand-written walker. It provides exactly these
  semantics, verified against a fixture before adoption, and the package already requires Node

  > = 22.12. Writing a walker would have been a third matcher inside one package — the duplication
  > that let the enumerator and `context-glob.ts` disagree in the first place.

### Patch Changes

- e080296: Publish with npm provenance attestation.

  The release workflow disabled it with the reason "npm refuses provenance attestation for PRIVATE
  source repositories — this repo is currently private". The repository is public; the precondition the
  comment named as its own migration trigger was already met and nothing had acted on it.

  A consumer can now verify a tarball was built by the release workflow from a specific commit, rather
  than trusting that whoever held the publish token was us. The tokenless OIDC binding — configured per
  package on npmjs.com rather than in this repository — remains the next step.

- 8790f70: Refuse a `workspace:` range before it can reach npm.

  Five of this repo's twelve publishable packages declare internal dependencies as `workspace:^`, which
  is correct on disk and becomes an unrecoverable defect if the publish goes out through a tool that
  does not rewrite it: `pnpm` resolves the protocol while packing, `npm` ships the manifest verbatim.
  A version published that way fails to install for everyone and cannot be corrected — only
  deprecated.

  Every publishable package now runs the guard in `prepublishOnly`, so it fires whichever way the
  publish is invoked, and `pnpm release` runs it once across the repo before `changeset publish`.

  Note for anyone reading a published manifest: the `prepublishOnly` entry points at a path inside
  this repository. It never runs for a consumer — the hook only fires when the package itself is
  published — and guarding the entry point that a hand-run `npm publish` actually uses was worth the
  cosmetic wart of shipping the line.

## 4.42.1

### Patch Changes

- dc18357: **Security.** Fix a containment check that admitted a sibling directory and any symlink.

  `.theokit/context/*.md` frontmatter carries a `path:`, so the value is repository-controlled —
  untrusted whenever the repository came from somewhere else. `loadSources` guarded it with
  `absolute.startsWith(resolvePath(cwd))`, which fails twice:

  - **No separator boundary.** With `cwd = /home/user/proj`, the value `../proj-evil/secret.md`
    resolves to `/home/user/proj-evil/secret.md`, which starts with `/home/user/proj`. A sibling
    directory whose name merely extends the project's is admitted; no traversal past the parent is
    needed.
  - **Lexical, not real.** A symlink whose name sits inside the root and whose target does not passes
    any comparison made before symlink resolution.

  Measured against the pre-fix code: the file outside the root was READ and its content reached the
  context snapshot. The obvious escapes (`../../etc/passwd`, an absolute path) were refused, and
  refusing them is what made the check look correct in review.

  The correct rule already existed in the package as a private function in the import resolver, written
  for the 4.41.1 patch. It now lives in `path-containment.ts` and both readers of repository-supplied
  paths share it — one rule, one representation, so the two cannot drift apart again.

  **A second, independent defect fixed alongside it.** `refresh()` carried every legacy source into the
  aggregator without filtering, and then stamped `"included"` on everything the budget kept — so the
  containment verdict was computed and discarded three statements later, and `snapshot()` reported an
  excluded source as included. Nothing leaked through that path (the content was empty), but a consumer
  auditing "what is in my context" got the wrong answer.

## 4.42.0

### Minor Changes

- 09d5dbc: Add `@theokit/sdk/context` — a sanctioned public barrel for context assembly.

  Discovery, rule activation and `@path` import resolution were implemented inside
  `internal/runtime/context/` and reachable by nobody: 31 subpaths were declared, none covered the
  tree, and every deep import answered `ERR_PACKAGE_PATH_NOT_EXPORTED`. A consumer that wanted the
  capability had to re-derive it — measured at ~430 LoC in one downstream product.

  The barrel is a curated list, never `export *`: `runDiscovery`, `parseRules`, `shouldActivateRule`,
  `resolveContextImports`, plus the `DiscoverySpec` / `DiscoveryScope` / `DiscoveryParser` types. The
  tree behind it holds 13 files including YAML shims and parser internals a consumer never needs, and
  publishing the directory would commit this package to every file in it.

  Deliberately NOT under `internal/*`. Those subpaths are documented "internal API — semver-exempt",
  `internal/persistence` is `@deprecated` in favour of a sanctioned barrel, and two siblings were
  deleted as dead public surface. What is exported here is under semver.

  **`resolveContextImports` is a wrapper, not a re-export, and the difference is a security boundary.**
  The internal `resolveImports` takes `projectRoot` as an OPTIONAL field — correct for the callers that
  predate 4.41.1, and a trap as a public contract: the obvious call omits it and silently restores the
  un-contained behaviour that 4.41.1 patched, published under semver and therefore unfixable without a
  breaking change. On the public surface the root is REQUIRED, asserted by a `@ts-expect-error` test.

  `applyAggregateCap` is deliberately excluded: its `priority` field means "position among the SDK's
  own seven specs", which is not a contract a consumer registering its own source can use.

## 4.41.1

### Patch Changes

- 8bdbf44: **Security.** Confine `@path` context imports to the repository they are declared in.

  `CLAUDE.md` and `GEMINI.md` are discovered by walking up to the git root and carry
  `followImports: true`, so their content is repository-controlled. The resolver applied no
  root: it handled `~/...` and absolute paths explicitly, so a line that was exactly
  `@~/.ssh/id_rsa` in a cloned repository had that file read and inlined into the agent's
  system prompt — and from there sent to the model provider. The traversal guard that already
  existed (`isSafePattern`) validates the discovery _pattern_, one layer away from the import
  _target_, so it never saw this.

  `resolveImports` now takes an optional `projectRoot` and refuses a target resolving outside
  it, comparing after symlink resolution and forwarding the root through recursion so the
  boundary cannot be crossed on a later hop. The discovery runner supplies `gitRoot ?? cwd` —
  the same value it already uses to keep absolute paths out of `<source name="">` — and
  `runDiscovery` accepts `importRoot` for an embedder whose trust boundary is narrower than
  the repository. A refused import becomes `[@import outside the project root, refused: <path>]`
  and never the file's bytes; the placeholder echoes the path as written, not as resolved, so
  the refusal does not leak the machine's layout back into the same untrusted document.

  Callers that pass no root keep the previous behaviour, so this is additive for anyone using
  `resolveImports` directly outside the discovery path.

## 4.41.0

### Minor Changes

- ea99026: Three facts the SDK already knew are now answerable, instead of being re-derived by every consumer.

  - `assertSecureModes(dir, file)` — the 0700-dir / 0600-file gate, exported from `@theokit/sdk/auth`.
    Its own docstring names the attack it prevents (a writable directory lets someone swap the
    credential file for a symlink to their own), and that reasoning is not specific to this SDK's
    credential file: consumers keep sensitive stores beside it and were reading them with no check at
    all, because the gate was private.

  - `writableRootsFor(mode, cwd)` — what a sandbox mode may write to, answerable WITHOUT spawning.
    `buildBwrapArgv` knew it, but only while building an argv, and consumers need the answer earlier:
    tools are scoped at agent construction, before any process exists. `[]` means nothing is writable;
    `null` means unrestricted — not `["/"]`, because unrestricted is the absence of a root rather than
    a root that happens to be `/`.

  - `atomicWriteTempTarget(name)` — the file a leftover `<file>.<pid>.<hex>.tmp` was replacing.
    `replaceFileAtomic` creates those and has no opinion about sweeping them, so a consumer wanting to
    had to know a format that lived only in the implementation. Deliberately strict about pid digits
    and a 16-char hex suffix: matching any `.tmp` would claim other tools' scratch on a path whose
    purpose is deleting files.

  Each is derived from the same helper its writer uses, so the answer and the behaviour cannot drift
  apart. All three were measured from a consumer that had reimplemented them — one of them by copying
  a regex out of a compiled chunk.

- 994808f: Emit `mcp_server_failed` on the typed run-event stream when a configured MCP server's tools cannot be listed. Additive `RunEvent` variant; the sink stays opt-in and no existing signature changed.
- 4d64479: `classifySessionArtifact(name, isDirectory)` — what a file in a project directory is, when this SDK
  wrote it.

  Four kinds get created here and reasoned about nowhere: `<id>.jsonl` (`transcriptPath`),
  `<id>.jsonl.writer.lock` (the writer lease), `<id>.jsonl.lock` (`withFileLock`, a DIRECTORY since it
  locks by `mkdir`), and `<file>.<pid>.<hex>.tmp` (`replaceFileAtomic`, left behind by a crash between
  the open and the rename). There is no retention, no collector, and there was no way even to ask what
  an entry is — so a consumer reclaiming disk had to re-derive the suffixes from this source, and a
  suffix changing here would have left its classifier mislabelling files on a path that deletes them.

  Deliberately NOT a garbage collector. Retention is policy — how many days, how many to keep, which
  session is live, whether to delete at all — and the application is the only one that can answer that.
  What belongs here is the half only the SDK can: what did I write, and what is it.

  `undefined` means "not written by this SDK", which is the answer that matters most — a caller
  deleting what it does not recognise is how someone's editor swap file gets collected. The `temp` case
  defers to `atomicWriteTempTarget` rather than matching `.tmp`, for that reason.

## 4.40.0

### Minor Changes

- 6c6ce8c: `run.events()` now states whether a message's text already streamed, so consumers stop inferring it
  by comparing text.

  Unifying the timeline in 4.38.0 fixed ordering and the `callId` namespace. It did not stop the same
  text arriving twice: the run's event log carries the complete assistant message, and the deltas are
  additional. A consumer had to relate the two by COMPARING CONTENT — which is where the
  `callId`-namespace and timestamp-fallback bugs came from.

  The producer knows the answer as a fact. The SDK emits the deltas and emits the message from the
  same scope, so `RunTimelineEvent` of kind `message` now carries an optional `textAlreadyStreamed`,
  and the consumer's dedup becomes a boolean read instead of a text comparison.

  Marked rather than suppressed: the assistant message also carries tool calls and metadata, so
  dropping it would trade a duplicate for a hole. The field is optional and absent when the question
  does not apply (a message with no text), so no existing `events()` consumer breaks and `stream()` is
  untouched.

  Closes the contract half of theokit#140.

## 4.39.4

### Patch Changes

- 5f071cd: The file-lock fallback warning reports the failure it observed, instead of always claiming
  `proper-lockfile` is not installed.

  `getProperLockfile` wrapped the dynamic import in a bare `catch` that discarded the error, so every
  failure — a broken install, a module-format problem, a bundler that rewrote the specifier — surfaced
  as "not installed". A consumer whose package was declared, installed and resolvable from the SDK's
  own `dist` spent a debugging session re-verifying the one thing that was already correct.

  Absence is now the only case that claims absence (`ERR_MODULE_NOT_FOUND` / `MODULE_NOT_FOUND`). Any
  other failure reports its code and message and points at bundling and interop. All variants state the
  consequence explicitly: concurrent processes over the same file are not serialized.

  The warning also no longer fires on top of the structural "does not expose `lock`/`unlock`" warning —
  two contradictory diagnoses of one failure left no way to tell which was true.

## 4.39.3

### Patch Changes

- ead3881: The ChatGPT provider identifies itself as `theokit`, not as the official Codex CLI.

  The profile shipped `originator: "codex_cli_rs"` — the value the official Codex CLI sends for itself.
  Presenting another vendor's client name is a false statement of identity, and it diverged from the
  prior art: third-party clients send their own name against the same endpoint,
  which also shows the route is not restricted to the official client.

  A test pinned the old value as the contract, which is how it survived review — correcting the
  identity registered as a regression. That assertion now pins the honest value and asserts the false
  one is never sent again.

  This does not resolve the 429 reported in theokit-sdk#165, and nothing here needed to: a live test
  against the endpoint returned 200 with no `originator` header at all, so the header was never the
  access gate. That 429 was ordinary rate limiting. If you hit one, install `setDiagnosticsSink`
  (4.39.2+) — it names the attempt, the ceiling and the cause, which is what tells a real rate limit
  apart from a retry that never ran.

## 4.39.2

### Patch Changes

- The retry diagnostic reads `retry 1/3 in 431ms` — it said `em` in 4.39.1.

  One Portuguese word shipped inside an English-only codebase. The lint gate that enforces the rule
  cannot see a two-letter word inside a template literal, so it passed review and passed CI; it was
  caught by reading the built artifact before a later publish.

  The regression test now pins the WORDING and not just the fields (`/retry \d+\/\d+ in \d+ms/`), so a
  language slip fails a test rather than depending on a gate that is structurally unable to catch it.

## 4.39.1

### Patch Changes

- A retry no longer runs silently: each attempt announces itself through the diagnostics channel.

  Every attempt now emits its number and ceiling, the backoff it is about to wait, the error class, and
  the provider's `Retry-After` when one arrived. Nothing is written unless a host installs a sink
  (`setDiagnosticsSink`), so the default stays silent — a library does not own the host's terminal.

  The bug this closes is not a missing retry. `RetryingLlmClient` already wraps every arm of the
  router, and `RateLimitError` is already retryable with a ceiling of 3. The defect was that the retry
  was _unobservable_: the backoff is full-jitter, so three attempts can complete inside milliseconds
  and disappear into the response latency. Issue #165 is the cost, measured — a 429 was investigated on
  the wrong hypothesis for hours, because the available evidence could not distinguish "retried three
  times and failed" from "never retried".

  ```ts
  import { setDiagnosticsSink } from "@theokit/sdk";
  setDiagnosticsSink((m) => process.stderr.write(m + "\n"));
  ```

## 4.39.0

### Minor Changes

- 5143651: New `Agent.describe(agentId)` — read-only introspection of a registered agent (theokit#123).

  `Agent.list()` / `Agent.get()` enumerate agents and `agent.skills.list()` covers skills, but a
  registered agent's tools and subagents were reachable only through the internal registry record. A
  reflection endpoint — theokit-studio's `theokit dev` — had no way to report them, so it degraded to
  `tools: []` / `workflows: []` with an `unavailable_reason`.

  `describe` returns `{ agentId, runtime, model?, tools, subagents }`. Tools carry `name`,
  `description` and the `inputSchema` the model is sent; subagents carry `name`, `description`, their
  `model` and their tool whitelist.

  It is a projection, not the options object: tool handlers and subagent prompts are stripped. A
  handler is an executable that cannot cross a process boundary, and a prompt is the agent's
  instructions rather than its signature — a reflection endpoint serializes whatever it is handed.

  `tools` and `subagents` are always arrays, so a caller can distinguish "this agent has none" from
  "the SDK did not say". An unknown agent throws `UnknownAgentError` rather than returning an empty
  description, which would be indistinguishable from a real agent with nothing registered.

  `AgentDescription`, `AgentToolDescription` and `AgentSubagentDescription` are exported from the
  package barrel.

- ae27def: Every SDK diagnostic now goes through the interceptable channel (theokit#147).

  `setDiagnosticsSink` let a TUI host keep the SDK's warnings out of its alternate screen, but the
  original migration only covered `internal/`. Six sites in the package's own modules — `batch.ts`,
  `event-bus.ts`, `compaction.ts` and the Workflow branch step — still wrote straight to
  `process.stderr` / `console.warn`, so a host could install a sink and still have its frame corrupted
  by a batch run or a failed summarizer. Those are routed through the channel, and a lint gate now
  fails the build if a new direct write appears in `src/`.

  The remaining allowlisted writers are seams whose destination the caller already chooses
  (`opts.warn`, `opts.logger`, the Workflow logger), each listed with its reason.

  `setDiagnosticsSink` is now exported from the package barrel. It previously existed only on an
  internal path no consumer could import, so the channel these six fixes route into could not actually
  be installed by a host — the reported blocker survived a green suite.

  **Diagnostics are now silent by default.** With no sink installed the SDK writes nothing to the
  terminal — a library does not own the host's screen. Installing a sink is how you see them:

  ```ts
  import { setDiagnosticsSink } from "@theokit/sdk";
  setDiagnosticsSink((message) => myLogger.warn(message));
  ```

  This is a behaviour change for anyone who relied on reading SDK warnings from stderr. Restore the
  old behaviour in one line: `setDiagnosticsSink((m) => process.stderr.write(m))`.

- 0bd082f: Three advertised embedding providers now actually work (theokit#159).

  `azure-openai`, `cohere` and `gemini` were in the catalog and rejected on every call. The shared
  runtime spoke exactly one wire — `Authorization: Bearer`, a `{ model, input }` body, a
  `{ data: [{ embedding }] }` response — and none of the three speak it:

  - **Azure** authenticates an API key with the `api-key` header (`Bearer` carries an Entra ID token,
    not the key from `AZURE_OPENAI_API_KEY`), and the deployment is already in the URL path, so
    `model` does not belong in the body.
  - **Cohere**'s `/v2/embed` names the payload `texts`, requires `input_type`, and answers
    `{ embeddings: { float } }`.
  - **Gemini**'s OpenAI-compatible surface is at `/v1beta/openai/embeddings`, not `/v1/embeddings`.

  The runtime gained three optional per-provider hooks — auth headers, request body, response reader —
  whose defaults are exactly the previous behaviour, so the seven providers that were already correct
  are untouched. Each divergence is asserted by a test that records the real request.

  Advertising a provider that cannot work is worse than not advertising it; that is what this closes.

- 108679d: A resumed session can be re-rendered as tool cards, not prose (theokit#146).

  The transcript always replayed correctly to the model, but the only projection a host could read
  folded a tool call to the literal string `[tool call] NAME` — no call id, no arguments — and a
  result to `[tool result] <body>`, with nothing tying the two together. A card-rendering TUI got flat
  text on resume, which made cross-restart resume worth less than starting fresh.

  Two additions, both additive:

  - `SessionMessage` gains an optional `parts` array carrying `text`, `tool_use` (id, name, input) and
    `tool_result` (toolUseId, content, isError). `text` is byte-identical to before, so every existing
    reader — including the runtime's own prior-context replay — is untouched.
  - New `Agent.transcript(agentId)` returns a local agent's persisted turns with both projections.
    Read-only; it opens the session store and walks the transcript, appending nothing. Throws
    `UnknownAgentError` for an unknown or non-local agent rather than returning an empty list, so a
    typo cannot look like an empty session.

  `SessionMessage` and `SessionMessagePart` are exported from the package barrel.

- 1e2a5e3: Extended-thinking sessions can be resumed (theokit#122).

  Anthropic signs each `thinking` block and verifies that signature when the block is replayed on the
  next turn. The SDK captured none of it, so a session that used extended thinking could be persisted
  and then never resumed — the next request failed with `400 "thinking blocks cannot be modified"`.

  The signature was dropped at four independent points, and fixing any one alone would have changed
  nothing:

  - the Anthropic adapter never requested extended thinking, so no signature was ever issued;
  - it did not parse `thinking` blocks, so neither the text nor the signature left the stream;
  - the agent loop emitted a thinking event and dropped it — nothing ever produced a `thinkingMessage`
    step, so no thinking reached the transcript at all;
  - the transcript reader discarded `thinking` blocks, so a resumed conversation lost them.

  All four are closed, and the block now round-trips from the provider through persistence and back
  onto the wire unchanged. Thinking and its answer text stay in one assistant message, in that order,
  as Anthropic requires.

  A thinking block with no signature — history recorded before this shipped, or reasoning text from an
  OpenAI-compatible provider, which is never signed — is kept in the transcript but not replayed to
  Anthropic. Sending it unsigned would fail the same validation and break the whole turn rather than
  lose one block of context.

  `SDKThinkingMessage` and the conversation `ThinkingMessage` gain an optional `signature`.

- c3f69bc: New `workflow.describe()` — a committed workflow can report its own shape (theokit#161).

  Returns `{ name, steps }`, each step carrying its `id` and `kind` and recursing into `parallel`,
  `branch`, `foreach` and `dowhile`. Executables a step holds — predicates, conditions, agents, prompt
  templates — are omitted: they cannot cross a process boundary and say nothing about shape.

  There is deliberately **no** `Workflow.list()`. A workflow is a value the caller constructs and
  holds, so the caller already knows which ones exist; what it lacked was a way to describe one. A
  registry would have added process-global state that nothing releases in order to re-answer a
  question the host can answer itself, and coupling workflows to `AgentOptions` would tie together two
  things that are independent today — a workflow runs perfectly well without an agent.

  A reflection endpoint maps over its own workflows and calls this.

### Patch Changes

- a4a9920: `@theokit/sdk-memory` now uses the SDK's embedding runtime instead of its own copy (theokit#160).

  The two packages each carried a full copy of `createOpenAiCompatibleRuntime`, and the satellite's
  catalog replaces the SDK's at runtime when installed — so the copy that ran was not the copy most
  people read. That duplication is what produced the two-month adapter gap fixed in theokit#128, and
  every fix since had to be applied to both files by hand.

  There is now one implementation, imported from `@theokit/sdk/internal/memory-adapters` — a
  semver-exempt sub-path in the same family as `internal/persistence` and `internal/security`, which
  exist for exactly this reason.

  **Behaviour change for `@theokit/sdk-memory` consumers:** embedding batches now run with bounded
  parallelism instead of serially, and the embedding cache is process-wide instead of per-adapter.
  Both are what the SDK already did; the satellite had silently missed both improvements.

- 50ffa6c: Removed the dead `tool_use` and `stop` variants from the internal `LlmEvent` union (theokit#144).

  They declared a live, provider-level tool channel that never existed: only two providers yielded
  them, the agent loop's collector never read them, and the tool calls they carried duplicated
  `LlmFinish.toolCalls`. A declaration without a consumer is worse than an omission — it cost
  `@theokit/agents` a workaround that held every text delta until the stream drained, which broke
  live token streaming on text-only turns (issue #47).

  The canonical live tool channel is `onDelta`: the `tool-call-started` / `tool-call-completed`
  `InteractionUpdate`s emitted between LLM rounds, uniform across providers and correlated by
  `callId`. `Run.events()` merges them with the structural messages into one ordered timeline. This
  is now documented on the `LlmEvent` type itself.

  Internal type only — no public API change.

- 0308f9f: `@theokit/sdk-memory` now serves every embedding provider the SDK advertises (theokit#128).

  `azure-openai`, `cohere`, `jina` and `gemini` landed in the SDK core catalog in June 2026 and the
  satellite never picked them up. That was not cosmetic drift: when `@theokit/sdk-memory` is
  installed, its catalog _replaces_ core's in the routing path, while `Theokit.inspect.embeddingAdapters()`
  kept listing all ten — so asking for one of the four got an "unknown provider" error from a provider
  the SDK itself had just advertised. A cross-package test now fails the build if core ever advertises
  a provider the peer cannot serve.

  Also fixes the Azure OpenAI endpoint in both packages. Azure addresses the deployment in the URL
  path (`/openai/deployments/{deployment}/embeddings`), and the placeholder was never substituted —
  every Azure embedding request went to a URL containing the literal text `{model}` and could only 404. Providers with a static path are unaffected.

- a15d80f: `mcpLifecycle: 'session'` now actually keeps the MCP server alive between turns (theokit#155).

  The option pooled the client _object_ but not the child _process_: every run's `finally` closed
  every client it had been handed, so the previous turn SIGTERM'd the server and the next turn's
  `initialize()` spawned a new one. Measured at 146 ms +/- 28 (n=12) of spawn + handshake per turn
  for one stdio server, paid identically under `'run'` and `'session'` — the knob bought 0 ms.

  Two changes, both needed:

  - A run now closes only the MCP clients it owns. Under `'session'` the pool owns them, and they are
    released by `dispose()` (or by the idle reaper), not by the turn that borrowed them.
  - `initialize()` is a no-op while the child is live, so the per-turn handshake no longer replaces a
    healthy process (which would have orphaned it and paid the spawn cost anyway). The reconnect path
    is unaffected — it re-spawns directly, exactly as before.

  The regression tests count child PIDs rather than client objects; counting objects is what let the
  defect ship green.

- 32a82c4: Subagent credential inheritance no longer rides a property on the tool object (theokit#148).

  A delegated child inherited its parent's API key through a symbol-keyed slot installed on the
  subagent tool. That contract assumed the object would reach the dispatcher with an extra property
  intact — and it broke twice: once because the bundler inlined two copies of the module that
  disagreed on the key (#142/#143), and once because any layer rebuilding the tool from its known
  fields simply dropped it. `@theokit/agents` hit the second and had to add an explicit symbol-copy
  loop to compensate; the SDK's own tool assembly performs the same rebuild.

  Credentials now travel on the run's async scope, so they reach the handler no matter what the tool
  object looks like by the time it is dispatched. Consumers that normalize, wrap, or re-create SDK
  tools no longer need to preserve hidden properties — a delegated child gets the parent's key either
  way. The band-aid symbol-copy in `@theokit/agents` becomes unnecessary once the SDK
  carrying this change is the resolved version. Against an OLDER SDK the copy loop is still required:
  the pre-fix runtime reads the credential sink off the tool object, so a band-aid-free
  `@theokit/agents` resolving an SDK below this release reproduces the very credential loss this issue
  reports. `@theokit/agents` declares a caret range on `@theokit/sdk`, so that pairing is a normal
  install rather than a hypothetical — raise the dependency floor in the same release that removes
  the loop.

  Also fixes a latent defect the old design could not avoid: credentials were stored per tool
  instance, so one subagent tool shared by two concurrently running agents got last-writer-wins. Each
  run now reads its own.

- f760c57: Fixes four defects in the extended-thinking support shipped moments earlier (theokit#122).

  A `/review` of that change found it created, on the most common thinking shape, the exact failure it
  was meant to remove. A round that reasons and then calls a tool **without preamble text** never
  consumed its thinking block: the block survived onto the next round and was persisted against the
  wrong text, carrying a signature that no longer matched its body. And the replayed assistant turn
  never carried the block at all, so the round after a thinking + tool_use turn reached the provider
  missing it.

  The block is now a value on the round's own output rather than state on the loop context, which
  makes that class of leak unrepresentable, and it is recorded on whichever path closes the round —
  assistant text or tool call. The replayed assistant message leads with it, as the provider requires.

  Two smaller corrections in the same area: redacting the thinking text now drops the signature
  instead of persisting a pair that cannot verify (the block survives as display-only history, which
  loses one block of context rather than the whole turn), and the provider's own reported block is now
  what the loop consumes — previously it was produced and read by nobody, the same dead-channel shape
  this release deletes elsewhere.

## 4.38.0

### Minor Changes

- New `run.events()` — every event of a run in true order, from a single source (theokit#140).

  A consumer that wanted both structural messages and live token granularity had to fuse two
  incomplete views by hand: `stream()` carries no token deltas, and `SendOptions.onDelta` carries no
  `run_started` / `system`. Reconciling them in the consumer is what produced the ordering and
  duplication bugs this replaces.

  `events()` returns an `AsyncGenerator<RunTimelineEvent>`, a discriminated union of
  `{ kind: "message" }` and `{ kind: "delta" }` — not a widened `SDKMessage`, because a token delta
  is not a message and pretending otherwise would force every consumer to guess which of the two it
  is holding.

  Minor rather than major: `stream()` is untouched and remains the SDKMessage-only view, `onDelta` is
  wrapped rather than replaced, and every existing consumer observes no change.

  `RunTimelineEvent` is exported from the package barrel.

  > Entry reconstructed on 2026-08-05. The 4.38.0 release was cut by a hand-written version bump
  > (`8beb61da6`) that changed `package.json` alone — no changeset, so this section never existed and
  > the published version shipped without notes. The facts here come from the release commit and the
  > exported type contract, not from a recovered changeset.

## 4.37.2

### Patch Changes

- MCP servers that reply with an event stream deliver their tools again: the response is now read in the format the client itself asked for, instead of failing to interpret it.

## 4.37.1

### Patch Changes

- MCP servers on the **stateful** HTTP transport serve their tools again: the client now stores the session the server issues at handshake and replays it on subsequent calls, and declares both media types the specification asks for.

## 4.37.0

### Minor Changes

- 2df1de1: M107 — three additive persistence/registry primitives, plus one concurrency fix.

  - `atomicWriteJson` (and `replaceFileAtomic`) accept `{ mode?, exclusive? }`. Omitting them keeps
    today's behaviour byte for byte, including the mode on disk: the mode passed to `open` is filtered
    by the `umask`, so the file is `0o600` under `umask 002`/`022` and `0o400` under `umask 0200`, and
    that is preserved. When you DO pass `mode`, it is reasserted on the descriptor before the rename,
    so the `umask` cannot silently drop a bit you asked for. `exclusive: true` creates the temporary
    with `wx`, turning a leftover temporary into `EEXIST` instead of a silent truncation.

  - **Behaviour change on disk:** `forkTranscript` now creates the destination with mode `0o600` by
    default (`mode?` overrides it). Previously no mode was passed at all, so a forked transcript was
    born `0o666 & ~umask` — measured `0o664` (group-writable) on a `umask 002` machine and `0o644` on
    `umask 022`. A transcript holds the conversation, so this is a privacy fix, not a tidy-up. It is
    announced as a behaviour change rather than a silent patch because the change is visible to
    anything that read those files as another user or group. The direction is restrictive only.

  - `Agent.list` now READS the `cwd` its type has always advertised. `Agent.list({ runtime: "local",
cwd })` previously compiled and was silently ignored — it hydrated the process directory and
    returned every agent in memory. Listing is now scoped to the requested workspace, using the same
    "which project owns this entry" rule the persistence layer uses to route it to disk (an entry with
    no `cwd` belongs to the process directory). Calls without `cwd` keep listing the process
    directory. `limit`/`cursor` are still not implemented: a `limit` without a `nextCursor` would be
    silent truncation.

  - **Fix:** two concurrent first-time hydrations of the same workspace could make the second caller
    see an empty registry. The hydration guard marked the directory as loaded before awaiting the disk
    read, so the second call returned early. It now awaits the same in-flight read, and a failed
    hydration is no longer memoised as successful.

  `AtomicWriteJsonOptions` gained optional fields and `replaceFileAtomic` gained an optional third
  parameter; both are additive and every existing call site compiles unchanged.

## 4.36.0

### Minor Changes

- a439c00: `discoverSubagents` and `loadSubagentDefinition` now accept a `settingSources` option, so a caller can decide where subagent definitions are read from instead of always reading the project directory; the parsed `AgentDefinition` type is re-exported from `@theokit/sdk/subagents-loader` so consumers can name the value they receive.

## 4.35.0

### Minor Changes

- Publishes a query answering "does this session have a writer?" without taking the lock.

  Asking by taking creates the very contention it meant to detect: two processes querying a **free** session at the same time made one of them lose, and the consumer derived a new session for no reason. The query is a snapshot, not a guarantee — callers needing the guarantee keep taking the lock; callers needing to decide an identifier before opening anything use the query and handle the race where it shows up.

## 4.34.2

### Patch Changes

- Two refinements to the session lock.

  - **An open that fails releases only its own agent's lock.** A store injected by the consumer may serve several agents, and the previous version released all of its locks — an agent failing to open tore down the protection of another that was still writing.
  - **A lock path that is a directory becomes recoverable again.** No process in this library creates one, and treating it as an "unknown owner" locked the session out forever — the opposite of what the lock exists to guarantee.

## 4.34.1

### Patch Changes

- Fixes three ways the session lock could get stuck or be ignored.

  - **A session open that fails after taking the lock now releases it.** The owner ended up being this very process — alive, same machine — and the lock was never considered stale again: the session stayed blocked for the process's lifetime, with no crash and no recovery path. It is the same situation the lock exists to eliminate, entering through another door.
  - **A lock that exists but cannot be read stops being treated as absent.** Not knowing who the owner is differs from there being no owner: the previous version proceeded without protection, with another writer active on the same session. In a shared directory this was the common path, because the restricted permission makes another user's lock unreadable by design.
  - **The restricted permission now also applies to a lock inherited from an earlier version**, which previously kept the old permission after being reclaimed.

## 4.34.0

### Minor Changes

- The writer lease is now taken when the session opens, not on the first write.

  **Fixes a silent turn loss.** Session writing is best-effort by contract — a rejection is logged to stderr, never thrown to the caller. Taking the lease there made the "session busy" error get swallowed: instead of two writers interleaving lines, the loser **lost the whole turn**, with nothing on disk and no way to react. At open time the error reaches someone who can decide — and the decision it prescribes is to create a derived session.

  An I/O failure that is **not** contention (an unwritable directory, a full disk) no longer fails the agent's open: there is no second writer to avoid, and the write was already best-effort.

  ### Corrigido

  - **The in-memory session caches are actually erased again.** Three of the four maps are addressed by a composite key and were being removed by a different one: in practice, they were never erased. And eviction by ceiling left the hydration marker behind, making an evicted session come back **empty** instead of reloading from disk.
  - **The lock file is born restricted to its owner.** With the previous permission, another user in the same group could overwrite it and forge ownership of the session — from then on it was the legitimate owner who got refused.
  - **The maximum declared context window rose to 10M.** The previous value refused the real window of a published model — which arrives precisely via the catalog-less provider, that is, the case the limit exists to cover. Silently losing 80% of the window is worse than the excess the limit prevents.

## 4.33.1

### Patch Changes

- Fixes a session lease that could be taken from a live process.

  The owner record is written at acquisition and is not renewed on each write, and the previous version considered any lock older than the heartbeat window reclaimable — including on the same host. In practice that meant **every** session lasting longer than the window became available to a second writer, which is exactly what the lease exists to prevent.

  On the same host the question "does the owner still exist?" has an exact answer, and age adds nothing to it. The window still applies between different machines, where a process number means nothing.

## 4.33.0

### Minor Changes

- M95 — the single writer actually starts existing, and the session caches gain an owner.

  - **The single-writer guarantee is wired.** It had existed as a function since the version that introduced it and had **no** caller at all: the transcript was never protected. The store now acquires it on the first write and releases it on shutdown.
  - **A dead process no longer locks the session forever.** The lock recorded no owner, so an abruptly terminated interface locked the user out of their own session with no recovery path. The lock now writes `{pid, hostname, mtime}`, and a dead owner — or a lock older than the heartbeat window — yields its place. Between different machines only the window counts, because a process number means nothing outside the host where it was born.
  - **The in-memory session caches stop growing without bound.** Two of the four were never erased per session; now all of them drop when the agent shuts down, and the cached conversation respects a ceiling with least-recently-used eviction.

  ### Corrigido

  - **An absurdly high declared context window is bounded again even without a catalog entry.** The limit only existed when a catalog was present — and the whole reason the declaration exists is the model that has none. One extra zero in the configuration made the agent never compact until the provider refused the turn.
  - **Provider resolution from a model id now uses the canonical parser**, so aliases, capitalization and spaces resolve as everywhere else in the SDK. The previous version redid the split by hand and did not recognize seven valid forms.

## 4.32.0

### Minor Changes

- M94 — publishes four resolvers the SDK already knew internally.

  - **`transcriptRoot()` is exported and honors `THEOKIT_HOME`.** Before, the transcript root ignored the variable while its sibling stores respected it: whoever set it had their state silently split in two, and older sessions vanished from the listing with no error. The fallback is still `~/.theokit` — deliberately **not** the cwd-anchored resolver in `paths.ts`, whose adoption would move the transcript of everyone who does **not** set the variable.
  - **`ModelSelection.contextWindow` reaches the compaction budget.** The resolver had accepted an `override` since the previous version and no production path passed it: a 400k model with no catalog entry was budgeted against the 128k floor and compacted about three times more than it needed to. A value above what the catalog knows is still clamped.
  - **`SessionRecord.message` stops being `Record<string, unknown>`.** The new `TranscriptMessage` describes the shape the writer has always produced. It is **not** called `SessionMessage`: that name already exists with an incompatible shape, and reusing it would repeat an earlier silent break. Reading from disk stays tolerant — what changes is the type.
  - **`Provider.forModel(modelId)`** gives the `provider/model` grammar a single owner. An id without a slash returns `undefined` instead of matching partially, so the caller can tell "non-routable model" from "default path".

  Labelling note: `4.31.1` already contained some of these additions by mistake — it was published as a patch when a minor was correct. Nothing breaks (additions are compatible), and this version declares the surface correctly.

## 4.31.1

### Patch Changes

- M93 — eight fixes from adversarial review.

  - **Retry stops re-running an already partially consumed stream.** A failure after the first event retried the whole turn, duplicating text and `tool_use` blocks — precisely in the scenario that motivated the retry (a 429 after several tool calls).
  - **The transcript is born `0600` again.** The switch to incremental append lost the explicit mode and, under `umask 022`, the file — which carries in-flight content — was born readable by others.
  - **An append over a crash-truncated file no longer swallows the new record.**
  - **Transient errors are now decided by structured status, not by message text.** The previous heuristic classified `ECONNREFUSED ...:443` as non-transient because the port matched the "4xx" pattern: retry was switched off precisely for network failures.
  - **Socket failures are now typed in the Anthropic and OpenAI transports.** Without that, the raw error escaped and no retry policy recognized it.
  - **`CredentialPoolExhaustedError` and an open circuit stop being retried.** The pool already spent its own budget; retrying on top tripled the wait and undid the circuit breaker's fail-fast.
  - Cancellation (`AbortError`) is never confused with a network failure.

## 4.31.0

### Minor Changes

- d8412b6: **A transient provider error stops destroying the whole turn.**

  Three defects that, combined, made the loss total:

  - **The single-key path had no retry.** `buildPoolOrSingle` gave a `PoolAwareLlmClient` — circuit
    breaker, full-jitter backoff, `Retry-After`, rotation — with **>= 2** keys, and the **raw** transport
    with one. A consumer resolving exactly one credential (the common case) always landed on the arm without
    resilience. The asymmetry has no domain justification: **a pool of 1 key is a pool of size
    1**. `RetryingLlmClient` is composition — `computeBackoffMs` and `sleepWithAbort` were already
    independent modules — and it applies to all **three** arms (the ambient pool's was also left out).

  - **The error path persisted nothing.** `run.wait()`'s `catch` called `flushSessionWrites()` and
    returned; `persistTurnToTranscript` is only called later, and it is the repository's only caller. The
    flush drained an **empty** set. It now persists the **partial** — user + completed tool calls —
    without reconstructing what did not happen.

  - **`appendRecords` rewrote the whole file every turn.** O(n) of I/O **and** of parsing on every turn,
    O(n^2) per session. Correct because the format **is already append-only** (the `parentUuid` DAG does not depend on
    line order), and `appendJsonl` **already existed** in the package with a single caller. `withFileLock`
    stays — it is what serializes concurrent appends.

  Only a **transient** error is retried: 402 (billing) is not, because a quota does not resolve in milliseconds, and
  a 401 fails on the first. Ceiling of 3 attempts, `AbortSignal`-aware.

### Patch Changes

- f76ed61: Corrige o docstring de `Agent.getOrCreate`, que afirmava o oposto do comportamento real.

  Ele dizia: _"Disposed agents are NOT auto-deleted from the registry. To force a fresh agent, call
  `Agent.delete(agentId)` first."_ Measured, that is false — `dispose()` calls `liveAgentRegistry.forget(id)`,
  so the next `getOrCreate(id)` builds a fresh handle, with no `Agent.delete`.

  The claim was about the **persistent** registry and was read as being about the **live cache**; a
  consumer built on the wrong half. Locked by `tests/m91-getorcreate-after-dispose.test.ts`.

  The new bullet also records what remains true: `close()` marks the handle disposed **without**
  evicting the cache entry. It is internal and has no caller today; if it becomes reachable again, the bullet stops
  holding for that path — and it is written down so the next person need not rediscover it.

## 4.17.1

### Patch Changes

- fix(session): hydration REPLACES the cache from disk (source of truth) instead of skipping when non-empty — after an invalidation (compact/inject), an in-flight turn repopulating the cache with one message used to pin the parent to a 1-message context until restart (M51 review F4; race test added).

## 4.17.0

### Minor Changes

- feat(session): `Agent.injectSessionTurn(agentId, {userText, assistantText})` — append a SYNTHETIC user+assistant pair to a local session's persisted transcript WITHOUT running an LLM turn (the Codex review-exit mechanism: the parent conversation "learns" a result for follow-ups). Chains onto the DAG leaf, invalidates the in-memory cache, serialized on the per-agent write chain (M51 agent-builder).

## 4.16.7

### Patch Changes

- fix(session): a model-prefix profile only wins the summarizer route when its credential is actually RESOLVABLE (oauth/none own their auth; api_key needs one of the profile's env vars set) — an `openai` prefix with only OPENROUTER_API_KEY in the environment now falls through to env detection instead of failing with "No provider client".

## 4.16.6

### Patch Changes

- fix(session): the summarizer route precedence now mirrors the run's M4 rule EXACTLY (extracted as the pure, unit-tested `resolveSummarizerRoute`): explicit key's provider > model-prefix profile (oauth builtin / M45 fleet) > env detection. The 4.16.5 ordering put the prefix profile first, so an sk-or- key + `openai/…` model 401'd against the OpenAI platform (found live).

## 4.16.5

### Patch Changes

- fix(bundle): the M50 compaction wiring used dynamic imports of modules ALSO imported statically elsewhere — esbuild wrapped them in lazy `__esm` init blocks and static importers saw an undefined module state in the PUBLISHED dist only (`hydratedKeys.has` TypeError on every Agent.create; src/tests were unaffected — the adversarial-dist class again). All compaction imports are now static; the only dynamic edge left is agent-session→compact-session (the cycle breaker). Dist-level smoke added to the release ritual.

## 4.16.4

### Patch Changes

- fix(session): M50 adversarial-review fixes — (F1 BLOCKER) compaction now INVALIDATES the in-memory session cache, so the live process feels the compact on the very next send (it used to keep sending the full pre-compact history until restart); (F3) the auto-trigger uses the LAST request's usage as the active-context proxy (the across-rounds aggregate fired prematurely on agentic turns); (F5) `Agent.compact` serializes on the per-agent write chain (a manual compact can no longer interleave with an in-flight turn — race test added); (F6) the summarizer routes through the model-prefix provider PROFILE when registered (oauth `openai-chatgpt` builtin owns its auth; M45 fleet resolves its own env) before falling back to key/env inference; (F2) once-per-process WARN when the model has no catalog context window + gpt-5.x family added to the catalog (400k) with the `openai-chatgpt` alias so the product default can actually trigger; (F8) the user message that overflows the 20k preservation budget is TRUNCATED and kept (Codex parity) instead of dropped.

## 4.16.3

### Patch Changes

- fix(session): compaction summarizer falls back to the ENV-detected provider when no explicit key exists (the persisted registry never carries credentials) — a fresh-process `/compact` with only OPENROUTER_API_KEY in the environment now routes via OpenRouter instead of failing on the model-prefix provider.

## 4.16.2

### Patch Changes

- fix(session): `Agent.compact` hydrates the per-cwd registry from disk on a miss (same D21 path as `Agent.resume`) — a fresh process compacting a persisted session no longer fails with UnknownAgentError. Found live in the M50 probe.

## 4.16.1

### Patch Changes

- fix(session): the compaction summarizer resolves its provider the same way the RUN does (M4 rule — the explicit API key outranks the model prefix): an sk-or- key + `openai/…` model summarizes via OpenRouter with the full slug, instead of 401ing against OpenAI. Found live in the M50 tmux probe.

## 4.16.0

### Minor Changes

- feat(session): context compaction, Codex-faithful (M50 agent-builder). `Agent.compact(agentId)` summarizes a local session's persisted transcript — recent USER messages preserved verbatim (20k-token budget, prior summaries filtered by marker) + one marker'd handoff summary as a user message — appended AFTER a `compact_boundary` (append-only; resume replays replacement + later turns). Size-driven AUTO-compaction fires in the persistence chain when the run's REAL usage crosses 90% of the model's catalog context window (Codex formula `(cw*9)/10`; missing usage/window never fires), with an anti-cascade guard (one attempt per turn). The summarizer is the compression subsystem's aux-LLM (`compressConversationWindow` — its first real caller). BREAKING-ish fix: the old 50-turn `compact_boundary` stub (no summary — it silently amnesia'd resumes) is REMOVED.

## 4.15.4

### Patch Changes

- fix(persistence): the node:sqlite fallback now resolves via `process.getBuiltinModule` — the published bundle's esbuild predates the sqlite builtin and rewrote `import("node:sqlite")` to a bare `sqlite` package specifier, so the 4.15.3 fallback failed at runtime in the DIST while passing against src (adversarial-dist lesson, again).

## 4.15.3

### Patch Changes

- fix(persistence): implement the `node:sqlite` fallback the SQLite driver-load error message has always promised — on Node 22.5+ without the optional `better-sqlite3`, memory tools now work via the built-in driver (adapter shims `pragma()`; `loadExtension` degrades with a clear error). Previously only better-sqlite3 was tried, so every consumer without the native dep silently lost memory tools.
- fix(memory): the "memory tools unavailable" WARN is now emitted ONCE per process per distinct message (globalThis registry) — it used to repeat on every `Agent.create` (the TUI creates one per turn), and raw stderr mid-frame corrupts Ink-style renderers (the flicker/duplicate-greeting bug).

## 4.15.2

### Patch Changes

- fix(providers): M47 adversarial-review fixes on the dynamic-loader trust gate — (F1) `Agent.resume` now runs provider-plugin discovery (a fresh process resuming a persisted agent whose model targets a plugin provider no longer fails resolution); (F2) `Theokit.models.list({provider})` local path runs discovery too (sync surfaces stay builtins-only, documented); (F3) the discovery idempotence flag moved to `globalThis` (`Symbol.for`) matching the registry's M44 B1 pattern — no duplicate discovery per bundle entry; (F4/F7) the NOT-trusted WARN now says "then restart the process" and documents the comma-separated env format; (F5) non-string entries in a valid trust-file array WARN instead of being silently discarded.

## 4.15.1

### Patch Changes

- fix(providers): wire `discoverProviderPlugins()` into `Agent.create` — the dynamic provider-plugin loader (and its M47 trust gate) was exported but never invoked on any production path, making the whole discovery surface dead code at runtime. Discovery now runs upfront on agent initialization (idempotent, fail-tolerant), honoring the `resolveProviderChain` contract.

## 4.15.0

### Minor Changes

- Dynamic provider-plugin trust gate (agent-builder M47): the out-of-tree loader (`~/.theokit/plugins/model-providers/<name>/index.{js,mjs}` — the documented extension path for shipping a provider as a package) now requires EXPLICIT human trust before any dynamic import. A plugin's code executes at import time (an arbitrary-code-execution surface), so nothing is evaluated unless the plugin name is listed in `~/.theokit/plugins/trusted-providers.json` (a JSON string array — the auditable primary) or the additive `THEOKIT_TRUSTED_PROVIDERS` env (comma-separated). Fail-closed: a missing or malformed trust file trusts NOTHING (malformed WARNs); an untrusted plugin is skipped with an actionable WARN naming the file to edit — its code is NEVER evaluated (proven by an import-side-effect fixture test). **BREAKING (deliberate security fix):** previously ANY package dropped into the plugins dir executed unguarded; existing plugin users must add their plugin names to the trust file (the WARN says exactly how).

## 4.14.1

### Patch Changes

- M45 adversarial-review fixes: (H1) a malformed `baseUrl` (scheme-less host, empty env var) no longer throws an untyped `TypeError` from the OpenAIClient CONSTRUCTOR — poisoning the whole provider chain at `resolveProviderChain` time even when only a fallback was misconfigured; the URL parse now degrades to the legacy `/v1/chat/completions` path (byte-identical to pre-M45) and fails typed at fetch time. (M2) re-running `registerBuiltins()` across bundle copies (`@theokit/sdk` + `@theokit/sdk/models`) no longer emits 19 bogus `overridden by user plugin` WARNs — the guard lives on `globalThis` like the registry itself. (M3) a trailing-slash versioned baseUrl (`…/v1/`) now joins cleanly (no `/v1//chat/completions`). (L1) the `google` builtin also honors `GOOGLE_GENERATIVE_AI_API_KEY` (the ai-sdk convention). (L4) `getCatalogCapabilities` resolves entry aliases (e.g. `google`). NOTICE extended for the M45 adaptations. **Migration note (M1):** the chat-completions URL-join now detects version segments ANYWHERE in the baseUrl path — a gateway mounting an OpenAI-compat surface under a versioned prefix (e.g. `https://gw.corp/v2/tenants/x`) that previously got `/v1/chat/completions` appended now gets `/chat/completions`; declare `chatCompletionsPath` on the profile to pin an exact path.

## 4.14.0

### Minor Changes

- Data-provider fleet (agent-builder M45): 9 new first-party builtins on a data-only `openAiCompatibleProfile` base — `google` (DIRECT Gemini via the OpenAI-compat endpoint, `GOOGLE_API_KEY`/`GEMINI_API_KEY`; distinct from the `gemini` OpenRouter passthrough), `mistral`, `groq`, `cohere` (via `api.cohere.ai/compatibility/v1`), `deepinfra`, `together` (alias `togetherai`), `xai` (alias `grok`), `perplexity`, `cerebras` — each ~10 lines with source-cited values. Two defects fixed: the chat_completions URL-join no longer doubles version segments (`…/v1/v1/chat/completions` — every version-suffixed catalog baseUrl was broken for streaming) via version-segment detection + a data-only `ProviderProfile.chatCompletionsPath` escape (existing builtins byte-identical, contract-asserted), and Google is finally reachable (the `google-gemini` catalog entry was silently skipped by an alias collision). The `anthropic_messages` transport now consumes `extraHeaders` + the provider `transform` (mirror of the M41 chat_completions wiring) and the anthropic builtin ships `anthropic-beta: interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14` (the sanctioned behavior delta); openrouter gains theokit's own attribution headers (`HTTP-Referer: https://usetheo.dev`, `X-Title: theokit`); cerebras sends `X-Cerebras-3rd-Party-Integration: theokit`. A table-driven contract suite asserts identity + the EXACT wire URL and headers per provider.

## 4.13.1

### Patch Changes

- M44 adversarial-review fixes for the model catalog: (B1) the provider registry + model-info index now live on `globalThis` via `Symbol.for` so every bundle copy (`dist/index.js`, `dist/models.js` — tsup bundles entries separately) shares the SAME state — previously `refreshModelCatalog` from `@theokit/sdk/models` patched a bundle-local index invisible to capability/pricing lookups and saw an empty registry (a published-artifact-only defect the src-level tests could not catch); (H2) a live models-dev patch is now a per-field MERGE that preserves theokit extension fields (`cache_control`, overlay `structured_output`) instead of a wholesale replace that wiped them; (H3) the runtime refresh gained the models.dev↔theokit id mapping (google↔google-gemini, zai↔zhipu, togetherai↔together, fireworks-ai↔fireworks, amazon-bedrock↔bedrock, google-vertex↔vertex) resolving against catalog entries (id + aliases) with a WARN for skipped unknowns — Google/Z.AI/Together/Fireworks now actually refresh; (M4) `refreshModelCatalog` self-initializes provider registration so the `/models` subpath works standalone; (M5) pricing provenance is honest post-refresh (`catalog-models-dev` vs `catalog-vendored`); (M6) the anthropic builtin defaults (opus-4-7 / sonnet-4-6 / haiku-4-5) now carry `cache_control: true` in the vendored catalog; (L8) the models-dev cache honors `THEOKIT_HOME`; (L9) a missing/corrupt vendored catalog degrades with WARN instead of throwing from `resolveModelCapabilities`, cache patch errors never delete a valid cache, and refresh never rejects; (L10) the pricing step-5 fallback also tries the date-stripped id; (L11) falsy `THEOKIT_DISABLE_MODELS_FETCH` values (`0`/`false`/empty) no longer disable the fetch.

## 4.13.0

### Minor Changes

- Model catalog enrichment (agent-builder M44): the vendored `provider-catalog.json` now carries OPTIONAL per-model data (`models` block — models.dev shape verbatim: `cost{input,output,cache_read,cache_write}` USD-per-1M, `limit{context,input,output}`, `modalities`, `tool_call`/`reasoning`/`structured_output`/`cache_control`, `release_date`, `status`), loaded into an internal model-info index keyed `provider/model` (entry id + aliases). Fully additive: entries without `models` behave byte-identically, `ProviderProfile` is untouched, the 10 builtins + all 43 catalog entries keep resolving, and a malformed model sub-entry drops that model with WARN keeping the provider. DRY reconciliation: `resolveModelCapabilities` is now catalog-backed (the hand-curated EXACT map migrated into the catalog and was deleted — parity-tested over the full old-map snapshot), and `getPricingEntry` gains a step-5 catalog fallback on total LiteLLM miss (provenance `pricingVersion:"catalog-vendored"`; the LiteLLM snapshot keeps absolute precedence — and the new drift advisory caught a real stale rate: `openai/o3` corrected 10/40 → 2/8). New on `@theokit/sdk/models`: `getModelInfo(modelId)` (the enriched per-model view) and `refreshModelCatalog({url?, force?})` — an EXPLICIT opt-in models.dev refresh with a 1h-TTL atomic disk cache under `~/.theokit/cache/models-dev/`, kill-switch `THEOKIT_DISABLE_MODELS_FETCH`, and the vendored catalog as offline fallback; startup and requests never touch the network. Maintenance: `scripts/refresh-catalog.mjs` regenerates the curated vendored subset (30 models, +36KB).

## 4.12.2

### Patch Changes

- Fix (agent-builder M43): the `openai-chatgpt` builtin's ambient credential store now uses a DEDICATED `THEOKIT_AUTH_HOME` env override instead of `THEOKIT_HOME`. `THEOKIT_HOME` is the SDK's whole home directory (personality, credential-pool, profiles) — overloading it to point the credential store redirected the entire runtime and broke non-Codex model resolution. `THEOKIT_AUTH_HOME` points ONLY the credential store; unset, the store defaults to `~/.theokit/auth.json`.

## 4.12.1

### Patch Changes

- `Provider.builtins()` (agent-builder M43): returns every first-party builtin provider — including the `openai-chatgpt` Codex builtin — as model-provider plugins. A runtime that does NOT share the SDK's provider registry (the `theokit` agent server / `@theokit/agents`, which resolve models via their own `buildModelSelection`) can now route to any SDK builtin with ZERO provider-specific code: `Agent.create({ plugins: Provider.builtins() })` (or the agents `.plugins(Provider.builtins())`), then pick a `provider/model` id. Adding a provider stays one SDK file — it is auto-included. The full ProviderProfile (transport + the auth `transform`) rides along into the consuming runtime.

## 4.12.0

### Minor Changes

- Codex provider as a builtin (agent-builder M43): a new first-class `openai-chatgpt` builtin `ProviderProfile` routes `openai-chatgpt/<model>` ids to the ChatGPT "Codex" backend (`https://chatgpt.com/backend-api/codex`, `responses_api`). Its `transform.fetch` resolves the LIVE credential from the ambient store per HTTP request — a freshly-refreshed Bearer + a dynamic `ChatGPT-Account-Id` header — so a mid-turn token expiry refreshes transparently with NO agent rebuild, and a not-logged-in request fails fast (no placeholder on the wire). The ambient store is `~/.theokit/auth.json` with a `THEOKIT_HOME` override so a consumer points it at its own store. Two account_id lifecycle fixes ship alongside: `ensureFreshCredential` now PRESERVES a stored `account_id` across refresh (OpenAI's refresh JWTs carry no top-level `account_id`), and `openaiDeviceLogin` JWT-extracts `chatgpt_account_id` at login. Consumers add a provider in one SDK file; the Codex backend needs zero provider logic in the app.

## 4.11.1

### Patch Changes

- Auth subsystem review fixes (agent-builder M42), grounded in the provider-auth model: (1) an oauth provider that resolves NO credential now fails fast with a `ConfigurationError` (the `MissingCredentialError` analog) instead of putting the `__oauth_lazy_token__` placeholder on the wire — a placeholder is never sent; (2) `resolveCredential` no longer attributes a provider-less or mismatched-provider stored key to the requested provider (fail-closed — prevents cross-vendor key exposure, e.g. an Anthropic key POSTed to api.openai.com). The credential store/engine mechanics are unchanged.

## 4.11.0

### Minor Changes

- Auth subsystem (agent-builder M42): a new `@theokit/sdk/auth` sub-entry ships a credential store + OAuth engine, promoted DOWN from agent-builder's hardened M37 code, generalized to `provider: string` + a caller-supplied `CredentialStoreConfig` (no hardcoded client IDs). Public surface (`import { … } from "@theokit/sdk/auth"`): `resolveCredential(name)` returns a fresh (transparently-refreshed) `ResolvedCredential`; the credential store (`writeCredential`/`readAuthFile`/`readStoredOAuth`/`authFilePath`/`credentialHome`/`CredentialError`), the OAuth engine (`exchangeCode`/`refreshOAuthTokens`/`ensureFreshCredential`/`persistOAuthTokens`), the device flows (`deviceLogin`/`openaiDeviceLogin`/`requestDeviceCode`/`pollDeviceToken`/`requestOpenAIUsercode`/`parseJwtClaims`/`extractAccountId`), and the contract types (`CredentialStoreConfig`, `ResolvedCredential`, `StoredOAuthCredential`, `OAuthProviderConfig`, `OAuthTokens`, `HttpDeps`, `DeviceOAuthConfig`, `OpenAIDeviceConfig`, …). It sits at a dedicated sub-entry (DTS via tsc) — the same isolation as `@theokit/sdk/messages` / `/subscription` / `/sanitize` — because rollup-plugin-dts cannot bundle the modules into the main barrel. The credential store does an atomic O_EXCL + rename + fsync write at mode 0600 with 0700/0600 mode gates; the OAuth engine implements RFC 8628 device-grant + the OpenAI two-step headless flow + token exchange/refresh with in-flight-refresh coalescing (keyed by store path, rejected promise evicted — single-use refresh tokens are never double-spent) and a no-token-in-error discipline. The router's lazy-sentinel path now covers `oauth_device_code` / `oauth_external` so an oauth provider builds a client whose M41 `transform.fetch(ctx)` owns the fresh bearer at stream time — a mid-turn expiry refreshes without rebuilding the agent, and plain (api-key/env) profiles resolve byte-for-byte unchanged.

## 4.10.1

### Patch Changes

- Provider transform seam hardening (agent-builder M41 review): `OpenAIClient` now honors `extraHeaders` so `chat_completions` providers get `transform.headers` (previously silently dropped); the `transform` seam is invoked per-branch (no side effects for transports that ignore it); `ProviderTransform` + `ProviderTransformContext` are re-exported from the package entry; added back-compat golden tests (plain `responses_api` passthrough) + a `chat_completions` transform.fetch test.

## 4.10.0

### Minor Changes

- Provider `transform` seam (agent-builder M41): `ProviderProfile` gains an optional `transform` (dynamic `headers(ctx)` + refresh-aware `fetch(ctx)`), fed through `selectTransport` into the `chat_completions` + `responses_api` transports — a provider can now own its per-request auth/headers. A profile without `transform` takes the static path byte-for-byte.

## 4.9.1

### Patch Changes

- Responses transport strips a `provider/` prefix from the model id (defense-in-depth: the ChatGPT Codex backend wants a bare `gpt-5.4`, decoupled from the router's provider-inference heuristic).

## 4.9.0

### Minor Changes

- `responses_api` transport (agent-builder M40): a `ResponsesApiClient` for the OpenAI Responses API (ChatGPT Codex backend + any responses provider). The `responses_api` apiMode was declared but had no transport (`selectTransport` threw); this ships it — body build + SSE state machine, consuming `baseUrl` + `extraHeaders`. Recorded fixtures serve as golden tests.

## 4.8.0

### Minor Changes

- `Agent.rename(agentId, name)` (agent-builder M39): the public mutator for the registry `name` field (mirrors `Agent.archive`/`setArchivedFlag`). The registry already carried `name` (`SDKAgentInfo.name`) but had no public setter.

## 4.7.1

### Patch Changes

- ef7e172: M35 review follow-ups (fail-fast, no silent drop): a `{ url }` `SDKImage` is now forwarded as an `image_url` with the URL directly on OpenAI/OpenRouter (previously silently dropped in `buildUserContent`); and the ollama-native provider throws a typed `ConfigurationError` on an image part instead of silently discarding it (images require an OpenAI/OpenRouter model). `LlmImagePart.source` gains a `{ type: "url" }` variant.

## 4.7.0

### Minor Changes

- 6871152: M35 (multimodal) — implement image input end-to-end. `agent.send({ text, images })` (the `SDKUserMessage` form) previously carried the `images` TYPE but the runtime dropped them (only `.text` was used). Now `prepareRunContext` carries the images, the agent loop attaches them as `image` content parts (new `LlmImagePart`), and the provider adapters serialize them: OpenAI/OpenRouter to a content-array with an `image_url` data URL, Anthropic to a native base64 image block. Text-only turns are byte-unchanged (back-compat). Zero new dependencies.

## 4.6.1

### Patch Changes

- 4b70ff1: Per-subagent config (M33) review fixes.

  - **Sandbox is no longer default-open.** A delegated child of a sandboxed parent now inherits the parent's shell-sandbox posture unless its role opts out; `AgentDefinition.sandbox` absent ⇒ inherit (as documented), `sandbox: false` explicitly confines-off, `sandbox: true` confines-on. Previously a child ran unsandboxed whenever its role omitted `sandbox` — a default-open the wiring exists to prevent.
  - **`model: inherit` + `reasoning_effort` is now a typed load error** instead of silently dropping the effort (the inherited model id is unknown at load, so the `thinking` param has nothing to attach to).
  - **`tools` and `sandbox` now survive persist→resume** for inline subagents (`serializeAgents`); dropping them was a default-open on resume (a confined child came back unconfined). The model's reasoning `params` are persisted too. `mcpServers` stays stripped (may carry secrets).
  - **Quoted `model`/`reasoning_effort` scalars are stripped** (`model: "openai/gpt-4o"`), which previously passed validation and failed only at the provider.

  Note on the 4.6.0 loader: rejecting unknown/unsupported frontmatter fields is a fail-closed **contract narrowing** (pre-4.6.0 silently dropped them), not a pure addition. Every subagent role in the ecosystem uses only accepted fields, so there is no known real-world break, and the failure is a diagnosable typed `ConfigurationError` — but downstreams pinned to `^4.5` whose roles carried extra keys should be aware.

## 4.6.0

### Minor Changes

- c5951b9: Per-subagent config through the LOCAL delegation path. A disk-loaded subagent (`.theokit/agents/*.md`) may now set its own `model`, `reasoning_effort` and `sandbox`, and each reaches the spawned child — previously the local delegation seam narrowed an `AgentDefinition` to `{model.id, tools}` and dropped everything else.

  - `reasoning_effort` rides inside the model as `model.params: [{ id: "thinking", value }]`; the spawn now carries the whole `ModelSelection` (with params) instead of only `.id`.
  - `sandbox: true` (new optional `AgentDefinition.sandbox` boolean) forwards to the child as `local.sandboxOptions.enabled`. The SDK has no granular sandbox _mode_; a mode string is a typed load error, not a silent boolean coercion.
  - The subagent loader now rejects unknown or unsupported frontmatter fields with a typed `ConfigurationError` naming the file and field (previously silently dropped): an unknown key, a non-boolean `sandbox`, `reasoning_effort` without a `model`, and `mcp` (not yet honored on the local delegation path — declare MCP servers in `.theokit/mcp.json` instead). Every `.theokit/agents/*.md` in the ecosystem already uses only accepted fields, so this is fail-closed with no real-world break.
  - `buildChildCreateOptions` is now exported for testing the built child `AgentOptions`.

## 4.5.1

### Patch Changes

- e39cdf6: docs: ship the reference docs inside the npm package. `harness-capability-map.md` (every public primitive + its import path) and `error-codes.md` (the `AgentRunError.code` table) are now readable offline at `node_modules/@theokit/sdk/docs/`, pinned to the installed version — useful for agents that read their own dependencies, and for air-gapped setups. They live at the repo root (linked from the root README/CONTRIBUTING/CLAUDE.md) so `build` copies them into the package via `scripts/copy-docs.mjs`, rewriting repo-relative links to absolute GitHub URLs so they still resolve from `node_modules`. A `tests/lint/shipped-docs.test.ts` gate fails if `files` drops the `docs` entry or a new root reference doc is not added to the ship list. Tarball grows ~7 KB. The package README now also points agents at the docs site's machine-readable corpora (`llms.txt` / `llms-full.txt`).

## 4.5.0

### Minor Changes

- 283dca0: feat(eval): eval-as-CI-test primitives (SE41). Adds the pieces that turn `@theokit/sdk/eval` into a regression gate you can drop into a pipeline:

  - **`assertEval(run, thresholds)`** — a pure gate over an `EvalRun` that throws `EvalThresholdError` (carrying the full list of unmet thresholds) when a run misses `minMeanScore`, `minPassRatio`, `maxErrorRatio`, or any `perScorer` floor. Passing returns `void`, so it drops straight into a Vitest `it(...)` or a standalone eval script whose non-zero exit fails CI.
  - **Three new scorers** — `Scorers.levenshtein()` (normalized edit-distance similarity, deterministic), `Scorers.numericDiff()` (relative numeric closeness, deterministic), and `Scorers.embeddingSimilarity()` (cosine of output vs expected embeddings via OpenRouter, or an injected `embed` for other providers/tests). The two deterministic scorers always run in CI with zero token spend.
  - **`EvalOptions.trials`** — repeat each dataset row N times and collapse to one row whose per-scorer score is the mean over the trials (an errored trial contributes 0), smoothing single-model non-determinism. `EvalRowResult.trialCount` records the collapse.
  - A `pnpm eval` script + an OpenRouter-gated `eval` CI workflow run the new `tests/eval/suites/**` eval suites; the deterministic gate also runs on every `pnpm test`.

### Patch Changes

- 8932068: fix(build): emit `@theokit/sdk/interactive` CJS type declarations (`dist/interactive/index.d.cts`). The subpath was added to `tsconfig.tools-dts.json` (so `.d.ts` shipped) but omitted from `scripts/mirror-dts-to-cts.mjs`, so `exports["./interactive"].require.types` pointed at a file that was never generated — `publint` and `arethetypeswrong` both flagged it ("No types" from CJS). A CJS `require("@theokit/sdk/interactive")` now resolves its types. Added `dist/interactive` to the mirror target list with a note about the drift trap.

## 4.2.10

### Patch Changes

- aaa3e36: fix(a2a): subagent child now inherits the parent's `apiKey` + child errors surface instead of `"(no response)"` (#143). Two bugs kept a `SubAgent` child from ever returning content when driven through a host that reaches the `/a2a` build copy (e.g. the `@theokit/agents` in-process adapter): (1) the credential-inheritance sink key was a unique `Symbol()`, so with `tsup splitting: false` the local runtime (bundled in `.`) and a `SubAgent` created via `@theokit/sdk/a2a` used DIFFERENT sink symbols — the child inherited no `apiKey` and failed with `provider_unresolved`; now a shared `Symbol.for` key (same fix class as #142). (2) `runChildAgent` read only `result.result`, so an errored child was silently swallowed to `"(no response)"` and the parent looped on it — it now throws the child's error (Rule 8, fail-fast). Adds regression tests (global sink key; error surfaced). Validated end-to-end: a delegated child (reasoning and tool-using) now returns its answer.

## 4.2.9

### Patch Changes

- d12634e: fix(a2a): register the `Agent` facade on a process-global `Symbol.for` slot so `SubAgent` works across build entries (#142). Each public entry (`.`, `./a2a`, `./cron`, `./eval`, …) is bundled with `tsup splitting: false`, which inlines its own copy of the internal `agent-factory-registry` — a module-level `let` gave each copy a private registration slot, so a subagent invoked through `@theokit/sdk/a2a` read a slot the `.` entry (via `agent.ts`'s `setAgentFacade`) never set, throwing `internal: Agent facade not registered` even when the main entry was loaded first. The registry now stores the facade on `globalThis[Symbol.for("theokit.internal.runtime.agentFacade")]`, so all duplicated copies share ONE registration. Adds regression tests. No public API change.

## 4.2.8

### Patch Changes

- feat(init-claude): the scaffolded `.claude/` template now covers **every public `@theokit/sdk` subpath**. Added 16 per-module skills — models, subagents (`/a2a` + tool-scope), retry, task-store, sandbox, compaction, messages, auth (`/server/auth` + errors-envelope), sanitize, skills, path-safety, concurrency, persistence, client, filesystem, project — each authored against the shipped type declarations (verified signatures: `Retry.create` executor, `Semaphore.create`, `SubAgent.create`, `Auth.create`, `sanitizeToolInput`, …). The `claude-template-no-drift` gate covers the expanded set.

## 4.2.7

### Patch Changes

- fix(init-claude): the scaffolded `.claude/` template (`npx theokit-init-claude`) now teaches the current `X.create()` API instead of the pre-3.0 surface removed by SE36 (#139). `AGENTS.md` + the affected skills/rules were corrected: `defineTool`→`Tool.create`, `defineSubscription`→`Subscription.create`, `createAgentFactory`→`AgentFactory.create`; the tool spec field is `handler` (not `execute`); streaming events are `system`/`user`/`assistant`/`thinking`/`tool_call`/`status`/`task`/`request` (there is no `tool_use`/`tool_result`/`usage`/`error`); assistant text is `event.message.content`; `Agent.prompt(prompt, options)` (prompt first); built-in coding tools import from `@theokit/sdk-tools` (not a `@theokit/sdk/tools` subpath). The phantom `theokit-rag` skill and the non-existent `@theokit/sdk/rag` import were removed. A `tests/lint/claude-template-no-drift.test.ts` gate now fails CI if the scaffold teaches a removed factory, phantom subpath, or non-existent stream event.

## 4.2.6

### Patch Changes

- docs: use the transparent `logo-128.png` in the README hero instead of the opaque `logo.png` (which shows a solid background on GitHub/npm dark themes). No code or public API change.

## 4.2.5

### Patch Changes

- chore: correct the GitHub repository URL in package metadata (`homepage` / `bugs` / `repository`) from the non-existent `usetheo/theokit-sdk` slug to the canonical `usetheodev/theokit-sdk`, so the npm "Repository" link resolves. No code or public API change.

## 4.2.4

### Patch Changes

- docs: README marketing pass for the OSS launch. Punchier scannable hero with a real-numbers metric line (43 built-in LLM providers, 27 modular entry points, native Claude Code `.jsonl`, zero walk-away cost), a value-first "Why" bullet cluster above the fold, and a social-proof badge row (npm version, monthly downloads, GitHub stars, Discord). The narrative moved down to intro the concrete "What you'd ship" use cases. Cloud stays explicitly labeled pre-release. No code or public API change.

## 4.2.3

### Patch Changes

- docs: professionalized the README for OSS publication and made the exported TypeScript types the canonical public contract. Removed the drifted `docs.md` API-contract file (it still documented the old `nextTheo` pagination field while the code returns `nextCursor`); `docs/harness-capability-map.md` + `docs/error-codes.md` are the human-friendly references. Fixed broken links, placeholder prose, a wrong API name in an example, a stale version claim, and capability claims that belong to other packages. No code or public API change.

## 4.2.2

### Patch Changes

- Internal cleanup + dead-code hardening (no public-API change; exported names byte-stable).

  - Removed 21 dead internal symbols the `quality:dead` gate could not see (knip ignores `src/internal/**`), plus dead test-seam helpers, with cascade cleanups.
  - Added a `quality:dead-internal` gate (`tools/check-internal-deadcode.mjs`) that fails the build on any orphaned `**/internal/**` export OR unused private top-level declaration — closing the internal dead-code blind-spot.
  - Tightened `tsconfig.base.json` (`noUnusedLocals` + `noUnusedParameters` + `allowUnreachableCode: false`) and removed the write-only `_truncated` flag in `@theokit/sdk-tools` shell-exec (capping behavior unchanged).
  - Repo/docs hygiene: trimmed `docs/` to 3 files (the code is the documentation), consolidated the knowledge base, and cleaned repository history.

## 4.2.1

### Patch Changes

- SE45 + SE46 — internal structural refactor (zero public-API change).

  - **SE45 — zero import cycles.** Eliminated all 3 madge import cycles in `packages/sdk/src` (3 → 0) and tightened the `quality:cycles` gate to threshold 0. Restored DIP direction by relocating the `ToolResultGuardOptions` and `SDKAgent`-cluster contract types out of `internal/` into `types/` (re-exported for back-compat), and routed `a2a/subagent` child creation through the existing `getAgentFacade()` registry seam instead of a dynamic `import("../agent.js")`. Closed #129 (pure plugin type-guards moved to `internal/plugins/plugin-guards.ts`).
  - **SE46 — internal/ structural cohesion.** One-home-per-concept co-locations (budget tracker → `internal/budget/tracker/`; OpenTelemetry `tracer-loader` → `internal/telemetry/`), two loose files relocated to their natural homes, DIP direction restored for 4 more contract types (`EnvPolicy`, `BudgetTracker`, `SessionRecord`, `MemoryProvider` → `types/`), and removal of the dead `internal/cache-discipline-guard.ts` (#131, tested-but-unwired). An independent architecture re-audit scored `packages/sdk/src` at 96/100 ("Keep"), up from a 78/100 baseline.

  Behavior-preserving: `@theokit/sdk` public barrel exported names are byte-stable (147 = 147), all relocated runtime files are byte-identical or clean 1:1 type moves, and the full workspace `validate` (typecheck + 3501 sdk tests + madge 0 + depcruise + publint + bundle-budget) stays green.

## 4.2.0

### Minor Changes

- 453ad2d: SE43 — system-design audit fixes (public-surface changes).

  - **`@theokit/sdk` (minor):** the shared persistence kernel is now reachable from the sanctioned public `@theokit/sdk/persistence` barrel — `withCwdMutex`, `sanitizeFts5Query`, and `PersistenceSchema` are added (joining `replaceFileAtomic` / `openSqliteResilient` / `atomicWriteText` / `atomicWriteJson`). The `@theokit/sdk/internal/persistence` export is now **deprecated**: it re-exports its full surface unchanged for one release (back-compat) and is scheduled for removal in a future major. No breaking change; existing imports keep working.
  - **Satellites (patch):** `sdk-tools` / `sdk-memory` / `sdk-cache` / `sdk-handoff` / `sdk-budget` tightened their `@theokit/sdk` peer-range floor from `>=1.7.0` to `>=4.0.0`, matching the v4-only surfaces they import (prevents a non-workspace install resolving an incompatible old sdk).

## 4.1.0

### Minor Changes

- c4d410c: SE41 — pluggable `SessionStore` seam over the native transcript. A minimal, two-method public port (`SessionStore.readRecords(agentId)` / `appendRecords(agentId, records)`) over the native `SessionRecord` shape, injected via `local.sessionStore`, so an external store (Postgres / Redis / KV / durable object) can be the **primary store AND resume source** — restoring the serverless (ephemeral FS) and multi-host / multi-pod resume use case SE40 dropped when it removed `ConversationStorageAdapter`, WITHOUT reverting that removed ~10-method adapter. DEFAULTS to a shipped `FsSessionStore` that reads and append-writes the native Claude-shaped `.jsonl` transcript (the same file the Claude Code CLI can `--continue`), so omitting `sessionStore` is byte-identical to current behavior — zero consumer change. Resume works across a simulated cold start (`Agent.resume(agentId, { local: { sessionStore } })` rebuilds history via the native DAG reader over `await store.readRecords(agentId)`); append-only compaction (`compact_boundary`) flows through `appendRecords`. `readRecords` throwing on resume surfaces as a typed error (fail-fast — never a silent empty history that would drop the conversation). Additive and back-compat.

## 4.0.2

### Patch Changes

- docs(readme): highlight the native Claude Code session interop in the package README — a local agent's conversation is a native Claude Code `.jsonl` transcript, so pointing `baseDir` at `~/.claude` lets the Claude Code CLI `--continue` a session the agent wrote. Also correct the stale "this package is a scaffold" Status line (the SDK shipped v4). Docs-only; no runtime change.

## 4.0.1

### Patch Changes

- 2e8295e: SE40 cleanup — remove the dead `GoalOptions.threadId` option. It resolved the goal from the SE33 durable thread-scoped objective, which was removed in v4.0; the field was left in the public type but is no longer read by `runUntil` (a no-op in 4.0.0). Removing it completes the "no legacy kept" contract of the v4.0 virada. `runUntil(goal, options)` is unaffected — pass an explicit goal (a call with no goal pauses).

## 4.0.0

### Major Changes

- SE40 — native Claude-shaped session format (v4.0, breaking). The local session store IS the native Claude Code `.jsonl` transcript: a `uuid`/`parentUuid` DAG of records with structured `text` / `thinking` / `tool_use` / `tool_result` blocks at `<baseDir>/projects/<encoded-cwd>/<agentId>.jsonl`. Sessions WRITE natively (from `run.conversation()`), READ/resume by reconstructing the DAG, and compact append-only (`compact_boundary` records — the transcript never shrinks). New `local.baseDir` option (default `~/.theokit`; a leading `~` is expanded; set `~/.claude` so the Claude Code CLI can `--continue` the session). Extended-thinking signatures are written but dropped on read (functional `--continue` for thinking is tracked separately, issue #122).

  BREAKING removals (supersede the pluggable-storage and adjacent surfaces):

  - `ConversationStorageAdapter` and the whole pluggable-storage contract: `StoredMessage`, `ConversationStorageAdapter`, `FileSystemConversationStorage`, `InMemoryConversationStorage`, and `AgentOptions.conversationStorage`. Conversation persistence is now exclusively the native transcript — there is no swappable storage backend.
  - Session metadata (SE4): the `Session` namespace (`renameSession` / `tagSession` / capability listing) and the `SessionMeta` / `SessionMetaPatch` types.
  - Durable objectives (SE33): `agent.setObjective` / `getObjective` / `updateObjectiveOptions` / `clearObjective`, the `ObjectiveRecord` / `DurableGoalOptions` / `AgentGoalConfig` types, `AgentOptions.goal`, and the SE34 `<current-objective>` projection. `agent.runUntil(goal, options)` is now exclusively the ephemeral, explicit-goal judge loop (a call with no goal pauses).
  - `buildReplayHistory` / `ReplayHistoryOptions` (M1-3): the stateless continuation-history rebuild primitive (it consumed `StoredMessage[]`).
  - `ClaudeCodeTranscriptWriter` (`@theokit/sdk/persistence`) and its types (`ClaudeCodeRecord`, `ClaudeCodeTranscriptOptions`) + `claudeCodeRecords`. The SE39 read-only writer is superseded by this native format. `encodeProjectDir` / `transcriptPath` remain exported from `@theokit/sdk/persistence`, now sourced from the native `session-transcript` module.

  Validated end-to-end against a real LLM (OpenRouter): write → read → `--continue` recalls context across a simulated restart, and the native transcript round-trips through the real `claude-code-log` parser.

## 3.8.0

### Minor Changes

- 4a5ec72: SE39 — Claude Code transcript interop (read-only):

  - **`ClaudeCodeTranscriptWriter` (`@theokit/sdk/persistence`)** — emit a session as a
    Claude-Code-compatible `.jsonl` so the ecosystem's read-side tools (`claude-code-log`,
    `ccusage`, transcript viewers) can parse it. Opt-in and additive (does NOT change
    `ConversationStorage`). Taps `onStep`, so tool calls survive as structured
    `tool_use`/`tool_result` blocks with matched ids, `uuid`/`parentUuid` envelope, and the
    `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` path — validated end-to-end against the
    REAL `claude-code-log` parser (round-trip + real-LLM). Best-effort interop against an
    officially-unstable format; functional `--continue` is a later milestone.
  - **Fixed: `SendOptions.onStep` was asymmetric** — it emitted `toolCall` but never the paired
    `toolResult` (which `run.conversation()` and the `ConversationStep` union already carry). A
    live-stream consumer missed every tool result. `onStep` now emits both, in lock-step with
    `run.conversation()`.

## 3.7.0

### Minor Changes

- SE38 open-issue cleanup (SDK):

  - **#48** — the reasoning channel now emits its documented completion signal: one
    `thinking-completed` `InteractionUpdate` per reasoning block (with a measured
    `thinkingDurationMs`) via `onDelta`, guaranteed even if the LLM stream throws
    mid-reasoning; the replayed `thinking` `SDKMessage` carries the same
    `thinking_duration_ms`. Validated end-to-end against deepseek-r1 on OpenRouter.
  - **#119** — the `CustomTool` handler `ctx` now carries `threadId` (the run's session
    identity, threaded from the `Agent.getOrCreate(sessionId)` key), so a stateful tool
    shared across sessions can scope its state per session instead of leaking it. Additive
    and optional — single-argument handlers are byte-identical.
  - **#117** — `redactSecrets` no longer skips a secret value that contains `...` (it now
    skips only the exact `maskToken` output shape), closing a redaction gap. Its property
    test is made deterministic (pinned seed + `stringMatching` generators).
  - **#74** — `docs.md` reload contract corrected: a malformed skill is graceful-skipped
    (stderr warning + excluded from `agent.skills.list()`), not a `ConfigurationError`.

## 3.6.0

### Minor Changes

- 2606c98: SE37 — Reasoning ergonomics. Ships `ReasoningTools.create()` (`think`/`analyze` scratchpad tools, from `@theokit/sdk` core, re-exported by `@theokit/sdk-tools`) and a lightweight `AgentOptions.reasoning?: boolean` flag. When `reasoning: true`, the agent gets a chain-of-thought preamble prepended to its system prompt AND the reasoning tools auto-attached, turning a non-reasoning model into a reason→act→observe loop using the SAME model (reuses the existing tool loop; no new runtime). Inert (with a one-time warn) when a native reasoning model is configured (`model.params: [{ id: "thinking" }]`) — native reasoning wins, no double-reasoning. Default off; byte-identical behaviour when unset. Validated REAL on OpenRouter: `reasoning: true` drove the `think` tool and answered the "9.11 vs 9.9" trap correctly (9.9).

## 3.5.0

### Minor Changes

- cc095cd: Hooks config reverts to JSON, in the exact Claude Code shape (ADR 0016, reverses D74/D77 for hooks). `.theokit/hooks.json` is canonical again and copy-paste compatible with a Claude Code `settings.json` hooks block: `{ "hooks": { "PreToolUse": [ { "matcher": "shell", "hooks": [ { "type": "command", "command": "…", "timeout": 30 } ] } ] } }`. Claude Code event names map to the SDK's five firing points (PreToolUse→preToolUse, PostToolUse→postToolUse, UserPromptSubmit→preRun, Stop→stop); unsupported events are skipped with a warning; `timeout` is in seconds. The legacy `.theokit/hooks/*.md` markdown form is no longer supported — a stray dir (no `hooks.json`) is not loaded and warns to migrate. Rationale: a hook's markdown body is inert (unlike skills/context whose bodies are LLM-consumed), the file is machine-parsed (JSON is safer than YAML), and Claude Code — the reference implementation — configures hooks in JSON. Change is contained to the loader; executor + runtime firing unchanged.

## 3.4.1

### Patch Changes

- 2dc6a1c: SE17 gap closure — make the `toModelOutput` model-vs-app tool-output split REAL end-to-end. Previously the transform was applied inside the tool handler, so `onToolEnd` observability only ever saw the compact model-facing value — the application lost the full result (DoD 2/5 unmet). Now a `toModelOutput` tool carries a split resolver: the MODEL's `tool_result` receives the compact representation while `onToolEnd.result` receives the FULL raw handler output (serialized), from ONE handler execution. Direct `tool.handler()` calls still return the model-facing value (back-compat). Metadata/observability-only; no routing change.
- 2891678: SE3 — close the message-origin provenance gaps found by adversarial review. The SDK now actually STAMPS origin on the delegation and continuation paths (previously declared-but-unproduced union members): a delegated subagent's turn carries `{ kind: "coordinator" }`, and the run-to-completion / stream-to-completion driver's continuation rounds carry `{ kind: "auto-continuation" }`. `peer` (Squad / a2a) was already produced; `human` and `task-notification` remain host-supplied positive markers (documented). Metadata-only — never changes routing.

## 3.4.0

### Minor Changes

- 84b4de5: SE2 — the typed `RunEvent` stream (`SendOptions.onRunEvent`) now EMITS every declared variant end-to-end (previously only `tool_progress` + `permission_denied` fired; the rest were dead-in-the-sink). Newly wired: `rate_limit` (pool-aware LLM client, on a 429 retry backoff), `compact_boundary` (session auto-compaction boundary), and `task_started`/`task_updated`/`task_completed` (opt-in bridge — `Task.submit(kind, work, { onRunEvent })` forwards the task lifecycle as RunEvents). The sink stays strictly opt-in and fail-safe; no RunEvent is pushed into `Run.stream()`. Documented in docs.md.

## 3.3.0

### Minor Changes

- e81e994: SE1 — the permission model is now resolved PER RUN. `SendOptions.permissionMode` (per-send) and `AgentOptions.permissionMode` (creation-time default) thread a `PermissionMode` (`default | plan | acceptEdits | bypass`, with `bypassPermissions` as the Anthropic-exact alias of `bypass`) into a registered `PermissionPlugin`'s pre-tool gate, with documented precedence (send > create > plugin construction > `default`). Also: the `canUseTool` gate is now fail-CLOSED on any non-`allow` decision (was fail-open — a malformed/undefined return previously allowed); a `g`/`y`-flag `RegExp` arg matcher is reset before each test (deterministic authorization). Full `PermissionMode` + `canUseTool` surface documented in docs.md.

## 3.2.3

### Patch Changes

- 1770aec: Fix (#59) — a stdio MCP client no longer permanently wedges after a transient outage exceeds the reconnect attempt bound. The bound is now LOCAL to each reconnect cycle (a bounded retry loop with backoff), so a later request re-arms a fresh cycle and reconnects once the server recovers — while a genuinely-broken server still surfaces a typed `mcp_disconnected` "reconnect exhausted". Adds the previously-missing HTTP-transport recovery test (stateless reconnect on the next request after a transport failure).
- cda0542: Fix (#60) — `Retry-After` now also parses the RFC-7231 HTTP-date form (`Retry-After: Wed, 21 Oct 2025 07:28:00 GMT`), converting it to seconds-until-then (clamped at 0 for a past date). Previously only the numeric-seconds form was honored; a date-form header was silently dropped. Clarified that the same-key 429 retry deliberately does not block on `Retry-After` (a multi-key pool rotates to a fresh key immediately; the cooldown is honored at pool-selection level).
- 510041b: Fix (#61) — the Anthropic streaming client now detects a truncated stream. A stream that closes cleanly-but-early (server FIN / proxy hiccup before the terminal `message_delta` carrying `stop_reason`) previously committed silently as a clean `end_turn`; it now throws a typed `NetworkError{code:"stream_truncated"}`, matching the OpenAI client's guard.
- f7d39c8: Fix (#63) — pagination now fails fast on invalid cursors. `paginate({ offset, limit })` rejected a `NaN` offset by silently returning the WHOLE list (and negative by returning empty); it now throws `ConfigurationError{code:"pagination_invalid"}` for any non-negative-integer offset/limit. Also adds real cross-process evidence for the conversation-storage file lock: two separate OS processes taking `withFileLock` on the same file are proven to serialize (previously only in-process concurrency was tested).

## 3.2.2

### Patch Changes

- 7f57c5a: Security (#55) — a delegated subagent now inherits the parent's code-registered plugins (e.g. `PermissionPlugin`), so its inner tool calls run under the SAME argument-level permission gate. Previously the child `Agent.create` received only apiKey/model/tools, so a parent that denied `shell` with a matching-arg rule did not stop a subagent it granted `shell` to — arg-level gating silently stopped at the delegation boundary.
- f81ac79: Fix (#58) — a run cancelled between tool iterations now reports `RunStatus: "cancelled"` instead of `"finished"`, so a caller can distinguish a cancellation from a clean completion. Previously the between-iteration abort break left the default `"finished"` status.
- 57cfcc8: Fix (#58) — `JobQueue.cancel()` on a running job that ignores its `AbortSignal` (never settles) previously leaked its concurrency slot, deadlocking a `maxConcurrency`-bounded queue. Cancel now frees the slot immediately; `#release` is idempotent so the job's eventual settle is a no-op (no double-free).
- bd06140: Fix (#65) — the `transform_llm_output` plugin hook now rewrites the FINAL user-visible / streamed assistant text, and fires on text-only terminal turns. Previously it ran only in the tool-call branch and folded only into internal message history, so a plugin could not scrub what the caller actually received. The transform is now applied once, up front, and flows into the emitted step, `finalText`/`result`, and message history alike.

## 3.2.1

### Patch Changes

- a283dd4: Security (#54) — harden child-process env scrubbing.

  - The `inherit-scrubbed` denylist now also drops the highest-signal VALUE-embedded-secret conventions: connection strings that carry `user:password@` (`DATABASE_URL`, `REDIS_URL`, `MONGODB_URI`, `DB_URL`, …), plus `DSN`, `WEBHOOK`, `COOKIE`, and `CONNECTION_STRING`. Generic non-secret URLs (`PUBLIC_BASE_URL`, `API_URL`, `PGHOST`) are deliberately preserved. A denylist still cannot catch every value-embedded secret — policy `core` (allowlist) remains the fail-closed mode for untrusted children.
  - Removed dead `validateCommand` / `SHELL_METACHARACTERS` from the sandbox base — a never-invoked "guard" that provided a false sense of protection.
  - Added an end-to-end test proving `LocalSandbox.execute` scrubs secret-like host env vars from the real child process.

- 826bca0: Security (#56) — close two residual cross-tenant active-recall cache leaks found by adversarial review.

  - `@theokit/sdk-memory` (publishable) called `cache.get`/`cache.set` with no tenant context, so two callers with the same query text but different identity shared a cached recall — a cross-tenant leak for every consumer of the package. The cache read/write are now keyed by the `{namespace, userId, scope}` tenant tuple (the primitive already supported it).
  - In `@theokit/sdk` the production caller hardcoded `namespace: "default"` and dropped `memoryContext.tenantId`, so two tenants sharing a `userId` collided on one cache entry. The caller now threads `memoryContext.tenantId` into the tenant partition (`namespace`). `sessionId` is intentionally not a key dimension — recall is cross-session by design.

- 7bcc872: Security/correctness (#59) — the HTTP MCP body read (`response.json()`) was outside the abort try/catch, so a server that returned headers then stalled the body surfaced a raw `DOMException(TimeoutError)` instead of the typed `NetworkError{code:"mcp_timeout"}`. The request was still bounded (no hang), but the typed-timeout contract now holds across both the header and body phases.

## 3.2.0

### Minor Changes

- bf66122: Add `.theokit/rules/*.md` — theokit-native path-scoped rule files, mirroring Claude Code's `.claude/rules/`.

  Each rule file carries frontmatter with `paths:` (Claude Code parity) and/or `globs:` (Cursor-compatible alias) — both are glob-pattern arrays — plus `alwaysApply` and `enabled`. Rules with `alwaysApply: true` load into the agent's context every send; path-scoped rules activate only when an in-scope file matches, declared per-send via the new `SendOptions.contextPaths`. The same in-scope signal also unblocks conditional activation for `.cursor/rules/*.mdc` globs. No new dependency — glob matching and the YAML-subset parser are shared across both rule formats.

  Also fixes the shared glob compiler so `dir/**/*.ext` correctly matches a top-level file directly under `dir/` (e.g. `src/**/*.ts` now matches `src/foo.ts`, not just `src/a/b/foo.ts`) — the semantics Cursor and Claude Code document. This improves `.cursor/rules/*.mdc` glob activation as well. `*` and `?` no longer cross a `/` separator.

## 3.1.1

### Patch Changes

- 5f0507c: Fix a leaked timeout timer in `MessageBus.request` (a2a). The request raced the handler against a `setTimeout`, but never cleared the timer when the handler won — a successful request left a live 30s timer that kept the Node event loop alive, so a process hung after the reply. The timer is now cleared in a `finally`.

## 3.1.0

### Minor Changes

- c71e539: Subagent delegation now works end-to-end on the local runtime.

  - **Declarative `agents: { name: AgentDefinition }` are wired locally.** Each definition is exposed to the supervisor as a delegation tool (previously honored only by the cloud/fixture runtimes). `def.prompt` becomes the child's instructions, `def.model` (or `"inherit"`) selects its model, and `def.tools` scopes it to that subset of the parent's tools.
  - **Subagents inherit the parent's credentials automatically.** A delegated child now inherits the supervisor's `apiKey` and model, so it authenticates without repeating them. Previously `runChildAgent` created the child with no `apiKey`, so any parent using an explicit key (not `THEOKIT_API_KEY`) hit `AuthenticationError: Missing API key`. The parent's key is threaded only to first-party subagent tools — it never reaches third-party tool `ctx`.
  - **Fixed the subagent tool schema.** `SubAgent.create` exposed a raw Zod object as its `inputSchema`; the LLM received a malformed parameter schema and emitted input that failed validation, so the delegation never ran. It now exposes a proper Draft-7 JSON Schema (validation still uses Zod internally).

## 3.0.0

### Major Changes

- SE36 — uniform `X.create()` public API (v3.0 breaking). Every public factory is removed in favor of a static `X.create()` namespace method, matching `Agent.create` / `Cron.create` / `Workflow.create`:

  `defineTool`→`Tool.create`, `defineProvider`→`Provider.create`, `definePlugin`→`Plugin.create`, `defineSkillReadTool`→`SkillReadTool.create`, `defineSubAgent`→`SubAgent.create`, `createSquad`→`Squad.create`, `createSkill`→`Skill.create`, `createSessionManager`→`Session.create`, `createAgentFactory`→`AgentFactory.create`, `createNoopMemoryProvider`→`NoopMemoryProvider.create`, `createPermissionPlugin`→`PermissionPlugin.create`, `createTokenLimiter`→`TokenLimiter.create`, `createUnicodeNormalizer`→`UnicodeNormalizer.create`, `defineSubscription`→`Subscription.create`, `createSemaphore`→`Semaphore.create`, `defineAuth`→`Auth.create`, `withRetry`→`Retry.create`.

  `Agent.create` / `Cron.create` / `Workflow.create` / `Budget.create` are unchanged. Run `npx @theokit/codemod-sdk-3-0 --write` to migrate consumers. Reverses Unbreakable Rule 9 (ADR 0015 supersedes D431).

## 2.30.0

### Minor Changes

- ea3cd14: **SE35 — schedule a workflow on the `Cron` primitive (`workflow` + `inputData`).**

  A `Cron` job may now target a committed `Workflow` (SE27–30) instead of an agent. `Cron.create({ cron, workflow, inputData })` runs `workflow.run(inputData)` on each fire, reusing the shipped in-process scheduler + Task-registry observability. Mutually exclusive with agent targets: exactly one of `agent` | `agentId` | `workflow`; `message` is required for agent targets and forbidden with a workflow (typed `ConfigurationError`s: `cron_ambiguous_target` / `cron_no_target` / `cron_workflow_message` / `cron_missing_message`). `Cron.run(jobId)` returns `Run | WorkflowRun`; the fire handler records the correct terminal status for either shape.

  Per ADR 0014, the job holds the `Workflow` **instance** (not a `workflowId` + resolver registry) — the cron store is in-memory, so there is no serialization problem to solve and a registry would be YAGNI; workflow cron jobs are local-runtime only (an instance can't cross the cloud boundary). Fire lifecycle hooks (`prepare`/`onFinish`/`onError`/`onAbort`) are deferred with a named re-eval trigger. Back-compat: agent-target jobs are byte-identical. (SDK Evolution roadmap SE35.)

## 2.29.0

### Minor Changes

- 99046ab: **SE33 — durable thread-scoped objective (`setObjective` over the existing `runUntil` + ConversationStorage).**

  The SDK already ships the goal-judge loop (`agent.runUntil(goal, options)`, D115-D121) — but the goal was per-call and transient. SE33 adds the durable layer: a thread-scoped objective persisted through the EXISTING `ConversationStorageAdapter` seam, surviving reloads/restarts, managed via new `Agent` methods.

  - **Persistence** — a namespaced `ObjectiveRecord` (`{ _schemaVersion: 1, objective, options?, status: "active"|"done"|"paused", runsUsed }`) keyed by `threadId`. `ConversationStorageAdapter` gains three OPTIONAL methods (`getObjectiveRecord` / `setObjectiveRecord` / `updateObjectiveRecord` — the last an ATOMIC read-modify-write so concurrent progress write-backs can't drop turns); the built-in `InMemoryConversationStorage` and `FileSystemConversationStorage` (a dedicated `.theokit/agents/<safe>/objective.json`, secret-redacted, file-locked, path-safe for exotic `threadId`s) implement them. Adapters that omit them degrade to a typed no-op — no new store, back-compat preserved.
  - **Agent methods** — `agent.setObjective(objective, { threadId, ...options })` / `getObjective({ threadId })` / `updateObjectiveOptions({ threadId, ... })` (only provided fields written) / `clearObjective({ threadId })`. All no-op when the run is not memory-backed. A fresh agent sharing the same adapter reads the objective back (the adapter is the durability boundary).
  - **Standing `goal` config** — `AgentOptions.goal` (`{ judgeModel?, maxRuns?, prompt? }`). Precedence (remembered in the record): per-objective `record.options` → standing `goal` config → built-in default (`maxRuns` 20). The judge is the activation switch: with no judge resolved, the standing objective is inert (no scoring, no budget consumed).
  - **`runUntil(goal?, options?)`** — `goal` is now OPTIONAL. Existing callers pass `goal` (unchanged transient behavior). Omitting `goal` with `options.threadId` set reads the durable objective, resolves options by precedence, caps per-call `maxTurns` by the remaining durable budget, runs the loop, and writes `runsUsed`/`status` back — `maxTurns` exhaustion leaves the objective `active` so raising `maxRuns` later resumes. Omitting `goal` with no objective (or no `threadId`) yields a single `status_change: paused` and never throws.

  Reuses existing seams only (the shipped `runUntil` loop + `ConversationStorage`) — no new loop, no parallel runtime, no in-agentic-loop step (that is SE34). ADR 0012. (SDK Evolution roadmap SE33.)

- a8bed75: **SE34 — per-send `isTaskComplete` + `<current-objective>` projection (non-invasive half).**

  Two opt-in `SendOptions`, both byte-identical to today when unused. The loop-touching in-agentic-loop goal step is DEFERRED with a named re-eval trigger (ADR 0013).

  - **`completionCheck` (`isTaskComplete`)** — `send(msg, { completionCheck: { criteria, judgeModel?, apiKey? } })`. After the send reaches terminal `finished`, the shipped LLM-as-judge scores the final reply against `criteria`; the verdict surfaces on `RunResult.completionCheck` (`{ complete, reason, parseFailed }`) AND a typed `completion_check` run-event. This is the finer-grained, single-`send()` completion gate (contrast `runUntil`, which judges BETWEEN sends). Implemented as an outermost run wrapper — only judges a `finished` run with text, memoized (the judge fires exactly once), fail-safe (a judge parse failure yields `complete: false`, never a silent "done").
  - **`objectiveThreadId` (`<current-objective>` projection)** — `send(msg, { objectiveThreadId })` reads the SE33 durable objective for that thread and, when it is `active`, prepends a `<current-objective>…</current-objective>` block to the assembled system prompt for that send, so the model always sees what it is working toward. Minimal + fail-soft (a storage read error never breaks the send) — not a general signal-provider framework.

  Both reuse shipped seams (the run-wrapping seam + `judgeCallImpl` for the check; the SE33 objective store + system-prompt assembly for the projection). The agent tool-calling loop is UNTOUCHED. (SDK Evolution roadmap SE34.)

## 2.28.0

### Minor Changes

- 3af329f: **SE31 — `Filesystem` provider seam (`@theokit/sdk/filesystem`).**

  A pluggable filesystem _storage_ provider, the storage-side twin of `@theokit/sdk/sandbox`. `FilesystemBackend` is an abstract class with four methods (`readFile` / `writeFile` / `stat` / `list`), an `exists()` derived on the base, a boundary `basePath`, a `readOnly` flag, structured `stat().mtimeMs` (the read-before-write oracle for SE32), and typed errors (`FileNotFoundError` / `FilesystemSecurityError` / `FilesystemReadOnlyError` / `StaleFileError`). `LocalFilesystem` is the local-process implementation, boundary-enforced by reusing the core path-guard (traversal + symlink escape → `FilesystemSecurityError`). `FilesystemProvider` + `resolveFilesystem` support a per-request resolver `(ctx) => FilesystemBackend` for multi-tenant roots.

  Unlike `SandboxBackend` (whose file ops shell out via `execute`, require command execution, and give no structured `stat`), a `FilesystemBackend` serves a filesystem-only workspace with no sandbox — see ADR 0011 for why file ops are NOT routed through `SandboxBackend`. `@theokit/sdk-tools`' `createWriteFileTool` now accepts an optional `filesystem` backend (writes route through it; omitted ⇒ identical local-`projectRoot` behavior). This is the backend seam, NOT a bundled `Workspace` and NOT a new toolset — bring-your-own-tools stands; `mounts`/FUSE, S3/GCS, and LSP remain out of core. (SDK Evolution roadmap SE31.)

## 2.27.0

### Minor Changes

- c2bdd87: **SE27 — workflow-level `inputSchema` / `outputSchema` (validate the whole-workflow I/O).**

  `Workflow.create({ ..., inputSchema, outputSchema })` (from `@theokit/sdk/workflow`) now validates the workflow's overall input and final output, closing the SE19 debt (a Workflow carried no top-level schema — only per-step `FnStep` schemas). When `inputSchema` is set, `run(input)` validates `input` BEFORE step 1; a mismatch fails fast with `status: "failed"` and a typed `WorkflowInputError` in `run.error` (no step executes, no silent coerce). When `outputSchema` is set, the terminal `completed` output is validated before `WorkflowRun.output` is populated; a mismatch yields `status: "failed"` with a typed `WorkflowOutputError` (only the `completed` path is checked — suspended/failed runs skip output validation).

  Both surface as `status: "failed"` (never a throw — consistent with the executor's non-throwing step-error contract). Back-compat: absent schemas ⇒ unchanged. New exports `WorkflowInputError` / `WorkflowOutputError`. `workflowAsTool` (SE19) keeps taking its own `inputSchema` to preserve its structural `{ run }` contract. (SDK Evolution roadmap SE27.)

- 09b89ea: **SE28 — `Workflow.stream()` (step-event stream during execution).**

  `workflow.stream(input, opts?)` (from `@theokit/sdk/workflow`) runs the workflow and emits step-level events as they happen, instead of only the terminal result. It returns a `WorkflowStream` — an async iterator of `WorkflowEvent`s (`step_started` / `step_completed` (with `output`) / `step_failed` (with `error`) / `workflow_suspended` / `workflow_completed`) plus a `result` promise resolving to the SAME terminal `WorkflowRun` `run()` returns (the authoritative outcome — the stream ends when the run terminates).

  Events fire in execution order for top-level steps (nested `parallel`/`branch`/`foreach` emit as their single wrapping step — coarse-grained by design). This is a STEP-event stream, distinct from the token-delta agent stream deferred in SE24. `run()` is unchanged + authoritative. New public types `WorkflowEvent` + `WorkflowStream`. (SDK Evolution roadmap SE28.)

- f13d499: **SE29 — workflow shared state (`stateSchema` + `state` / `setState`).**

  Workflow steps can now share values without threading them through every step's input/output. `Workflow.create({ stateSchema, initialState })` (from `@theokit/sdk/workflow`) seeds a shared state; every step's `StepContext` gains `state` (read the current value) and `setState(next)` (update it for subsequent steps). `setState` validates against `stateSchema` when set — a mismatch throws a typed `WorkflowStateError` that fails the step/run (Rule 8); an invalid `initialState` fails the run fast before step 1.

  State is captured in the `WorkflowSnapshot` (bumped to `_schemaVersion: 2`) and restored on `Workflow.resume` — it survives a suspend→resume round-trip. A pre-SE29 (`_schemaVersion: 1`) snapshot has no state and resumes with `initialState`. Back-compat: no `stateSchema`/`initialState` ⇒ `state` is `undefined` and `setState` is unvalidated. New export `WorkflowStateError`. (SDK Evolution roadmap SE29.)

- 8ce8441: **SE30 — workflows-as-steps (`workflowStep`) + `cloneWorkflow`.**

  `workflowStep(child, { id? })` (from `@theokit/sdk/workflow`) uses a committed `Workflow` as a step inside another workflow: `.then(workflowStep(child))`. The child runs in its OWN executor (own runId, single-flight lock, and step-id space — so nested ids never collide with the parent's); its output becomes the step output. `cloneWorkflow(wf, { id })` returns a new independent `Workflow` with the same committed steps under a new name + a fresh workflowId (clones run independently, distinct observability identity).

  A non-`completed` child fails the parent step with a typed `WorkflowNestedError`. **Nested suspend/resume is NOT supported in v1** (TheoKit's resume continues AFTER the suspended step, so a nested child would be skipped) — a nested `suspended` fails with a clear message pointing at a top-level suspend; re-running the child on resume (which would re-execute its side effects) is deliberately avoided. ADR 0010. New export `WorkflowNestedError`. (SDK Evolution roadmap SE30.)

## 2.26.0

### Minor Changes

- d31e2ca: **SE24 — guardrail processor pipeline (`inputProcessors` / `outputProcessors`).**

  `AgentOptions.inputProcessors` run in order before the LLM (normalize / validate / block / rewrite the user message); `outputProcessors` run on the model's final text before it reaches the caller (redact / block). A `Processor` is `{ id; processInput?; processOutput?; onViolation? }`; each handler receives `ctx` with `abort(reason)` (block → the run stops with `RunResult.tripwire { reason, processorId }` + a `tripwire` run-event via `SendOptions.onRunEvent`) and `warn(message, detail?)` (non-blocking → fires `onViolation`, continues), and returns the (possibly rewritten) payload.

  The core ships no `strategy` enum — block/rewrite/redact/warn reduce to `abort` / return-string / `warn` (the built-in SE25 processors expose a `strategy` option over these). An input block never reaches the model (a terminal tripwire run); an output block turns a finished run's result into a tripwire on `wait()`. Streaming output redaction is deferred (v1 processes the buffered `wait()` path). Cloud agents reject processors (function handlers don't serialize). Back-compat: no processors ⇒ unchanged. New public types `Processor` / `ProcessorViolation` / `InputProcessorContext` / `OutputProcessorContext` / `ProcessorControls` / `ProcessorTripwire` / `RunTripwireEvent` + `RunResult.tripwire`. ADR 0008. (SDK Evolution roadmap SE24.)

- cc8efee: **SE25 — deterministic in-tree guardrail processors (`createUnicodeNormalizer`, `createTokenLimiter`).**

  Two churn-free, no-LLM processors built on the SE24 seam:

  - `createUnicodeNormalizer({ stripControlChars?, collapseWhitespace? })` — an input processor: Unicode NFC normalization (stdlib `String.prototype.normalize`) plus optional C0/DEL control-char stripping (keeps tab/newline/carriage-return) and whitespace collapsing.
  - `createTokenLimiter({ limit, strategy? })` — caps text to a token budget using a char-based estimate (~chars/4, no tokenizer dep; `estimateTokens` is exported). `strategy: "truncate"` (default, cut to fit) or `"block"` (abort → tripwire). Fires on whichever array it is placed in (input caps the prompt, output caps the response).

  Both are OPT-IN (add to `inputProcessors`/`outputProcessors`); nothing auto-injects them; back-compat preserved.

  **A batch-parts processor is intentionally DEFERRED**, not shipped: TheoKit's `run.stream()` emits full `SDKAssistantMessage`s, not token-granular deltas, so there is no SSE chunk stream to coalesce in the in-process runtime (batch-coalescing only saves HTTP network overhead). It becomes meaningful only alongside a future HTTP/SSE streaming transport (the same milestone as SE24's deferred streaming-output redaction). (SDK Evolution roadmap SE25.)

### Patch Changes

- 0685363: **SE26 — delegate LLM-classifier guardrail processors (ADR + recommendation + example).**

  Records the decision (ADR 0009) to DELEGATE the LLM-classifier guardrail processors — moderation, PII, prompt-injection, language, prompt-scrubber — to specialist libraries / consumer code built ON the SE24 seam, rather than shipping concrete classifiers in `@theokit/sdk` core (mirrors the AUTH-DELEGATION lock: constant churn — provider/model deltas, taxonomies, thresholds, jailbreak patterns — vs a stable seam a single-maintainer core can own). No classifier is added to core.

  Ships the paved path: `docs/concepts/guardrails.md` (how to build moderation / PII / injection processors on the seam + recommended external classifiers) and `examples/guardrails/` (a runnable moderation + PII-redaction example over a pluggable classifier). No public API change. (SDK Evolution roadmap SE26.)

## 2.25.0

### Minor Changes

- 5067b50: **SE20 — `agent.skills.get(name)` (read a skill's full body).**

  `agent.skills.list()` already returned skill metadata (name + description only); SE20 adds `agent.skills.get(name)` returning the skill INCLUDING its `instructions` (body) — read from the inline `createSkill` body, or from the filesystem SKILL.md (frontmatter stripped) for discovered skills. Returns `undefined` when no enabled skill matches (malformed skills stay excluded). New public type `SDKAgentSkillDetail`.

  `list()` stays lean (the `<skills>` block only ever carries name + description); full bodies come only through `get`. Additive + backward-compatible. (SDK Evolution roadmap SE20.)

- 09865ee: **SE21 — `references` on `createSkill` (bundle supporting docs on an inline skill).**

  `createSkill({ ..., references })` now accepts an optional `references` map (filename → content), mirroring a filesystem skill's `references/` directory. The docs travel on the inline skill object and surface to the app via `agent.skills.get(name)` (new `references` field on `SDKAgentSkillDetail`); they are NOT injected into the model prompt. Omitted when not provided (backward-compatible).

  Also closes a latent boundary leak surfaced by this change: `agent.skills.list()` now projects to the public shape (name + description only), so an inline skill's `instructions` / `references` / `source` never leak through `list()` — the body is reachable exclusively through `get()`, matching the documented `SystemPromptSkillRef` contract. (SDK Evolution roadmap SE21.)

- abfcc5d: **SE22 — dynamic skills resolver (`skills: (ctx) => SkillsSettings`).**

  `AgentOptions.skills` now accepts a resolver function in addition to the static `SkillsSettings` object. The resolver receives a per-send context (`agentId`, `cwd`, `model`, `userMessage`, `memory` — mirroring the systemPrompt resolver's context, minus the not-yet-resolved `skills`) and returns the `SkillsSettings` for that run. It is evaluated per `send()` before skill assembly, so a cached `getOrCreate` agent re-resolves each run — pick skills from runtime context (e.g. the user's role).

  A static object behaves exactly as today. The agent-scoped `agent.skills` handle reflects the static/base config; the resolver drives the per-send `<skills>` block. The SDK imposes no timeout (wrap your own `Promise.race`); a throwing resolver fails the run — no silent fallback (Rule 8). Cloud agents reject a function resolver (it can't run on PaaS — resolve to a static object first), mirroring the systemPrompt-resolver cloud rule. New public types `SkillsResolver` + `SkillsResolverContext`. (SDK Evolution roadmap SE22.)

- 0b9c0ac: **SE23 — `defineSkillReadTool` (opt-in model-facing lazy skill read).**

  `defineSkillReadTool(skills)` returns a `skill_read` `CustomTool` the consumer explicitly adds to `AgentOptions.tools`. When the model calls it with a skill name, the handler returns that skill's `instructions` (+ SE21 `references`); an unknown-but-well-formed name returns a typed "not found" string listing the available skills — NOT a throw that kills the run (Rule 8). Malformed input (missing `name`) fails at the trust boundary via the input schema.

  The SDK never auto-injects it — bring-your-own-tools stays intact (sibling of `defineSubAgent` / `workflowAsTool`). This is the LAZY read path that complements the eager `<skills>` block (name + description only): the block discloses which skills exist; `skill_read` loads a body on demand. The consumer controls exposure by choosing which skills to pass. See ADR 0007. The `skill_read` tool is opt-in, never auto-injected. (SDK Evolution roadmap SE23.)

## 2.24.0

### Minor Changes

- 7be1f18: **SE16 — `outputSchema` on `defineTool` (validate + infer the tool's return).**

  `defineTool` (from `@theokit/sdk`) gains an optional `outputSchema` (a Zod schema). When set, the handler returns the STRUCTURED output inferred from it (`z.infer<outputSchema>`), the value is validated against the schema, and the tool result becomes its serialization — a string stays as-is, an object is JSON-stringified. A validation failure raises `ZodError` (converted to a `tool_result(isError)`), so a malformed tool output fails loudly instead of silently reaching the model.

  Additive + fully backward-compatible: with no `outputSchema` the handler returns a plain `string` exactly as before (the handler return type is `string` when `outputSchema` is absent, `z.infer<outputSchema>` when present, via a conditional type). Pairs with SE17 (`toModelOutput`). (SDK Evolution roadmap SE16.)

- f621734: **SE17 — `toModelOutput` on `defineTool` (model-facing vs app-facing output split).**

  `defineTool` (from `@theokit/sdk`) gains an optional `toModelOutput`. The handler returns the FULL result (validated by SE16's `outputSchema`); `toModelOutput(output)` maps it to the compact / multimodal representation the MODEL sees in the `tool_result` — so rich app-facing detail is not forced into model context. It returns a `string` OR SE7 `ToolResultContentBlock[]` (text + image). Absent ⇒ the tool result is the serialized handler output (SE16 / pre-SE17 behavior, unchanged).

  Additive + backward-compatible. (SDK Evolution roadmap SE17.)

- 72435db: **SE18 — `SendOptions.activeTools` (per-send runtime tool subset).**

  `agent.send(input, { activeTools })` restricts, per send, which of the agent's registered tools the model may actually call. A tool whose canonical name is not in the list is vetoed at dispatch (its handler never runs) — reusing the existing `withToolWhitelist` path that `Agent.fork`'s `allowedTools` uses, NOT `PermissionEngine`. Composes with `toolChoice`: `activeTools` narrows the set, `toolChoice` gates calling within it. Absent ⇒ the full toolset is available (unchanged).

  The loop runs inside a `withToolWhitelist(new Set(activeTools))` scope when set. Additive + backward-compatible. (SDK Evolution roadmap SE18.)

- f92f720: **SE19 — `workflowAsTool` (expose a Workflow as an agent tool).**

  `workflowAsTool(workflow, { name, description, inputSchema })` (from `@theokit/sdk/workflow`) turns a `Workflow` into an agent `CustomTool`, completing the "X as tools" trio (tools; agents-as-tools via `defineSubAgent`; workflows-as-tools). The handler validates the model's args against `spec.inputSchema`, runs the workflow, and returns its output (a string as-is, else JSON). A run that does not reach `status: "completed"` raises a typed `WorkflowToolError` (workflow step errors do NOT throw — they surface via `run.status === "failed"`).

  Because a `Workflow` carries no top-level schema (`WorkflowOptions` is `name`/`persistence`/`workflowId`; schemas are per-step), the caller supplies the tool `inputSchema` in the spec (like `defineTool`). Accepts any `{ run }`-shaped workflow (structural), so it never imports the `Workflow` class. New exports: `workflowAsTool`, `WorkflowToolError`, `WorkflowAsToolSpec`. Additive. (SDK Evolution roadmap SE19.)

## 2.23.0

### Minor Changes

- 271f6e4: **SE13 — `modifiedMaxSteps` on `onDelegationStart` (cap the subagent's iterations).**

  `DelegationStartDecision` (from `@theokit/sdk/a2a`) gains `modifiedMaxSteps?: number`. When an `onDelegationStart` hook returns it (and does not reject), `defineSubAgent` forwards it as `SendOptions.maxIterations` to the child `agent.send`, capping how many tool-loop rounds the subagent may run. Composes with SE10 (`signal`) and SE12 (`messageFilter` preamble) onto a single child `send`. Absent ⇒ the child uses its default iteration ceiling (unchanged).

  Completes the SE11 `onDelegationStart` decision contract (the deferred `modifiedMaxSteps` — the `SendOptions.maxIterations` plumbing already existed). Additive + backward-compatible. (SDK Evolution roadmap SE13.)

- b51dc6a: **SE14 — subagent result-context control (`SubAgentSpec.includeToolResults`).**

  `defineSubAgent()` (from `@theokit/sdk/a2a`) gains an opt-in `includeToolResults`. When `true`, the child's completed tool-call results (name + result) are appended to the delegation payload returned to the supervisor, inside a delimited `<subagent-tool-results>` block; when absent/`false` the delegation returns the child's final text only — **text-only stays the default** (the scoped-context posture).

  Implemented as a `run.stream()` replay after `run.wait()` (a proven, safe idiom — the run buffers events and `stream()` replays them) collecting `tool_call` events with `status: "completed"`. **No `RunResult` change** — reads the existing public stream surface; tool _args_ are never surfaced (only completed results). Rationale + the `RunResult`-field alternative are recorded in ADR 0006.

  Additive + backward-compatible (default `false` never touches the stream). (SDK Evolution roadmap SE14.)

- 30e02d9: **SE15 — `iteration` count on the delegation-hook context (reject-after-N).**

  `DelegationStartContext` and `DelegationCompleteContext` (from `@theokit/sdk/a2a`) gain `iteration: number` — a 1-based per-`defineSubAgent`-instance invocation counter, incremented before `onDelegationStart` runs (a rejected delegation still counts). This enables a reject-after-N-iterations pattern: `onDelegationStart: (ctx) => ctx.iteration > 8 ? { proceed: false, rejectionReason } : { proceed: true }`. `onDelegationComplete` sees the same iteration its `onDelegationStart` did.

  Also fixes a delegation-hook DX regression: `onDelegationStart` / `onDelegationComplete` now accept a **side-effect-only (void-returning) callback** (e.g. `(ctx) => { log(ctx) }`) — the common case, for `async ctx => { … }` hooks — via a shared `DelegationHookResult<T>` return type. Additive + backward-compatible. (SDK Evolution roadmap SE15.)

## 2.22.0

### Minor Changes

- 12cb30d: **SE10 — subagent delegation forwards the parent's `AbortSignal` (cancellation propagation).**

  `defineSubAgent()` (from `@theokit/sdk/a2a`) now threads the run's cancellation into the child agent. When the agent loop dispatches the subagent tool it already passes the run's `AbortSignal` as the handler's `ctx.signal`; the subagent handler now forwards that signal to the child `agent.send(input, { signal })`. Aborting the parent run cancels the in-flight subagent at its next step instead of letting it run to completion (and burn tokens).

  - Additive + backward-compatible: a handler invoked with no `ctx` (single-arg call sites) behaves exactly as before — no signal, no cancellation.
  - The child agent is still disposed in `finally`, including on cancel.

  The parent run's `AbortSignal` is forwarded to delegated subagents; aborting the parent cancels the in-flight subagent at its next step (SDK Evolution roadmap SE10).

- 8e3249d: **SE11 — delegation lifecycle hooks on `defineSubAgent` (`onDelegationStart` / `onDelegationComplete`).**

  `SubAgentSpec` (from `@theokit/sdk/a2a`) gains two optional hooks that let the caller intercept a delegation as it happens:

  - `onDelegationStart({ input, name })` — return `{ proceed: false, rejectionReason }` to reject the delegation (the child never runs; `rejectionReason` becomes the tool result), or `{ modifiedInput }` to rewrite the prompt sent to the child.
  - `onDelegationComplete({ input, name, result?, error? })` — runs after the delegation settles; on success an optional `{ feedback }` is appended to the child's result, and on failure `ctx.error` is set (the error is still re-thrown — never swallowed, Unbreakable Rule 8).

  Additive + backward-compatible: specs without hooks behave exactly as before. New exported types: `DelegationStartContext`, `DelegationStartDecision`, `DelegationCompleteContext`, `DelegationCompleteDecision`.

  Adds `onDelegationStart` / `onDelegationComplete` control points for delegation (SDK Evolution roadmap SE11).

- d2d0d16: **SE12 — opt-in parent-context forwarding for subagents (`messageFilter`).**

  `SubAgentSpec` (from `@theokit/sdk/a2a`) gains an optional `messageFilter`. When set, `defineSubAgent` forwards a filtered view of the supervisor's conversation to the child; when absent, the child runs input-only — **memory isolation stays the default**.

  - New `ctx.messages` on the custom-tool handler `ToolContext`: a **read-only, text-only** projection of the current turn's transcript (`ToolContextMessage[]`), threaded by the agent loop the same way `ctx.signal` (#65) and `ctx.context` (M7) are. Non-text parts (tool calls / results) are dropped — a tool never sees raw wire parts or nested tool args.
  - `messageFilter({ messages, input, name })` returns the subset to forward; `defineSubAgent` prepends it to the delegated input as a role-tagged context preamble. A filter returning `[]` forwards nothing. A filter that drops sensitive turns (e.g. anything `confidential`) provably keeps them out of the child context.

  New exported types: `ToolContextMessage`, `MessageFilterArgs`. Additive + backward-compatible. Rationale + the transcript-exposure trade-off are recorded in ADR 0005. (SDK Evolution roadmap SE12.)

## 2.21.0

### Minor Changes

- 707d1e3: **SE1 — Permission model: `PermissionMode` + an enriched `canUseTool` gate.**

  The existing `PermissionEngine` (rules + arg-matching + fail-closed `ask` default, #55) gains a per-run **`PermissionMode`** (`"default" | "plan" | "acceptEdits" | "bypass"`) — a pure post-processor of the rule verdict (no tool metadata needed, fits bring-your-own-tools):

  - `default` — rules decide; unmatched ⇒ `ask` (fail-closed).
  - `plan` — read-only: `allow` rules pass, everything else ⇒ `deny`.
  - `acceptEdits` — auto-approve the UNMATCHED verdict but still honor an explicit `ask` rule (Codex `UnlessTrusted`).
  - `bypass` — everything ⇒ `allow` EXCEPT an explicit `deny` rule (a skip-permissions posture; Codex `Never`).

  **Invariant:** an explicit `deny` is immune to every auto-approve mode. `bypass`/`acceptEdits` never un-deny.

  `createPermissionPlugin` gains `mode` + an enriched async **`canUseTool(toolName, input, ctx)`** gate (the Anthropic-parity shape) that resolves the `ask` verdict to allow/deny — fail-closed on absent/throwing gate. The old `onAsk(toolName)` is kept as a `@deprecated` back-compat fallback.

  New exports: `PermissionMode`, `applyMode`, `PermissionGate`, `PermissionGateContext`, `PermissionGateDecision`. Additive + backward-compatible (`evaluate` mode defaults to `default`; `onAsk` still works). `updatedInput` (arg rewrite) is intentionally deferred — the `pre_tool_call` seam is veto-only today.

  Grounded in a survey of state-of-the-art agent permission models (SDK Evolution roadmap SE1).

- f9001bb: **SE2 — typed runtime event stream (opt-in `SendOptions.onRunEvent`).**

  New public `RunEvent` discriminated union + an opt-in `onRunEvent` sink, ADDITIVE to the `SDKMessage` content stream (non-breaking). Runtime-observability signals are delivered out-of-band — the model's content is unaffected. Mirrors the Anthropic `SDKMessage`-union approach.

  - `RunEvent` union (the forward-compatible contract): `tool_progress`, `permission_denied`, `rate_limit`, `task_started`, `task_updated`, `task_completed`, `compact_boundary`. Discriminate on `type`.
  - `SendOptions.onRunEvent?: (e: RunEvent) => void` — best-effort, fail-safe: a throwing sink never breaks the run (`emitRunEvent` swallows it).
  - **Emitted end-to-end as of SE2:** `tool_progress` (a tool dispatches) and `permission_denied` (a plugin gate blocks a tool) — both proven via an integration test driving a real run against a stub provider. The remaining variants (`rate_limit`, `task_*`, `compact_boundary`) are part of the contract; their emission is wired incrementally as the sink is threaded into the LLM-client retry / task / session-compaction subsystems (they live below the agent loop). A consumer switching exhaustively on `type` is future-proof.

  New exports: `RunEvent` (+ the 7 member types), `RunEventSink`, `emitRunEvent`. Additive + backward-compatible.

  Grounded in the SDK Evolution roadmap SE2.

- eec7d55: **SE3 — multi-agent provenance (`origin`).**

  New public `MessageOrigin` discriminated union that stamps WHO triggered a turn in the multi-agent path (Squad / a2a / handoff / background-delegation) and is **forwarded onto the run result** — so consumers can attribute or route turns by their trigger. Metadata-only: zero change to routing or dispatch.

  - `MessageOrigin` union: `{ kind: "human" }` | `{ kind: "peer"; from }` | `{ kind: "task-notification" }` | `{ kind: "coordinator"; from? }` | `{ kind: "auto-continuation" }`. Absence = a direct human turn.
  - `SendOptions.origin?: MessageOrigin` — the caller stamps the provenance; `RunResult.origin?: MessageOrigin` — forwarded onto the result (both fixture and real runtimes).
  - **Squad** stamps `{ kind: "peer", from: "agent-<i-1>" }` on every step after the first (the first receives the human input). `agentStep(id, agent, prompt, { origin })` carries it; `AgentStep.origin` is the plumbing.
  - **a2a** projects `{ kind: "peer", from }` onto every `A2AMessage.origin` — a thin view over the existing sender address (`from`), not a parallel system.
  - **background-delegation / handoff** are host-driven (no in-repo re-send seam): the `SendOptions.origin → RunResult.origin` plumbing IS the integration point — a background follow-up carries `{ kind: "task-notification" }`, a coordinator carries `{ kind: "coordinator" }`.

  New exports: `MessageOrigin`, plus `origin` fields on `SendOptions` / `RunResult` / `A2AMessage` / `AgentStep` and the `agentStep(..., { origin })` option. Additive + backward-compatible.

  Grounded in the SDK Evolution roadmap SE3.

- 8606f5b: **SE4 — session-management surface (`createSessionManager`).**

  A session-management API over the `ConversationStorageAdapter` interface, so hosts (TheoKit) can build session UIs without reaching into storage internals. Light metadata is derived from the transcript; title/tag are persisted; adapters that can't list or write metadata degrade with a typed `{ supported: false }` result instead of throwing on every call.

  - `createSessionManager(storage)` → `{ listSessions, getSessionMessages, renameSession, tagSession }`, bound to the same adapter a host passed to `Agent.create({ conversationStorage })` (composition-LEGO precedent of `createSquad`).
  - `listSessions(opts?)` returns `SessionSummary`s with LIGHT metadata derived from the transcript — `firstPrompt` (first user message), `lastModified` (max `StoredMessage.at`), `messageCount`, plus a `summary` preview (title when set, else the truncated first prompt). `{ offset, limit }` windows the result.
  - `renameSession(id, title)` / `tagSession(id, tag | null)` persist session metadata (`tag: null` clears). `getSessionMessages(id, opts?)` passes through to the adapter's mandatory `getMessages`.
  - **Typed graceful degradation:** `listSessions` is unsupported when the adapter lacks `listConversationIds` (or it returns `undefined`); `renameSession` / `tagSession` are unsupported when the adapter lacks `setSessionMeta`. `SessionCapabilityResult<T> = { supported: true; value } | { supported: false; reason }`.
  - **Storage:** two new OPTIONAL adapter methods `getSessionMeta?` / `setSessionMeta?` (`SessionMeta { title?, tag? }`, `SessionMetaPatch { title?, tag?: string | null }`). `FileSystemConversationStorage` persists them in a per-conversation sidecar `.theokit/agents/<id>/session.json` (same sanitized path perimeter as the transcript); `InMemoryConversationStorage` in a `Map`.

  New exports: `createSessionManager`, `SessionManager`, `SessionSummary`, `SessionListOptions`, `SessionCapabilityResult`, `SessionMeta`, `SessionMetaPatch`. Additive + backward-compatible.

  Grounded in the SDK Evolution roadmap SE4.

- ce9b375: **SE7 — structured/multimodal tool results + `ToolError`.**

  A tool can now hand the model structured content (text + image) as its result OR its error, not just a string — symmetrically. A `handler` may RETURN content blocks on success, and may THROW a `ToolError` carrying content blocks on failure (e.g. a screenshot, a rendered chart). Additive + backward-compatible: returning/throwing a string is unchanged.

  - New types `ImageBlock` + `ToolResultContentBlock = TextBlock | ImageBlock`; new `ToolError` class carrying `string | ToolResultContentBlock[]` (throw it from a handler for a clean message or multimodal error content).
  - `CustomTool.handler` return widened to `string | ToolResultContentBlock[]`.
  - **Provider-agnostic, capability-based:** block-capable provider wires forward the blocks natively; string-only provider wires flatten text-only blocks to a string and **fail fast** with a typed `ConfigurationError` on an image block (no silent drop — a dropped image would be a lie to the model, per the error-handling policy).
  - Persistence/replay (event-based) is untouched; the tool-result guard still redacts/delimits the text of a structured result (image blocks pass through).

  New exports: `ToolError`, `ImageBlock`, `ToolResultContentBlock`. Proven end-to-end by an integration test (a handler-returned image, and a `ToolError`'s image, both carried onto the outbound `tool_result`).

  Grounded in the SDK Evolution roadmap SE7.

- 3722208: **SE8 — model bare-string shorthand.**

  Every public model-accepting surface — `AgentOptions.model`, `SendOptions.model`, `AgentBuilder.model()`, and `GenerateObjectOptions.model` / `structuringModel` / `StreamObjectOptions.model` — now accepts a bare-string model id (`model: "openai/gpt-4o-mini"`) in addition to the `{ id }` object — the familiar `"provider/model"` shorthand. Additive + fully backward-compatible: the object form (and `{ id, params }` for tuning) is unchanged.

  - A bare string is normalized to `{ id }` at ONE boundary seam (`normalizeModel`), so all downstream code keeps seeing a `ModelSelection`. The id still parses a `provider/` prefix for routing.
  - Use the object form when you need `params` (reasoning/temperature tuning): `model: { id: "...", params: [...] }`.
  - An empty / whitespace-only string throws a typed `ConfigurationError` (`code: "invalid_model_selection"`).

  A bare-string model id is the common shorthand across agent SDKs. Grounded in ROADMAP SE8.

- d039cd6: **SE9 — integrated structured output on `agent.generate()`.**

  New typed `agent.generate(input, { output: schema, ...sendOptions })` method: runs the agent's NORMAL tool loop (the user's tools run first) and then coerces the final answer into a Zod schema, returning a validated, **inferred-typed** object — in one call, instead of a separate `generateObject`. This delivers structured output straight off the agent's own tool loop.

  - `agent.generate<T>(input, { output: T, ...SendOptions }): Promise<GenerateRunResult<z.infer<T>>>` — `{ object, result, raw, usage }`. `object` carries the inferred type; `result` is the underlying tool-loop `RunResult` (status/usage/model).
  - **Sugar over `Agent.generateObject` (ADR D33), not a fork:** phase 1 is the user's own `agent.send()` run; phase 2 reuses `generateObjectImpl` (the synthetic forced-`output`-tool + Zod validation + retries) over the run's final answer.
  - **Precedence:** `SendOptions` (tools, `toolChoice`, `maxIterations`, …) drive phase 1; the structuring phase forces its own `output` tool. `maxRetries` / `errorStrategy` (`"throw"` | `"return-partial"` | `"return-raw"`) tune phase 2.
  - **Typed failure:** a run that errors before an answer surfaces a typed `GenerateObjectError` (no structuring over a failed run); a persistent parse-failure is governed by `errorStrategy`.
  - Available on both local and cloud agents.

  New exports: `GenerateOptions`, `GenerateRunResult` (+ the `SDKAgent.generate` method). Additive + backward-compatible. Grounded in ROADMAP SE9.

### Patch Changes

- d07ae2e: Dead-code cleanup (evidence-based review, 2026-07-09).

  - Removed 8 dead files: 6 unused barrels (`internal/{error-mappers,tool-dispatch,tool-registry,workflow}/index.ts`, `server/adapter/index.ts`, `internal/observability/index.ts`) whose members are reached via direct imports, plus `internal/runtime/hooks/hooks-loader.ts` (`loadProjectHooks` had zero callers) and `internal/observability/context.ts` (only reachable via the now-removed barrel). The live `internal/observability/tracer-loader.ts` is untouched (3 direct importers).
  - Removed two dead public sub-path exports: `@theokit/sdk/internal/plugins` and `@theokit/sdk/internal/observability` (both `@internal`, semver-exempt, zero consumers across the monorepo). The plugin contract (`definePlugin`/`Plugin`) remains exported from the main entry — the sub-path was superseded (see `src/index.ts`); `internal/plugins/index.ts` stays as an internal relative import.

  No behavior change — typecheck + build green; full test suite delta neutral (pre-existing flaky init-claude/oauth failures unchanged). See `DEAD-CODE-REVIEW-2026-07-09.md` for the full 3-layer review and the remaining phased plan.

- e462318: Deprecate the `@theokit/sdk/client` sub-path (`TheoKitClient`).

  `TheoKitClient` consumes a legacy server-adapter HTTP contract (`POST /agent/send`, `GET /agent/stream`) that the ecosystem no longer produces — the framework (`theokit`) exposes agents at `POST /api/agents/<name>` over a `UIMessageStream` with its own typed client, and the SDK's own in-process path is the `Agent` façade. The sub-path has zero consumers across the monorepo (evidence-based dead-code review, 2026-07-09).

  Marked `@deprecated` (class + barrel + types). No behavior change — the sub-path still works this major. It will be **removed in the next major**. Migrate to `Agent` (`@theokit/sdk`) for in-process runs, or the framework's `/api/agents/<name>` typed client for HTTP.

- b4f165c: Remove 3 orphaned internal helpers (dead code, 0 references monorepo-wide): `buildRequestId` (a wrapper around `generateRequestId`, no callers), `isCloudAgentId` (`internal/ids.ts`, no callers), and `deleteTokens` (`internal/mcp/token-storage.ts`, no callers). All `@internal`, not part of the public API. Verified: typecheck + build green, full test suite unchanged (181 pre-existing flaky failures, 3042 pass — identical to baseline).

  The remaining knip-flagged "unused exports" were audited and deliberately NOT deleted: they are mostly redundant `export` modifiers on symbols still used same-file (cosmetic), future-reserved stubs (`serializeHookRules` — "reserved for future"), or intentional test/reset seams (`__*ForTests`, `createTestCtx`, `clearRunRegistry`, `memoryFilePath` — "kept for tests"). Those are maintainer judgment calls, not mechanical dead code. See `DEAD-CODE-REVIEW-2026-07-09.md`.

## 2.20.0

### Minor Changes

- **M21 — `GenerateObjectOptions.structuringModel`.** An optional separate model for the structured-extraction step: when set, `model` first produces a free-text reasoned answer (phase 1), then `structuringModel` extracts the schema-matched object by calling the synthetic `output` tool over that answer (phase 2). Lets a large model reason while a cheap fast model structures. Absent ⇒ today's single-model flow (backward-compatible). Proven by a golden test asserting two distinct model ids in the run.
- **M22 — `createSkill()` + `SkillsSettings.skillsDir` / `.inline`.** `createSkill({ name, description, instructions })` defines a skill in TypeScript without a `SKILL.md` file; pass code-defined skills via `skills.inline` (they surface in `list()` + the `<skills>` block alongside filesystem skills, overriding a file skill of the same name). `skills.skillsDir` discovers skills from a custom directory instead of `<cwd>/.theokit/skills`. Both compose with the per-request enabled-name resolver.
- **M23 — `normalizeSchema()`.** Converts a schema from Zod (default), JSON Schema (passthrough), ArkType (`.toJsonSchema()`), or Valibot (via the optional `@valibot/to-json-schema` peer) to the internal JSON Schema the synthetic `output` tool uses. Zod stays the default and the documented recommendation; thin adapter, uniform parse-failure handling. A golden test per provider.

## 2.19.0

### Minor Changes

- `GenerateObjectOptions.errorStrategy` (`"throw" | "return-partial" | "return-raw"`, default `"throw"`) — controls what `Agent.generateObject` does when the model's output still fails schema validation after all retries. `"return-raw"` resolves with the raw unvalidated input; `"return-partial"` salvages best-effort (object schemas keep only fields that individually validate). Additive + backward-compatible (M14).

## 2.18.1

### Patch Changes

- fc09700: Label the cloud-only surfaces as pre-release in `docs.md` (M7). The README already
  carried a "Cloud runtime — pre-release" banner; `docs.md` (the canonical API
  contract) only labeled artifacts. It now carries an explicit cloud pre-release
  banner in the Overview and inline "cloud-only, pre-release" labels on `cloud.envVars`,
  `cloud.autoCreatePR`, and `result.git` — matching the SDK's pre-release-honesty
  contract (cloud depends on Theo PaaS, currently pre-release; every cloud API
  describes the contract for when PaaS reaches GA, validated by the SDK's cloud
  contract/golden tests against a stub, not a live endpoint). No API or behavior
  change; no GA claim. Also fixed a teardown race in the cloud runtime contract test
  (dispose flushes the fire-and-forget session appends before the temp workspace is
  removed, so `rm(recursive)` no longer races an in-flight write into `ENOTEMPTY`).
- e132c2d: Strengthen the README cross-pillar front door (M8 GA-readiness): the "Where this
  fits" section now explains the 4-pillar OPEN-STACK composition (UI · Harness ·
  Skills · Runtime), how they compose end-to-end (local agent + tools/plugins +
  `useAgentStream` render, zero Theo-backend dependency), the honest per-pillar status
  (Runtime/cloud pre-release), and the validated cross-pillar wiring (Skills↔Harness +
  UI↔Harness green vs SDK 2.18.0; Runtime↔Harness contract-only). Also fixes a stale
  reference to the removed `referencia/` directory (study peers are cloned on demand
  under `.claude/knowledge-base/reference/`). Docs-only; no API/behavior change; no GA
  claim.

## 2.18.0

### Minor Changes

- 3eca862: Resume is no longer lossy (#62). (1) **Session hydration** used to filter the rebuilt context to `user`/`assistant` only, silently dropping `tool_call`/`tool_result` turns — a resumed agent forgot every tool it had run. Tool turns are now folded into the hydrated context (as assistant-role context) so the tool history survives resume; legacy user/assistant JSONL loads unchanged. (Exact tool_use/tool_result LLM-block reconstruction for mid-call resume needs persisted tool-use ids — a schema change deferred.) (2) **Workflow resume** used to continue from the suspend point with only the resume payload, so earlier step outputs were lost; the resumed run now restores the snapshot's accumulated step outputs, so a post-suspend step can see prior results. (3) **Scoped session state:** `scopedConversationId(scope, id)` namespaces a conversation id by `app:`/`user:`/`temp:` scope (path-safe `__` separator), and `ConversationStorageAdapter.deleteScope(prefix)` prunes a whole scope (e.g. `temp` on logout) in one call — additive.
- 4af68fc: Observability is now trustworthy (#64). (1) **Nested spans:** `startChildSpan` used to discard its parent and start a flat sibling, so a trace backend could not reconstruct the causal tree; it now links the child to the parent via an explicit OTel parent context (`llm.call` / `tool.call` nest under `agent.send`). (2) **EventBus fails loud:** a throwing subscriber used to vanish into an empty `catch {}`; `publish` now logs the error (event key + message) to stderr and increments an observable `handlerErrorCount`, while preserving the EC-2 contract that sibling handlers still fire. (3) **Metrics:** tool-call / LLM-call durations + LLM token throughput — previously measured but only attached as span attributes — are now emitted as dedicated metrics via the existing `recordHistogram` path.
- b4cc298: A silent LLM token undercount is now observable (#66). When a provider omits `usage` on a finish, the SDK used to coerce the counts to `0` (`?? 0`), so budget consumption was under-reported without any signal. The loop now distinguishes "provider omitted usage" from "0 tokens used": it emits a `theokit_llm_usage_missing` metric and a stderr WARN so the gap is visible, instead of silently zeroing. Normal finishes emit the token throughput as a `theokit_llm_tokens` metric. No new dependency (no local tokenizer — the fix makes the silent gap loud + measurable rather than estimating). Also documents the artifacts scope decision (cloud-only/pre-release; a local ArtifactService is deferred) in docs.md.
- 08539f0: Fix a cross-model semantic-cache false hit and add session revert (#67). (1) **Model-scoped cache:** the semantic-search path filtered eligible entries by embedder + namespace + dim + expiry but NOT `modelId`, so two models sharing an embedder could return each other's cached response; `semanticSearch` / `isEligibleForSearch` now require `modelId` equality (the composite KV key already included it). (2) **Session revert:** `ConversationStorageAdapter.truncateConversation(id, keepCount)` reverts a transcript back to its first `keepCount` messages ("undo the last turn(s)"), rewriting the JSONL atomically under the same cross-process lock as append/compaction; the FS + in-memory adapters implement it. `keepCount <= 0` empties, `keepCount >= length` is a no-op.

### Patch Changes

- 997ae59: An explicitly-passed `apiKey` now selects its provider, unblocking the Skills↔Harness seam (M4). A run created with `Agent.create({ apiKey: "sk-or-…", model: { id: "openai/gpt-4o-mini" } })` used to fail with a swallowed `ConfigurationError: No provider client could be resolved (primary=openai)` — the router inferred the provider from the model's `openai/` prefix and ignored the OpenRouter key, so the LLM was never called and the run ended `status: "error"` with zero stream events. Two fixes: (1) **provider selection** now consults the API key prefix (`sk-or-` → OpenRouter, `sk-ant-` → Anthropic) ABOVE the model-prefix inference — the key is the ground-truth credential of which endpoint is called — while an explicit `providers.routes[0].provider` still wins; an aggregator's model slug (`openai/gpt-4o-mini` under OpenRouter) is passed through unstripped. (2) the single `AgentOptions.apiKey` is now **threaded into the provider pool** for the resolved provider, so an explicitly-passed credential is used even when the matching env var is unset (an existing `providers.apiKeys` pool still wins; fixture / `local` sentinels are never threaded). The SDK's own `openrouter-stream` / `openrouter-tools` / `openrouter-structured` real-LLM tests now pass end-to-end. All stdlib — no new dependency.

## 2.17.0

### Minor Changes

- beb1e9a: The stdio MCP client now reconnects after a transport drop (#59, completing the M0 timeout work). A server child that exits or closes mid-session used to leave pending requests hung forever (a second permanent-hang vector distinct from the request timeout). Now an unexpected exit of the active child rejects every pending request with a typed `NetworkError` (`code: "mcp_disconnected"`) and marks the client dropped; the next request re-spawns the server and re-runs the `initialize` handshake with a bounded full-jitter backoff (2 attempts) before failing with `mcp_disconnected`. A deliberate `close()` is not treated as a drop (no reconnect). The http transport is stateless — each request opens a fresh connection, so it reconnects inherently on the next call; its error-surfacing contract is unchanged. Elicitation, server notifications, and adopting the upstream MCP SDK remain out of scope (documented boundary). No new dependency.
- 3765aed: The credential pool now backs off before retrying a rate-limited key and trips a circuit breaker when a provider is down (#60). On the first 429 the pool used to re-hit the same key immediately (a `continue` with no sleep), burning every retry in under a millisecond under a shared-quota storm; it now sleeps a full-jitter backoff (`computeBackoffMs` + `sleepWithAbort`, already in-tree, now wired) before the same-key retry. A consecutive-failure circuit breaker (relocated to a neutral `internal/resilience/` module and shared with Active Memory) guards each provider: after N consecutive whole-attempt failures the pool fails fast with a typed `NetworkError` (`code: "circuit_open"`) until a cooldown elapses, instead of re-running the whole select→retry→rotate dance against a provider that is down. All stdlib — no new dependency. Existing name-only behavior and the provider's `Retry-After` cooldown on the rotate path are unchanged.
- a1d0f3d: Harden the streaming path against stalls, truncation, and malformed tool-call JSON (#61).

  - **Idle timeout:** every SSE `reader.read()` is now raced against an idle timer (default 60s, `parseSseStream(body, signal, idleTimeoutMs)`; pass `0` to disable). An upstream that handshakes then goes silent no longer hangs the agent loop forever — it rejects a typed `NetworkError` (`code: "stream_idle_timeout"`) and the body socket is cancelled. "Idle" means _no bytes at all_ within the window, so a slow-but-alive stream is unaffected.
  - **Truncation detection:** an OpenAI-compatible stream that ends with NEITHER a `finish_reason` NOR a `[DONE]` sentinel was truncated (dropped connection / proxy hiccup). It now throws a typed `NetworkError` (`code: "stream_truncated"`) instead of silently committing the partial turn as a clean `end_turn`, so retry/fallback can route it.
  - **Tool-call JSON repair:** `parseToolArguments` now attempts `jsonrepair` (already an in-tree dependency) before the `{ raw }` fallback, so a slightly-malformed native tool call (trailing comma, unquoted key — the Kimi/K2 class) parses instead of bouncing to the model as an `invalid_request` round-trip. Genuinely unrepairable input still lands in `{ raw }`.

  All stdlib + an existing dependency — no new runtime dependency.

- daa71de: Conversation persistence is now batched, cross-process-safe, and paginated (#63).

  - **Batch turn append:** `ConversationStorageAdapter.appendMessages(id, messages[])` writes a whole turn (user + assistant + N tool results) in ONE atomic write instead of N separate `mkdir` + `appendFile` cycles. It is a public adapter capability for consumers that persist a turn or bulk-import history; the SDK's own runtime still appends incrementally (one message per loop event), but every such append now funnels through the same lock-guarded write path below, so the cross-process hardening is live regardless. The single `appendMessage` delegates to the batch of one.
  - **Cross-process atomicity:** FS append and compaction now hold the same `proper-lockfile` cross-process lock (falls back to an in-process mutex when `proper-lockfile` is absent). Two Node processes sharing a cwd (CLI + daemon, parallel workers) can no longer tear a >4KB JSONL line or drop a line in the compaction read→rename window.
  - **Pagination:** `getMessages(id, { offset, limit })` returns a bounded window so a caller hydrating a long history need not materialize the whole log (omit `opts` for the previous full read — backward-compatible). The in-memory adapter reads a true bounded slice; the FS/JSONL adapter bounds the materialized result (a future SQLite backend would bound the read itself).

  No new dependency (`proper-lockfile` was already declared).

## 2.16.0

### Minor Changes

- f93bb9a: `PermissionEngine` now gates on tool **arguments**, not just the tool name, and defaults **fail-closed** (#55). A `PermissionRule` may declare `args?: Record<string, string | RegExp | (value) => boolean>`; `evaluate(toolName, args?)` matches a rule only when the tool name matches AND every declared argument predicate matches the corresponding call argument — so a single `shell` rule can deny `rm -rf` while letting `ls` fall through. A missing/undefined argument fails its predicate (the rule does not match; it never throws). Name-only rules are unchanged. `createPermissionPlugin(engine)` now forwards the tool arguments into `evaluate`, so argument-level gating works through the `pre_tool_call` flow automatically.

  **BREAKING (behavior):** the action returned when NO rule matches is now `"ask"` (fail-closed), changed from the previous `"allow"` (fail-open). A permission engine that cannot positively allow must not silently allow. If you relied on the fail-open default, restore it explicitly with `new PermissionEngine(rules, { defaultAction: "allow" })`.

- 16e24a3: Add an opt-in tool-result content guard against prompt injection and PII leakage (#57). Tool results are untrusted input to the model; the new guard runs at the `transform_tool_result` seam before results reach the LLM. Enable it per send via `SendOptions.toolResultGuard`: `{ delimit: true }` frames tool output in explicit `<untrusted-tool-output>` data boundaries ("spotlighting") so the model treats it as data rather than instructions — a forged closing boundary inside the content is neutralized so it cannot break out of the frame; `{ redactPii: true }` replaces email/phone PII with `[REDACTED]`. Both are opt-in and non-breaking (undefined = unchanged behavior). The `defineTool` / `CustomTool` handler type is also widened to accept the optional `ToolContext` 2nd argument (completing the #65 wiring): single-argument handlers are unaffected.
- c004a3b: Cancellation now actually interrupts in-flight work, tools get a per-call timeout, and the job queue is bounded (#58).

  - `JobQueue` runs each job under an `AbortController` whose signal is passed to the job fn, so `cancel(id)` interrupts a cooperative running job instead of only flipping a status flag. A new `maxConcurrency` option bounds how many jobs run at once (omit for the previous unbounded behavior; values < 1 clamp to 1). The job fn signature is now `(signal: AbortSignal) => Promise<T>` — existing `() => Promise<T>` callers are unaffected (the signal is simply ignored).
  - Tool dispatch threads the run's `AbortSignal` into each tool handler and bounds each tool call with an optional per-tool timeout (`SendOptions.perToolTimeoutMs`) (via `AbortSignal.any([runSignal, AbortSignal.timeout(ms)])`), so cancelling a run interrupts a running tool and a hung tool rejects a typed timeout instead of wedging the loop; the loop also checks for cancellation between iterations. All stdlib (Node ≥22.12) — no new dependency.

- 01b4edd: Wire the 7 previously-dead plugin hooks and add a `ToolContext` to tool handlers (#65). `HookName` declared 10 hooks but only 3 (`pre_tool_call`, `pre_user_send`, `post_assistant_reply`) were ever invoked — a plugin registering `post_tool_call`, `pre_llm_call`, `post_llm_call`, `on_session_start`, `on_session_end`, `transform_tool_result`, or `transform_llm_output` got a silent no-op. All 7 now fire at their real site in the agent loop: `on_session_start`/`on_session_end` at run start/end (even on error), `pre_llm_call`/`post_llm_call` around each LLM turn, `post_tool_call` after each tool completes, and the two `transform_*` hooks fold over their payload (a handler's return value replaces it) before it reaches the LLM — `transform_tool_result` is the seam for tool-result content defense. Per-handler errors are logged, never thrown (a throwing transform keeps the prior payload). Additionally, tool handlers defined via `defineTool` now receive an optional 2nd `ToolContext` argument carrying the run's `AbortSignal`, so a cooperative handler can stop early on cancellation; existing single-argument handlers are unaffected.

## 2.15.3

### Patch Changes

- 5412d7a: Stop leaking host secrets into child processes and stop overclaiming sandbox isolation (#54). Every subprocess the SDK spawned (hook scripts via the hooks executor, the shell tool, and `LocalSandbox`) inherited the FULL `process.env`, so API keys, tokens and passwords were exposed to executed commands. A new stdlib env-policy helper (`resolveChildEnv`, modeled on codex's `ShellEnvironmentPolicy`) now scrubs secret-like variable names (`*KEY*`, `*SECRET*`, `*TOKEN*`, `*PASSWORD*`, `*_AUTH*`) from the child environment by default (`inherit-scrubbed`). Non-secret vars (including `PATH`/`HOME`) are preserved, and an explicit `env` override always wins, so this is non-breaking for legitimate use. Opt out with policy `"all"` or tighten with `"core"` via `SandboxConfig.env`. `LocalSandbox`'s documentation is corrected to state plainly that it provides NO OS/filesystem/network isolation — only a timeout, an output cap, and env scrubbing.

  The scrub is also applied to the **MCP stdio server subprocess** (via a new `envPolicy` field on the stdio server config), which previously inherited the full `process.env` — the highest-risk path, since MCP servers are often third-party binaries launched via `npx`. The secret-name denylist covers `*KEY*`, `*SECRET*`, `*TOKEN*`, `*PASSWORD*`, `*PASSWD*`, `*PASSPHRASE*`, `*[_-]PWD*`, `*CREDENTIAL*` (incl. `GOOGLE_APPLICATION_CREDENTIALS`), `*PRIVATE*`, `*_AUTH*`; for untrusted children use policy `"core"` (allowlist), the only fail-closed model (a denylist cannot catch creds embedded in a value such as `DATABASE_URL`). **Behavior change:** hook scripts and the shell tool no longer inherit secret-named host vars by default — pass them explicitly via the tool's `env`, or use policy `"all"`.

- 58f440d: Fix a cross-tenant active-recall cache leak (#56). Active Memory recall results were cached keyed only by `(queryMode, userText)`, so two callers in the same process issuing the same query text — but belonging to different tenants (namespace / userId / scope) — could receive each other's recall results. The cache key infrastructure already supported a tenant tuple; `runActiveMemory` now threads `{namespace, userId, scope}` into both `cache.get` and `cache.set`, so recall entries are isolated per tenant. Same-tenant cache hits are preserved (no over-keying). No public API change.
- e4cc6e9: Bound every MCP request with a timeout so a non-responding server can no longer hang the agent loop (#59). The stdio transport's `request` returned a Promise that never resolved when the server read the request but never replied; the http transport's `fetch` had no timeout. Both now enforce a per-request `requestTimeoutMs` (default 30000, configurable per server): stdio races the pending request against a timer that rejects a typed `NetworkError` (`code: "mcp_timeout"`) and drops the pending map entry (a late reply after timeout is a no-op — never a double-settle); http passes `AbortSignal.timeout` and maps an abort to the same typed error while surfacing any other fetch failure unchanged. `close()` now also settles any in-flight requests (`code: "mcp_closed"`) instead of leaking their timers. A timed-out stdio server is torn down (SIGKILL) so it cannot linger as a zombie, and the stdout read buffer is capped (8 MB) so a hostile/broken server flooding stdout without a newline (`code: "mcp_buffer_overflow"`) cannot pin memory.
- 98ac0d0: Fix a live security defect: the ACP `pre_tool_call` permission veto was never enforced (#68). `installPermissionPlugin` tried to register its veto hook via `pluginManager.register(...)`, but `PluginManager` exposed no `register()` method — only a single-shot `initialize()` that throws when called twice. The call fell through to `void mgr.initialize([plugin])`, whose "called twice" rejection was swallowed, so the permission hook was never aggregated and guarded tools ran **without** the permission check even under `permissionMode: "deny"`/`"ask"`.

  `PluginManager` now exposes `register(plugin)` — a post-init, `general`-only registration that REPLACES a same-named plugin's hooks (idempotent for the per-prompt ACP re-install) instead of appending duplicates. Additionally, `installPermissionPlugin` is now **fail-closed**: when the runtime has no plugin manager (e.g. a CloudAgent) and the mode is `deny`/`ask`, it throws a `ConfigurationError` (`code: "permission_enforcement_unavailable"`) and the ACP prompt is refused — rather than letting tools run ungated while the operator believes they are gated. It is also now `async` and awaits registration, so the veto hook is guaranteed aggregated before the first tool dispatch (no fire-and-forget window).

## 2.15.2

### Patch Changes

- 6336f81: Suppress the leaked-dialect tool-call from the visible stream (R7). When `extractToolCallsFromContent` is enabled and a model leaks a `<function=NAME>` tool call as assistant text, the OpenAI-compat streaming now HOLDS that text back at the stream boundary (a small suspicion-buffer FSM that reuses the request-scoped allowlist from R5) instead of emitting it as `text_delta` events — so the raw dialect no longer flashes by in the live stream or lands in the final assistant text. `finish()` still recovers the call (unchanged). Fail-open: a never-closing marker or un-suppressable input is flushed as visible text (never held forever). Flag-off streaming is byte-for-byte unchanged. Grounded in a survey of state-of-the-art stream-normalizer FSMs.

## 2.15.1

### Patch Changes

- bec2077: Make the leaked-dialect recovery **request-scoped (R5)**. The opt-in `extractToolCallsFromContent` recovery previously promoted ANY `<function=NAME>` block leaked into assistant text on an enabled route, so a code assistant printing a literal `<function=example>` in a fenced code block could be wrongly turned into a tool call. Recovery now gates on an exact, case-sensitive allowlist derived automatically from the current request's declared tools (`request.tools`): the per-route flag stays the coarse enable, and the allowlist is the precise false-positive guard. A request with no tools recovers nothing; a gated-out block keeps its text visible (it is not silently deleted). No public API change — the allowlist is derived from the tools you already pass, following the standard tool-call-repair allowlist approach.

## 2.15.0

### Minor Changes

- d7057f2: Add a **doom-loop / no-progress guard** to the agent loop. The loop now detects when the model repeats IDENTICAL tool calls (same name + same canonical input) that make no progress — the qwen3-coder `read_file`/`not_found` failure mode where the model retries the same failing call and the run grinds to the iteration ceiling — and stops early with a typed `no_progress` terminal instead of hanging. A pure `DoomLoopTracker` (canonical key-sorted-JSON signature + a consecutive-identical counter) escalates from a one-time guidance nudge at a soft threshold to a hard stop; the hard stop surfaces on `RunResult.stoppedByDoomLoop` and, through the continuation driver, as `terminal: "no_progress"` (so the outer loop does not re-send). It complements — does not replace — the existing empty-round `no_progress` (a different failure mode: model stuck repeating vs model gone silent). On by default with generous thresholds (soft 3 / hard 5); tune or disable per send via `SendOptions.doomLoop` (`false` to disable, or `{ softThreshold, hardThreshold }` to tune). Dependency-free. Grounded in a survey of state-of-the-art loop-detection and doom-loop guards.

## 2.14.0

### Minor Changes

- 6ee4217: Add a public, isolated tool-input **sanitization** primitive on the new `@theokit/sdk/sanitize` subpath, plus a declarative `defineTool({ sanitize })` opt-in. Custom tools can now clean the raw arguments a model emits before they reach the tool schema: `sanitizeToolInput(input, options?)` trims whitespace by default and — opt-in — coerces string values toward their expected type (`"5"`→`5`, `"true"`→`true`, JSON-encoded strings→arrays/objects) and repairs malformed JSON (via `jsonrepair`). Coercion is guarded against silent corruption: numeric coercion round-trips and stays finite, so ID-like strings (`"12345678901234567890"`, `"007"`) and `NaN`/`Infinity` are left as strings; JSON repair only runs on JSON-looking values; a non-object input is returned untouched (the primitive is total — it never throws). When a Zod object schema is passed, coercion is schema-aware (a `z.string()` field keeps `"5"` a string). `defineTool({ sanitize: true })` trims the raw args before validation; `defineTool({ sanitize: { coerce: true } })` additionally coerces toward the tool's own schema — absent, `defineTool` behaviour is unchanged. Internally, the leaked-dialect recovery (`hermes-tool-extract`) now reuses the same primitive, so the public surface and the internal path never diverge. Grounded in a survey of state-of-the-art agent runtimes.

## 2.13.1

### Patch Changes

- 65763b9: Trim leaked-dialect tool-call parameter values during recovery. Models that leak the Hermes dialect as text (qwen3-coder) emit each parameter on its own line, so the recovered value carried the formatting newlines: `<parameter=path>\npackage.json\n</parameter>` produced `{ path: "\npackage.json\n" }`. Untrimmed, `read_file` / `glob_files` / `search_text` received a path/pattern wrapped in newlines and failed `not_found` (only `shell_exec` tolerated it, since bash ignores blank lines), so a multi-read investigation loop kept re-reading, never converged, and appeared to hang. The recovery extractor now trims each parameter value (leading/trailing whitespace only — internal newlines of a legitimate multi-line command survive), matching the native `tool_calls` path where such formatting noise never occurs. Values remain strings; downstream schema coercion is unchanged.

## 2.13.0

### Minor Changes

- 958a81f: Add per-route opt-in for leaked-dialect safe-parse (`ProviderRoute.extractToolCallsFromContent`, default off). The 2.12.0 release exposed the recovery flag only on a static `ProviderProfile`; enabling it required redeclaring a provider profile. This adds the same flag at the routing layer, so a consumer can opt a single chat route into recovery without cloning the built-in provider: `providers: { routes: [{ capability: "chat", provider: "openrouter", extractToolCallsFromContent: true }] }`. The router clones the resolved profile with the flag for that run (built-in profiles still ship the flag off), so the OpenAI-compatible transport recovers the Hermes `<function=…></tool_call>` dialect leaked as text by models like qwen3-coder. Derived from `routes[0]` (mirrors how the primary provider is derived) and applied to the resolved chat chain; fail-open and default-off, so a non-leaking route is unaffected. This is the enablement path consumed by `@theokit/agents`' `recoverLeakedToolCalls` knob.

## 2.12.0

### Minor Changes

- 95e9cba: Add opt-in leaked-dialect safe-parse for OpenAI-compatible providers (`ProviderProfile.extractToolCallsFromContent`, default off). Some models — notably qwen3-coder via OpenRouter — intermittently emit their Hermes tool-call dialect (`<function=NAME><parameter=KEY>VALUE</parameter></function></tool_call>`) as assistant TEXT instead of native `tool_calls`. When that happens the provider sends ZERO native `tool_calls`, so the agent loop sees a plain `end_turn` and the intended call is silently lost (theokit#58 follow-up). With the flag enabled, a `chat_completions` finish that has no native `tool_calls` has its assistant content scanned for the leaked dialect; any recovered calls are surfaced as real `tool_calls` and the stop reason flips to `tool_use` so the loop dispatches them. Fail-open like `stripThinkBlocks` — a partial/unclosed block is left as text and never fabricates a call. Default off, dedup-guarded (native `tool_calls` always win, no double-count), and scoped per-provider so a code assistant printing a literal `<function=` in a fenced block on a non-leaking route is unaffected.

## 2.11.3

### Patch Changes

- bb3a7d8: Fail-loud on in-stream provider errors. OpenRouter (and some OpenAI-compatible proxies) report auth / quota / rate-limit failures as an HTTP 200 SSE body carrying `data: {"error":{"message":"...","code":401}}` rather than a non-2xx status. The stream accumulator only reads `choices`, so such an error-only chunk produced zero events and the turn finished empty — the failure was silently swallowed (a dead API key looked like an empty model response). The OpenAI client now detects an in-stream `error` chunk and throws the same typed error a non-2xx HTTP status would (`AuthenticationError` / `RateLimitError` / `ConfigurationError` / …), so callers surface it instead of a blank turn. Fixes usetheodev/theocode#31.

## 2.11.2

### Patch Changes

- 8b411c5: Add `SendOptions.toolChoice` (`"auto" | "none" | "required"`), forwarded to the OpenAI/OpenRouter `tool_choice` request field. `"none"` forces a text answer even when the agent has tools registered — this lets an agent loop force a closing summary at its step ceiling (a cached agent's tools cannot be un-registered, so the gate must be applied per-send, not at agent creation). `tool_choice` is emitted only alongside a non-empty `tools` array. Additive and backward-compatible (absent ⇒ provider default).

## 2.11.1

### Patch Changes

- 6893812: Forward `ModelSelection.params` reasoning to OpenRouter / OpenAI-compat providers (issue #47). The `thinking` param was silently dropped (model resolution kept only `model.id`; the request body had no `reasoning` field), so `Agent.send` never requested or surfaced reasoning. Now a `thinking` param maps to the reasoning request the target provider accepts — OpenRouter (and OpenAI-compatible passthroughs) use the unified `reasoning: { effort }` object, while native OpenAI Chat Completions uses the top-level `reasoning_effort` string (so opting into reasoning never 400s on api.openai.com). The streamed reasoning (`delta.reasoning`, or `delta.reasoning_content` on DeepSeek-direct / vLLM / LMStudio compat endpoints) is surfaced as `thinking-delta` `InteractionUpdate`s (live via `onDelta`) plus a `thinking` `SDKMessage` (replayed by `Run.stream`), on a separate channel from the visible answer. Validated end-to-end against `deepseek/deepseek-r1` via OpenRouter.

## 2.11.0

### Minor Changes

- ac3f77d: @theokit/sdk: resolveModelCapabilities catalog gains cheap OpenRouter slugs (qwen3-coder, deepseek v4-flash/v3.2, glm-4.7-flash, gemini-2.5-flash-lite/pro) so they resolve real context windows instead of the 4096 default. @theokit/sdk-tools: new createGenericHttpSearchAdapter (env-keyed generic HTTP WebSearchCallback alongside Brave); buildEnvContext gains git-branch detection + an injectable clock. @theokit/sdk-cache: ships createLexicalEmbedder (zero-dependency token-hash lexical embedder built-in).

## 2.10.0

### Minor Changes

- 5bd2f9c: @theokit/sdk: `shouldCompact`/`ShouldCompactInput` gains an optional `maxOutput` output-reserve term (`estimated >= contextWindow - buffer - (maxOutput ?? 0)`), defaulting to today's behavior. `AgentOptions.plugins` now also accepts an array of code `Plugin` objects (matching the runtime + docs), not only `{ enabled }`. @theokit/sdk-tools: `renderToolList` gains an optional `{ mode: "full" | "summary" | "names" }` — `"full"` (default) is the existing `<tools>` XML; `"summary"` renders `- name: <first sentence>`; `"names"` renders `- name`.

## 2.9.0

### Minor Changes

- 4cbd107: V3-5 — make the eval-harness primitives usable without constructing a `SandboxBackend`. Both default to a `LocalSandbox` when no backend is passed; the explicit-sandbox path is unchanged.

  - `provisionRepo` gains a 1-arg overload `provisionRepo(opts)` (sandbox defaults to a `LocalSandbox`, cloning into the process cwd's `<instanceId>`). The existing `provisionRepo(sandbox, opts)` form is unchanged. Pass an explicit `LocalSandbox({ workDir })` / Docker / E2B backend to control the workdir.
  - `Scorers.verifyGate` — `VerifyGateOptions.sandbox` is now optional, defaulting to a `LocalSandbox` (workdir-independent: `verifyGate` always `cd`s to the explicit `repoDir`).

  Lets a local execFile-based eval harness adopt these helpers without instantiating a backend it does not otherwise need. Zero new dependency (the default reuses the already-public `LocalSandbox`).

## 2.8.0

### Minor Changes

- f2203ed: V3-3 — add a **token-budget mode** + **configurable marker** + **template-driven summarizer** + **opt-in fail-safe** to `@theokit/sdk/compaction`, reaching behavioral parity with theocode's compaction so it can adopt the SDK helper. All additive and default-preserving — no existing `keepRecent` caller, persisted `[[theokit:checkpoint]]` marker, or propagate-on-throw contract changes.

  - `compactTranscript(messages, { keepTokens?, marker?, summaryTemplate?, failSafe?, … })`:
    - `keepTokens` selects the recent window by accumulated `estimateTokens` (theocode `splitTranscript` semantics; always keeps ≥ 1 turn). Takes precedence over `keepRecent`; in this mode leading system prompts are not specially preserved.
    - `marker` (default `CHECKPOINT_MARKER`, must be non-empty) lets a consumer use a custom checkpoint sentinel such as a persisted `<conversation-checkpoint>`.
    - `summarize(older, template)` now receives the summary `template`; `SUMMARY_TEMPLATE` (a 7-section template — Goal/Constraints/Progress/Decisions/Next/Critical/Files) is exported and overridable via `summaryTemplate`.
    - `failSafe: true` returns the ORIGINAL transcript + a structured warn when the summarizer throws (default still propagates).
  - `filterFromLatestCheckpoint(messages, { marker?, include? })` — `include: "from"` returns the turns from the latest checkpoint inclusive (default `"after"` unchanged).
  - `buildCheckpoint(label?, marker?)` — accepts a custom marker (empty marker throws).

  Zero new dependency (token-budget reuses the in-module `estimateTokens`).

## 2.7.0

### Minor Changes

- 96a507f: V3-4 — add `agent.streamToCompletion(message, options?)`, the STREAMING twin of `runToCompletion`. It returns an `AsyncGenerator<SDKMessage, StreamToCompletionResult>` that yields each continuation round's messages LIVE (so a UI can render tool calls + text as they happen across rounds), reusing the exact same terminal policy as the M1 driver — `classifyRound` (`done`/`step_limit`/`no_progress`) + bounded re-prompt + usage aggregation (no new policy; the only difference from `runToCompletion` is surfacing events over `Run.stream()` instead of `Run.wait()`). Local agents only; cloud agents throw `UnsupportedRunOperationError`. Stateful like `runToCompletion`; the STATELESS+streaming combination reconstructs history with `buildReplayHistory` into a fresh session first. The `StreamToCompletionResult` is the generator's return value (read via a manual `next()` loop — a plain `for await...of` discards it). Closes the V3-4 (a) streaming gap; (b) stateless and (c) terminals were already covered by `buildReplayHistory` + `runToCompletion`. Zero new dependency.

## 2.6.0

### Minor Changes

- edbc3c2: Add the public `@theokit/sdk/persistence` sub-path (V2-3 — Theo Harness Capability Map). Promotes the consumer-grade persistence helpers from the semver-exempt `internal/persistence` to a STABLE, semver-protected surface: `appendJsonl` / `readJsonlIds` / `loadJsonl` (durable JSONL persist + resume), `replaceFileAtomic` / `atomicWriteText` / `atomicWriteJson` (audited atomic write — fsync, 0o600, crypto-random temp), `withFileLock` (cross-process lock), and `openSqliteResilient` / `applyWalWithFallback` / `isCorruptionError` (resilient SQLite bootstrap). Several were extracted from a real consumer (the SWE-bench eval harness); this sub-path lets consumers adopt them without coupling to `internal/`.

## 2.5.0

### Minor Changes

- 301d4a3: Eval harness (M6, Tema E): first-party SWE-bench-style primitives over the existing `Eval`/`Scorers`/`SandboxBackend` surface, with zero new runtime dependencies.

  - `loadJsonl(path, { map? })` from `@theokit/sdk/eval` — generic JSONL dataset loader with line-numbered `JsonlParseError`; the dataset schema is the caller's via `map`.
  - Durable batch: `Eval.run({ persist: { path, key, resume }, classify })` flushes each row the instant it completes and resumes a crashed run by skipping already-persisted rows.
  - `provisionRepo(sandbox, { repoUrl, ref, instanceId })` + `RepoProvisionError` — portable git clone+checkout over `SandboxBackend.execute`.
  - `Scorers.verifyGate({ failToPass, passToPass })` — grades a patch by test exit-code via the sandbox; `EvalRowResult.artifact` carries `{ diff, applies }`.

- 32180fe: M7 (Tema F) SDK slice — PermissionEngine default-deny + plugin wiring.

  - `PermissionEngine` now takes `{ defaultAction }` (default `"allow"`, backward-compatible) — opt into default-deny with `new PermissionEngine(rules, { defaultAction: "deny" })`. `PermissionAction`/`PermissionRule`/`PermissionEngineOptions` types are now exported.
  - New `createPermissionPlugin(engine, opts?)` wires a `PermissionEngine` into the `definePlugin` `pre_tool_call` veto (the engine was previously exported-but-unwired): `deny` blocks, `ask` defers to `opts.onAsk` (fail-closed block by default), `allow` passes.

## 2.4.0

### Minor Changes

- a21949f: M1-5 — `@theokit/sdk/messages`: pure readers over the `SDKMessage` stream (plan `m1-sdkmessage-readers`).

  Consumers reading the `SDKMessage` stream had to hand-roll a wire-event mapper. The SDK now ships three pure readers on a dedicated sub-path, promoting the proven first-party hand-roll onto the SDK's own types:

  - `assistantText(msg)` — concatenates an assistant message's `text` blocks; `""` for any non-assistant message (or one with no text). `tool_use` blocks are ignored.
  - `extractToolUses(msg)` — returns the assistant message's `ToolUseBlock`s; `[]` for non-assistant. Reads the assistant content blocks, NOT the separate `SDKToolUseMessage` (`type:"tool_call"`) lifecycle event.
  - `costAmountUsd(cost)` — reads `RunResult.cost.amountUsd` preserving `number | undefined` verbatim. An unknown cost stays `undefined` (never coerced to `$0`), distinct from a real `$0` subscription-included route — the cost-honesty contract (ADR D377).

  All three are pure (no I/O, inputs never mutated). Zero new dependencies.

- fb268f9: M1-4 — fire the `stop` file-based hook + honor `feedback` as a bounded re-prompt (plan `m1-stop-hook-reflection`).

  The `HookEvent "stop"` was declared but never dispatched. A local agent now fires `stop` once when it finishes a turn cleanly (not on an errored run or an iteration-ceiling truncation). A `stop` hook returning `{"decision":"feedback","feedback":"…"}` re-prompts the agent with that text and the loop continues — a bounded reflection ladder capped at `MAX_STOP_FEEDBACK_ATTEMPTS` (2), mirroring the existing nudge ceiling, so a hook cannot loop forever. `allow`/no-hook finish normally; `deny` at `stop` finishes (the answer already exists). Reuses the existing `HooksExecutor` — zero new dependencies. Hooks remain file-based (no programmatic callback).

- 5b8c9e7: M2-1 — `@theokit/sdk/compaction`: public compaction / context-management helpers (plan `m2-compaction-public-api`).

  Promotes the SDK's compaction capability to a public sub-path so consumers can manage the context window without reaching into `internal/`:

  - `compactTranscript(messages, { keepRecent = 6, summarize? })` — keep the last `keepRecent` turns verbatim, preserve leading system turns, and either summarize the older window (via an optional `summarize` callback that can wire the SDK's internal LLM summarizer) or drop it. Reuses the internal `selectCompressionWindow` (no second algorithm). Never mutates its input.
  - `buildCheckpoint(label?)` / `filterFromLatestCheckpoint(messages)` / `CHECKPOINT_MARKER` — a string-sentinel checkpoint: mark a point in a transcript and later filter back to the turns after the most recent marker.
  - `isContextOverflowError(err)` — true iff `err` is a `TheokitAgentError` (or subclass) reporting the typed `context_too_long` code (reads both `err.code` and `err.metadata?.code`; no brittle message regex).

  Operates on the SDK's own `CompressibleMessage` type (re-exported). Zero new dependencies.

- 1cf9c16: M2-4 — per-model capability catalog public + OpenRouter slug-suffix fix (plan `m2-model-capabilities`).

  - **New `@theokit/sdk/models` subpath.** `resolveModelCapabilities(modelId): ModelCapabilities` (previously dead `@internal`) is now public — returns a model's capability flags + `maxContextTokens`/`maxOutputTokens` from a static, OFFLINE catalog (pure, sync, no network). Pair `maxContextTokens` with `@theokit/sdk/compaction`'s `shouldCompact`.
  - **Fix:** OpenRouter `:variant` suffixes (`:free`/`:nitro`/`:floor`/`:beta`) were not stripped before the catalog lookup, so `openrouter/openai/gpt-4o:free` fell back to conservative defaults (4096) instead of the real 128k window. The suffix is now stripped (alongside the existing routing-prefix strip); unknown models still get conservative defaults.

  Zero new dependencies.

- b31283c: M2-2 — pre-call token estimate + compaction decision (plan `m2-token-estimate`).

  Two pure, zero-dependency helpers on the `@theokit/sdk/compaction` subpath (siblings of `compactTranscript`/`isContextOverflowError`):

  - `estimateTokens(text)` — a tokenizer-free token estimate via the ~4-chars-per-token heuristic (`ceil(text.length / 4)`): `""` → 0, any non-empty text → ≥ 1. A cheap PRE-CALL gate, not exact tokenization.
  - `shouldCompact({ estimated, contextWindow, buffer })` — decide BEFORE sending whether to compact: `true` when `estimated >= contextWindow - buffer`. Pure; the caller supplies the window (e.g. from `resolveModelCapabilities`), keeping it decoupled from any per-model catalog.

  No tokenizer dependency.

- 29b1c8c: M4-2 — hierarchical project-instruction reader/writer (plan `m4-project-instructions`).

  New `@theokit/sdk/project` subpath:

  - `readProjectInstructions(cwd, options?)` — walk up from `cwd` collecting `<dir>/<filename>` (default `THEO.md`; configurable) up to the filesystem root (or `options.stopDir`). Returns `{ files, content }`: `files` are the found files nearest-first (`{ path, content }[]`, read in full), `content` is a reduction chosen by `options.scope` — `"nearest"` (innermost) or `"merged"` (all joined root-first, nearest text last). NEVER throws — missing/unreadable/non-file paths are skipped.
  - `writeProjectInstructions(cwd, content, options?)` — write `<cwd>/<filename>` atomically (temp + fsync + rename). Fails loud on write errors (unlike the best-effort reader).

  Composes the SDK's hardened `walkUpForFile` discovery + the atomic `replaceFileAtomic` writer (Rule 9). Zero new dependencies.

- f9be17a: M4-1 — first-party skill discovery + `<skills>` block (plan `m4-skills-discovery`).

  New `@theokit/sdk/skills` subpath exposing two pure first-party primitives the SDK runtime already uses internally:

  - `discoverSkills(dir, options?)` — discover `<dir>/<name>/SKILL.md` files under an ARBITRARY directory (not a hardcoded `.theokit/skills` root), parsing strict YAML frontmatter (`name`/`description` required; `category`/`dependencies` optional) and returning `Skill[]` (the skill BODY is never included). A subdirectory whose realpath escapes `dir` via symlink is skipped (symlink-escape guard, reusing `@theokit/sdk/path-safety`). NEVER throws — a missing/unreadable/non-directory path yields `[]`. A `SKILL.md` with malformed frontmatter is excluded and optionally reported via `options.onInvalidSkill`; a directory WITHOUT a `SKILL.md` is silently skipped.
  - `buildSkillsBlock(skills)` — render the prompt-injection-safe `<skills>` system-prompt block (name + description XML-escaped); returns `undefined` for an empty list.

  The internal `SkillsManager` (`.theokit/skills` discovery) and `SkillsPromptProvider` (`<skills>` injection) now delegate to these primitives — single source of truth, behavior preserved (golden + contract tests unchanged). Zero new dependencies.

- f2265d7: M4-6 — sub-agent tool scoping via `AgentDefinition.tools` (plan `m4-tool-scoping`).

  - `AgentDefinition` gains an optional `tools?: string[]` — a tool-name whitelist. When set, the sub-agent may ONLY call tools whose canonical (post-repair, lowercase) name is in the list; any other call is vetoed at dispatch. Absent/empty → unscoped (inherits the parent's full toolset). Backward-compatible.
  - `.theokit/agents/*.md` subagents can declare it as a comma/space-separated frontmatter field (`tools: read_file, list_dir`).
  - New `@theokit/sdk/subagents` subpath: `subagentToolWhitelist(definition): Set<string> | undefined` + `withSubagentToolScope(definition, fn)` enforce the whitelist via the SDK's existing `withToolWhitelist` dispatch veto — the same enforcement `Agent.fork`'s `allowedTools` uses, NOT `PermissionEngine`. A `tools: ["read_file"]` sub-agent provably cannot call `write_file`/`shell_exec`.

  Zero new dependencies.

- f1de451: M5-8 — public `parseModelId` + `humanizeModelName` + `toModelOption` on `@theokit/sdk/models` (plan `m5-model-option`).

  - `parseModelId(modelId): { provider, name }` is now public (promoted from `@internal`) — splits the provider prefix from the model name, OpenRouter-routing + tag-suffix aware.
  - `humanizeModelName(modelId): string` — a best-effort, deterministic human label: strips the routing/vendor prefix, title-cases the core model segment (known acronyms upper-cased), and appends an OpenRouter `:variant` in parens (`"openrouter/openai/gpt-4o:free"` → `"GPT 4o (free)"`). Not vendor-canonical marketing names.
  - `toModelOption(modelId): { value, label, provider }` — a dropdown-ready entry composing the two.

  Lets `@theokit/ui` model selectors + the `create-theokit` template stop hand-rolling slug→label. Zero new dependencies.

### Patch Changes

- 1abda16: M2-3 — `context_too_long` reaches the run boundary (plan `m2-context-overflow-boundary`).

  Fixes a code-at-boundary bug: the loop captured the error code from the error's top-level `.code`, which the provider mappers set to a PROVIDER-PREFIXED string (`anthropic_context_too_long` / `${providerId}_context_too_long`), while the CANONICAL `ErrorCode` (`context_too_long`) lives on `metadata.code`. So `RunResult.error.code` surfaced the prefixed form and a consumer checking `result.error.code === "context_too_long"` missed it.

  `registerLoopError` now prefers `cause.metadata?.code` over the top-level `.code`, so the canonical code reaches the boundary for every provider (verified by a 400-context-overflow contract test through the real `mapAnthropicError`/`mapOpenAICompatibleError`). The prefixed form remains on the thrown `TheokitAgentError.code` for telemetry. Set-once invariant preserved; top-level `.code` fallback unchanged when there is no `metadata.code`.

## 2.3.0

### Minor Changes

- d7d5215: M1-3 — `buildReplayHistory(base, events, options)` pure stateless continuation-history rebuild (plan `m1-continuation-history`).

  The stateless complement to M1 Phase 3's `runToCompletion` (which covers the stateful-session path). For a server / serverless handler that re-runs an agent on a fresh request and must reconstruct working memory from persisted stream events, `buildReplayHistory` serializes a round's `SDKMessage[]` into a bounded `StoredMessage[]` you can replay as prior history:

  - maps assistant text → `assistant`; tool `running` → `tool_call` (args); tool `completed`/`error` → `tool_result` (carrying the result content the continued model needs);
  - drops the oldest turns — pair-safe (a `tool_call` and its `tool_result` are never split) — until the total fits a context-window-derived char budget, keeping ≥ 1;
  - truncates an oversized single turn (reusing the SDK's `truncateWithMarker`) rather than dropping it;
  - pure, synchronous, dependency-free; a non-finite `contextWindowTokens` collapses to budget 0 (never returns an unbounded history).

  Exported from `@theokit/sdk` with `ReplayHistoryOptions`. Replaces the outer-loop history rebuild a code-assistant server otherwise hand-rolls.

- f218630: M1 Phase 3 — `agent.runToCompletion()` continuation driver (plan `m1-run-to-completion`).

  Builds on M1-2's `RunResult.stoppedAtIterationLimit` signal: a single `agent.send()` truncates when the model still wants tools at the loop's iteration ceiling. `runToCompletion(message, options?)` re-sends a short continuation prompt — the agent's stateful session preserves the conversation — until a genuine terminal:

  - `done` — a round finished without truncating.
  - `step_limit` — `maxRounds` (default 5) exhausted, or aborted via `signal`, while still truncating.
  - `no_progress` — two consecutive rounds produced empty output.

  Returns `{ terminal, rounds, lastResult, usage }` with token usage summed across rounds. Options: `maxRounds`, `continuationPrompt`, `onTruncated`, `signal`, `sendOptions`. Local agents only — cloud agents throw `UnsupportedRunOperationError` (the cloud runtime manages continuation server-side). This replaces the outer continuation loop a code-assistant builder would otherwise hand-roll.

## 2.2.0

### Minor Changes

- efe183e: M1 Reliable harness — make the agent loop's iteration ceiling real (plan `m1-reliable-harness`).

  - **M1-1:** the agent loop now calls `BudgetTracker.nextIteration?.()` once per completed turn, and `nextIteration?()` is an optional member of the `BudgetTracker` interface. `createCounterBudgetTracker({ maxIterations: N })` now actually halts the loop after N turns (it was dead — nothing called it). Additive and backward-compatible: trackers that only gate on tokens/USD omit the method.
  - **M1-2 (knob):** `SendOptions.maxIterations` lets a builder raise/lower the loop's default 8-turn cap per `agent.send` call. Validated at the boundary (positive integer; invalid throws `ConfigurationError`). Default of 8 preserved when unset.
  - **M1-2 (truncation signal):** `RunResult.stoppedAtIterationLimit` is `true` when the loop stopped at its iteration ceiling with tool work still pending (silent truncation) vs a clean `done` finish. Lets a caller/continuation driver detect and recover.

## 2.1.0

### Minor Changes

- 7d53632: Custom LLM providers via the public Plugin protocol (plan `dev-friendly-custom-provider`).

  - **Added** `defineProvider(profile, opts?)` — canonical factory (mirrors `defineTool`/`definePlugin`, Inviolable Rule 9) that wraps a data-only `ProviderProfile` into a `kind: "model-provider"` `Plugin`. Register any OpenAI-/Anthropic-compatible endpoint (Groq, Together, Fireworks, DeepInfra, a private gateway) with `Agent.create({ model: { id: "myprov/model" }, plugins: [defineProvider(profile)] })`, routed via the `provider/model` id prefix. Exported from `@theokit/sdk`.
  - **Fixed** half-wired `kind: "model-provider"` plugin path: `PluginManager` aggregated provider profiles but nothing registered them, so `getProviderProfile`/`resolveProviderChain` never saw a plugin-contributed provider — a programmatic `model-provider` plugin was silently dropped. The local-agent run now registers plugin-contributed profiles before provider-chain resolution, so custom providers actually route.
  - **Docs** new "Custom providers (`defineProvider`)" section in `docs.md` (field reference + `apiMode` table) and a worked `examples/custom-provider/`.

- 872c89e: M0 Foundation — expose already-existing internal primitives as public surfaces (plan `m0-foundation-expose-primitives`), so agent/code-assistant builders reuse battle-tested plumbing instead of re-implementing it.

  - `isTransientError(err)` — public retryability predicate delegating to `TheokitAgentError.isRetryable` (T1.1).
  - `safeFilenameForId(id, { maxLen })` — total id→filename helper via `@theokit/sdk/path-safety` (passthrough when safe, deterministic sha256 token otherwise); `sanitizeRunId` migrated to it (T2.1).
  - `@theokit/sdk/concurrency` — public `createSemaphore` + new ordered, fail-fast `mapWithConcurrency`; two internal pooling clones deduplicated onto it (T3.1).
  - `@theokit/sdk/retry` — generic `withRetry(fn, options)` (exponential backoff + full jitter, injectable sleep/rng, default `isRetryable = isTransientError`) (T4.1).
  - `openSqliteResilient` (`@theokit/sdk/internal/persistence`, semver-exempt) — shared driver-load + WAL + corruption-recovery; both memory `index-db` copies deduplicated onto it (T5.1).

## 2.0.1

### Patch Changes

- aac62bc: Internal architecture cleanup (arch-review Groups A–D) — no public API or behavior change.

  - **Group A:** widen the internal `agent-factory-registry` inversion seam from `create()` to a full `AgentFacadePort` (`create`/`prompt`/`get`/`resume`/`batch`); route `internal/{eval,scorers,cron}` through `getAgentFacade()` instead of importing the public `Agent` facade upward. A `internal-must-not-import-facade` dependency-cruiser rule now enforces the boundary. `cron.ts`/`eval.ts` gained an `import "./agent.js"` bootstrap (kept out of tree-shaking via the `sideEffects` allowlist) so the `@theokit/sdk/cron` and `@theokit/sdk/eval` sub-path entries still register the facade at load time.
  - **Group B:** relocated the 17 loose `internal/runtime/*.ts` modules into cohesive sub-folders (`lifecycle/`, `validation/`, `concurrency/`, `tools/`, `config/`, plus folding `system-prompt.ts`/`yaml-frontmatter.ts` into existing dirs); removed the dead `internal/runtime/mcp-tools.ts`.
  - **Group C:** removed the cargo-cult `TheoKitContainer` (was `@public` but never exported; `run()` discarded registered tools/workflows); the `multi-agent` template now uses `Agent.create()`.
  - **Group D:** renamed `internal/errors/` → `internal/error-mappers/` (the directory holds only provider error-mappers, no error classes).

  All changes are internal-only and behavior-preserving (full suite GREEN, `madge --circular` unchanged, depcruise clean). Consumers see no API or behavior difference.

## 2.0.0

### Major Changes

- b9f30a6: Carve the non-Harness surface out of `@theokit/sdk` (plan `monorepo-cohesion-split`). The SDK now ships only the Agent-AI Harness.

  BREAKING (no retro-compat, authorized):

  - Removed the `@theokit/sdk/rag` sub-path export and the embedded `voice` module — they moved to standalone `@theokit/rag` / `@theokit/voice` packages (repos `theokit-rag` / `theokit-voice`). Import those packages instead.
  - Decorator-first DX is no longer required of Harness features (ADR D431). `@theokit/di` / `@theokit/di-agent` / `@theokit/orm` moved to `theokit-backend-dx`, the gateway packages to `theokit-gateways`, `@theokit/react` to `theokit-react`, and `@theokit/skills-google-workspace` to the Skills pillar. Decorators remain available as an optional layer via the externally-published `@theokit/di`.

  The surviving `@theokit/sdk-*` extension peer specifiers stay as semver ranges (`>=1.7.0`), satisfying the publish-readiness gate.

## 1.9.0

### Minor Changes

- 461c020: `createSquad` sequential agent-team convenience + `Agent.batch` boundary validation — first real npm publish.

  - **`createSquad(options)`** — composes `Workflow.create()` + `agentStep` into a sequential agent team (own identity, built on the SDK's own primitives). Throws `ConfigurationError` (`invalid_squad` for empty agents, `squad_process_unsupported` for hierarchical). Cross-validation Gap 1.
  - **`Agent.batch`** now fail-fast validates `concurrency` + prompt items at the public boundary (`ConfigurationError` with `invalid_concurrency` / `invalid_batch_item`) before any side effect. Cross-validation Gap 3.

  Note: these features were tagged as `v1.8.0` but that version's npm publish failed (CI build cycle, fixed in `turbo.json`); `1.8.0` / `1.8.1` on npm predate them. They are published to npm for the first time in `1.9.0`. The `[1.8.0]` CHANGELOG section is retained as the GitHub-released record and is not rewritten.

## [Unreleased — pre-changeset legacy, superseded by the 3.x sections above]

### Fixed

- **`context_too_long` reaches the run boundary (M2-3).** `registerLoopError` now prefers the canonical `cause.metadata?.code` over the provider-prefixed top-level `.code`, so `RunResult.error.code` is `context_too_long` (not `anthropic_context_too_long`) for every provider. Set-once + top-level fallback preserved.

### Added

- **Pre-call token estimate + compaction decision (M2-2).** `estimateTokens(text)` (tokenizer-free ~4-chars/token; `""`→0, non-empty→≥1) + `shouldCompact({estimated,contextWindow,buffer})` (`true` when `estimated >= contextWindow - buffer`; pure, caller supplies the window) on the `@theokit/sdk/compaction` subpath. No tokenizer dep.
- **Per-model capability catalog public + OpenRouter slug-suffix fix (M2-4).** New `@theokit/sdk/models` subpath: `resolveModelCapabilities(modelId)` (was `@internal`) — pure/sync/offline capability flags + `maxContextTokens`/`maxOutputTokens`. Fixes an OpenRouter `:variant` suffix lookup miss (fell back to 4096 instead of the real window).

### Added

- `@theokit/sdk/compaction` — public compaction / context-management helpers so you manage the context window without reaching into `internal/`. `compactTranscript(messages, { keepRecent = 6, summarize? })` keeps the last `keepRecent` turns, preserves leading system turns, and either summarizes the older window (via an optional callback wiring the internal LLM summarizer) or drops it — reusing the internal compaction window (no second algorithm), never mutating its input. `buildCheckpoint`/`filterFromLatestCheckpoint`/`CHECKPOINT_MARKER` give a string-sentinel checkpoint to bound replay to "since the last checkpoint". `isContextOverflowError(err)` is true for a `TheokitAgentError` reporting the typed `context_too_long` code (checks `code` + `metadata.code`; no message regex). Operates on the SDK's own `CompressibleMessage` (re-exported); zero new dependencies. (M2-1)
- `@theokit/sdk/messages` — pure readers over the `SDKMessage` stream so you stop hand-rolling a wire-event mapper. `assistantText(msg)` concatenates an assistant message's text (`""` for non-assistant), `extractToolUses(msg)` returns its tool-use blocks (`[]` for non-assistant; reads the assistant content blocks, not the separate `tool_call` lifecycle event), and `costAmountUsd(cost)` reads `RunResult.cost.amountUsd` preserving `number | undefined` verbatim — an unknown cost stays `undefined`, never silently coerced to `$0` (cost-honesty, ADR D377). Zero new dependencies. (#34)
- `createSquad({ agents })` — a thin convenience for sequential agent teams. Runs agents in order, threading each output into the next agent's prompt; returns `{ result, status, steps }`. Composes `Workflow` + `agentStep` internally (no new orchestration engine). `process: "hierarchical"` throws a guiding `ConfigurationError` (use subagents / `@theokit/sdk-handoff`); empty `agents` → `ConfigurationError(code: "invalid_squad")`.

### Fixed

- The Agent-facade bootstrap added in Group A (`import "./agent.js"` in `cron.ts`/`eval.ts`) was tree-shaken out of the built `cron.js`/`eval.js` bundles under `package.json "sideEffects": false` + tsup `treeshake: true`. SDK-source tests passed but real **dist** consumers (e.g. `@theokit/cli` via `@theokit/sdk/eval`) hit `internal: Agent facade not registered` at runtime. Declared `agent.{ts,js,cjs}` in the `sideEffects` allowlist so the bootstrap survives bundling while the rest of the package stays tree-shakeable. Bundle size unchanged from the pre-Group-A baseline. (arch-review Group A follow-up; caught by `pnpm validate`)
- `Agent.batch` now validates its inputs at the boundary (fail-fast). Invalid `concurrency` (not a positive integer) throws `ConfigurationError(code: "invalid_concurrency")` with a user-facing message, and an empty/non-string prompt item throws `ConfigurationError(code: "invalid_batch_item")` — both BEFORE any credential pool is built or Task is registered. Previously invalid `concurrency` surfaced only deep inside the semaphore with a leaky "permits" message AND after task registration (a dangling Task could be registered with `task: true`), and empty-string prompts flowed silently to `agent.send`. New `validateBatchInput` pre-flight; whitespace-only prompts are intentionally still accepted (non-empty strings; the validator does not judge content). (arch-review cross-validation Gap 3)

### Changed

- Renamed `src/internal/errors/` → `src/internal/error-mappers/`, collapsing the redundant `mappers/` nesting (arch-review Group D). The directory held only provider error-mapper implementations (anthropic, bedrock, ollama, openai-compatible, vertex, shared) and zero error classes — those live in `src/errors.ts` — so `errors/` was a misnomer. Pure rename + import-path fixups across importers, tests (moved to `tests/internal/error-mappers/`), and `docs/error-codes.md`; no API/behavior change.
- Removed the cargo-cult `TheoKitContainer` (`src/theokit-container.ts`, arch-review Group C). It was `@public`-annotated but never exported from `index.ts` — no consumer could import it, so removal has zero real breaking impact — and its `run()` rebuilt a fresh `Agent.create` from only `model`/`apiKey`/`systemPrompt`, silently discarding the registered `tools`/`workflows` (dead, misleading surface that contradicts ADR D431's "factory functions are canonical; no in-SDK IoC container"). The `multi-agent` template + README now coordinate specialists via `Agent.create()`. The container's e2e error-propagation test was re-expressed as genuine coverage of the REAL `AgentDisposedError` thrown by `local-agent-send.ts` (the container had faked it with a string) — a net coverage gain. Deleted `tests/theokit-container.test.ts` + `tests/e2e/container-multi-agent.e2e.test.ts` (pure container bookkeeping, no Agent-level coverage).
- Completed the `internal/runtime/` root cleanup (arch-review Group B). The flat root previously held 18 loose modules (down from 62 after M4); relocated the remaining 17 into cohesive sub-folders — `lifecycle/` (run-until, fork-agent, post-run-lifecycle, spawn-collect, auto-summarize), `validation/` (validate-agent-options, validate-response), `concurrency/` (async-local-storage, async-semaphore, abort-utils), `tools/` (shell-tool, hitl-middleware), `config/` (default-model, workspace-dir, providers-manager) — plus folding `system-prompt.ts` into the existing `system-prompt/` dir and `yaml-frontmatter.ts` into `context/`. `internal/runtime/` root now holds zero loose `.ts`. Removed the dead `internal/runtime/mcp-tools.ts` (`buildToolList` had zero callers; survived prior gates because orphan detection excludes `internal/`). Pure `git mv` + import-path fixups (39 importer files), one dead-code deletion; no API/behavior change. Full suite GREEN (2616 pass); `madge --circular` unchanged (1 type-only cycle); depcruise clean.
- Closed the last 3 wrong-direction imports where `internal/{eval,scorers,cron}` imported the public `Agent` facade directly (arch-review Group A). The `agent-factory-registry` inversion seam was widened from a single `create()` to a full `AgentFacadePort` (`create`/`prompt`/`get`/`resume`/`batch`); `eval/runner` (batch), `scorers/llm-judge` (prompt), and `cron/run-job` (get/resume/create) now resolve the facade via `getAgentFacade()` instead of inverting the public-api → internal dependency direction. A new `internal-must-not-import-facade` dependency-cruiser rule permanently enforces the boundary. The `cron.ts`/`eval.ts` facades gained an explicit `import "./agent.js"` bootstrap so the `@theokit/sdk/cron` and `@theokit/sdk/eval` sub-path entries still register the facade at load time (preserving the side effect the removed direct imports used to provide). Fully internal — no API/behavior change; full suite GREEN, `madge --circular` unchanged (1 intentional type-only cycle), depcruise clean.
- Reorganized the flat 62-file `src/internal/runtime/` god folder into sub-concern folders (arch-review M4): `local-agent/` (15), `cloud/` (6), `compression/` (6), `hooks/` (4), `budget/` (3), `memory/` (4), `session/` (3), `skills/` (3) — alongside the pre-existing `registry/`, `system-prompt/`, `context/`, `fixtures/`, `plugins/`. 18 cross-cutting singletons (abort-utils, async-_, default-model, fork-agent, run-until, system-prompt, validate-_, etc.) remain at the `runtime/` root (down from 62). Pure file moves + import-path updates (44 files moved, ~100 import sites rewritten incl. 2 lint-allowlist path updates); `internal/runtime` is not an exported subpath and has no tsup entry, so the change is fully internal — no API/behavior change. Full SDK suite GREEN (2629 tests); `madge --circular` unchanged (1 intentional type-only `memory/memory-provider` cycle).
- Broke 2 of 3 type-only dependency cycles in the public type barrel (arch-review ADR 0001). `ForkOptions`/`ForkResult` moved to a leaf `types/fork.ts`, so `types/agent.ts` no longer imports the `internal/runtime/fork-agent.ts` implementation (`fork-agent.ts` re-exports them for back-compat). Eliminates the `types/agent.ts → fork-agent.ts → {plugins/types,(self)}` cycles. No behavior/API change; `madge --circular` drops from 3 to 1 (the remaining `memory-provider` cycle is a genuine bidirectional type relationship, runtime-safe, left intentionally).

### Fixed

- Budget pre-flight gate now **fails closed**: if a custom `budgetTracker.check()` throws (a contract violation — `check()` must return a decision), the agent loop denies the next iteration instead of silently proceeding past budget. Previously a throwing tracker defaulted to `allowed: true` (fail-open), letting a broken cost guard run unbounded. Extracted to a unit-tested `evaluateBudgetGate` helper. (arch-review L1)

## [1.8.1] - 2026-06-12

### Changed

- `theokit-init-claude` now merges into existing `.claude/` directories instead of refusing. Adds only missing files, preserves user customizations. Use `--force` to overwrite all files.

## [1.8.0] - 2026-06-12

### Added

- `.claude/` consumer template with 15 domain-specific passive skills, convention rules, AGENTS.md (cross-agent), and CLAUDE.md for AI coding tool integration. Scaffold via `npx theokit-init-claude`. Skills auto-inject TheoKit API knowledge when editing files matching each domain (Agent Core, Tools, Memory, DI, DI-Agent, Gateways, RAG, Workflows, Eval, Cron, Subscriptions, Errors, Config, Streaming, Budget). 33 tests.

## [1.7.0] - 2026-06-11

### Changed

- Resolve 12 jscpd code duplication clones: extract shared server adapter handler, consolidate evented-executor step logic, share NOOP_SPAN/collapseSystemText/sleepWithAbort, deduplicate memory peer routing helpers. 0 clones remaining.
- Extract helper modules from 5 god-files for SRP compliance: `agent.ts` → `agent-helpers.ts`, `loop.ts` → `loop-context-init.ts` + `loop-llm-stream.ts`, `tool-dispatch.ts` → `tool-executors.ts`, `index-manager.ts` → `index-manager-helpers.ts`, `local-agent.ts` → `local-agent-send.ts`. Total ~1300 lines redistributed; zero behavior change, all 2591 tests GREEN.

### Added

- **Compression config resolution module (T2.2 step 2/N of plan `sdk-superiority-2026-06-07`, ADR D440)**: `resolveCompressionConfig(agentModel, config): ResolvedCompressionConfig` bridges the compression-model-registry (step 1) with the `Agent.create({compression})` override surface. Resolves: (a) compression model — registry default OR explicit `config.model` override; (b) API key — first-match chain: explicit `config.apiKey` → `THEOKIT_COMPRESSION_API_KEY` env var → undefined (signals aux-LLM client to use agent's main CredentialPool); (c) maxAttempts (default 3) + grace (default 1). Pure config resolution — no I/O. 11 new tests at `tests/internal/runtime/compression-config.test.ts`. Foundation for step 3 (aux-llm-client with OTel span) and step 4 (agent-loop wire).

- **Model capabilities introspection registry (T3.10c step 1 of plan `sdk-superiority-2026-06-07`, DR3 #17)**: pre-T3.10c the SDK had no way to query a model's capability flags before sending a request — consumers who sent vision content to a text-only model or structured-output requests to a model without json*schema support got an opaque 400 from the provider. T3.10c step 1 adds the foundation pure-function registry `resolveModelCapabilities(modelId): ModelCapabilities` with typed per-model flags: `supportsVision`, `supportsStructuredOutput`, `supportsToolUse`, `supportsCacheControl`, `maxContextTokens`, `maxOutputTokens`. Resolution algorithm: strip routing prefixes (openrouter/, vertex/, bedrock/), exact-match against the vendor-model registry, then infer vendor from model name (claude-* → anthropic/, gpt-\_ → openai/, gemini-\* → google/) for routing-prefixed lookups. Unknown models return conservative defaults (all false, 4096/4096 token counts) — never optimistic assumptions. Initial registry covers OpenAI (gpt-4o/4o-mini/4-turbo/o1/o3) and Anthropic (claude-opus-4/sonnet-4/3-5-sonnet/3-haiku/3-opus) families. 9 new tests at `tests/internal/llm/model-capabilities.test.ts`. Foundation for step 2 (public `Theokit.models.capabilities()` API) and step 3 (Agent.create boundary gate + `CapabilityNotSupportedError`).

### Fixed

- Fix `EventedWorkflowExecutor` referencing `handler` instead of `fn` from `FnStep` interface; provide full `StepContext` (runId + log + suspend)
- Fix missing `await` in `TheoKitContainer.run()` causing `.send()` to be called on a Promise
- Fix `CohereReranker` null guard for out-of-bounds `chunks[r.index]` array access
- Fix `Theokit.models.capabilities()` null guard on `split("/")[0]` return value
- Fix dynamic catalog overwriting first-party builtin providers (ollama/lmstudio/llamacpp) — builtins now take priority

### Security

- **Move-corrupt-aside + 1MB cap on markdown config files (T5.10 of plan `sdk-superiority-2026-06-07`, DR6 finding #10)**: pre-T5.10 `readVersionedJson` left corrupt JSON files in place after logging a warning — on next run the same warning fired again (no healing). T5.10 renames the corrupt file to `<path>.corrupt.<epoch>` so the user can investigate later while the original path is freed for a fresh default. Additionally, `loadMarkdownEntities` now rejects individual config files > 1MB before reading them into memory (pre-T5.10 no size cap existed — "`.theokit/` is trusted source" comment at line 63). A crafted multi-MB config file was a local DoS vector on resource-constrained environments (edge, CI workers). 4 new tests at `tests/internal/persistence/corrupt-aside-and-size-cap.test.ts`. 142/142 persistence tests GREEN across 17 files. Closes DR6 finding #10.

- **proper-lockfile supply-chain hardening (T5.9 of plan `sdk-superiority-2026-06-07`, DR6 finding #9)**: pre-T5.9 `getProperLockfile()` did a bare `import("proper-lockfile")` with a catch-all that swallowed every error — including import of a tampered or incompatible version. If an attacker replaced the module on disk (npm supply-chain attack), or if a transitive dep pulled a breaking major, the SDK would silently use whatever it got. T5.9 adds structural validation after the dynamic import succeeds: `typeof lib.lock === "function" && typeof lib.unlock === "function"`. If the imported module doesn't expose the API surface we depend on, it's treated as "not installed" (fallback to in-process `withCwdMutex`) + a one-shot supply-chain advisory warning is emitted via stderr pointing to `pnpm add proper-lockfile@^11`. Never throws — supply-chain validation is advisory + graceful fallback, not blocking. New `__TESTING__validateLockModule` + `__TESTING__resetFileLockCache` test seams exposed for unit tests; NOT in the public barrel. 7 new tests at `tests/internal/persistence/file-lock-supply-chain.test.ts`. 138/138 persistence tests GREEN across 16 files (no regressions). Closes DR6 finding #9.

### Added (SDK 2.0 — Stage 4 optional-peer routing — iter 76-80, 2026-06-09)

- **Optional-peer routing through `@theokit/sdk-memory`** (ADR 0002): the public `Memory` class (`Memory.openIndex`, `Memory.runDreamingSweep`) and the `migrateSqliteToLance` wrapper now delegate to the `@theokit/sdk-memory` package when installed. When sdk-memory is absent, methods fall back to sdk-core's legacy `internal/memory/*` implementations — v1.x behavior preserved. No source-level API change for consumers; the routing is opaque. Foundation files: `src/internal/memory/sdk-memory-peer-loader.ts` (canonical loader with `SdkMemoryModule` structural mirror + memoized dynamic import + test escape hatches `resetSdkMemoryPeerCacheForTests` / `forceSdkMemoryPeerAbsentForTests`). Test coverage: 24 tests across 5 files in `tests/` — loader contract pin, Memory class routing for both methods, migrate wrapper routing, behavior parity gate (sdk-core ↔ sdk-memory produce byte-equivalent results for shape + error messages), legacy fallback branch coverage via force-absent flag. See `docs/adr/0002-sdk-memory-optional-peer-routing.md` for full architectural rationale + sunset condition.

### Added

- **Provider-agnostic compression-model registry (T2.2 step 1/N of plan `sdk-superiority-2026-06-07`, ADR D440)**: pre-T2.2 the `D91/D92 compression` path (`compression-helpers.ts`) was dead code — no auxiliary-LLM contract was specified. T2.2 step 1 ships the foundation: a pure-function registry that resolves the agent's main model to a cheaper-tier summarization model in the SAME vendor family. Algorithm: (a) exact match (e.g., `openai/gpt-4o` → `openai/gpt-4o-mini`; `anthropic/claude-sonnet-4` → `anthropic/claude-3-5-haiku-latest`); (b) wildcard match for region-prefixed Bedrock variants (`bedrock/anthropic.claude-sonnet*` → `bedrock/anthropic.claude-3-haiku*`); (c) `authType: "none"` providers (Ollama / LM Studio / llama.cpp) return SAME model id (local — cost N/A); (d) no match throws the new typed `CompressionModelUnresolvedError` at `Agent.create` TIME (not runtime) with the actionable message naming the model and pointing to the override surface + registry-PR remediation. Crucial design: zero cross-provider calls — a consumer running Anthropic-only never gets a silent OpenAI fallback for compression. Initial registry covers OpenAI family (gpt-4o / gpt-4-turbo / o1 / o3), Anthropic family (claude-opus-4 / sonnet-4 / 3-5-sonnet / 3-opus / 3-sonnet), Vertex (Gemini + Anthropic-on-Vertex), OpenRouter (OpenAI + Anthropic), and Bedrock Anthropic (wildcard). 18 new tests at `tests/internal/runtime/compression-model-registry.test.ts`. Foundation for steps 2-4 (compression-config integration, OTel-instrumented aux-llm-client, agent-loop wire on `ContextWindowExceededError`).

### Security

- **NFS / SMB / CIFS / FUSE detection + warn-once on atomic write (T5.8 of plan `sdk-superiority-2026-06-07`, DR6 finding #8)**: pre-T5.8 `replaceFileAtomic` happily called `rename(tmp, filePath)` on any filesystem. POSIX `rename` is atomic on local filesystems (ext4 / btrfs / APFS / NTFS), but on network filesystems (NFS / SMB / CIFS) and many FUSE implementations atomicity is best-effort: NFS clients can return stale cached reads for seconds after a successful server-side rename; SMB / CIFS cross-directory rename is non-atomic on some Samba configurations; FUSE behavior is entirely implementation-dependent (sshfs / s3fs / rclone-mount have known non-atomic rename). T5.8 does NOT change the write path — `replaceFileAtomic` remains a best-effort atomic write — but adds a warn-once-per-(directory, label) telemetry surface so operators see `[theokit-sdk] atomic-write: detected network fs (nfs) at /mnt/share — rename() atomicity guarantees may be weaker than expected` once and know to plan accordingly. Pattern mirrors `sqlite-wal.ts:54-61`'s warn-once-per-label (D63). Detection: Linux `statfs().type` magic numbers (NFS 0x6969, SMB 0x517B, CIFS 0xFF534D42, FUSE 0x65735546); silent fallback on Windows / Node < 18.15 / statfs EACCES. New `detectNetworkFsName(typeMagic): string | null` pure function (test seam `__TESTING__detectNetworkFsName`) + `warnOnNetworkFsOnce(dirPath, label)` wired into `replaceFileAtomic`. 9 new tests at `tests/internal/persistence/atomic-write-nfs-detection.test.ts` covering all 4 network FS magic numbers + 3 local-FS negatives + reset helper idempotence. 29/29 atomic-write + credential-pool persistence tests GREEN. Closes DR6 finding #8.

- **Crypto-random tmp file names + mode 0o600 + dir 0o700 (T5.7 of plan `sdk-superiority-2026-06-07`, DR6 finding #7)**: pre-T5.7 `replaceFileAtomic` had two attacks open. (a) **Predictable tmp path**: the suffix used `Math.random().toString(36).slice(2, 10)` — Math.random is NOT a CSPRNG, an attacker observing the process could predict the next tmp path and pre-stage a hostile file there to be renamed into place. (b) **World-readable tmp file**: `open(tmp, "w")` fell back to the process umask — typically 0o644 on POSIX (world-readable). The tmp file holds the FULL in-flight content (credential pool snapshot, OAuth tokens, etc.) before the rename — any process could read it during the ms-window between open and rename (TOCTOU disclosure). T5.7 fixes both: (a) suffix now uses `randomBytes(8).toString("hex")` from `node:crypto` — 16 hex chars / 64 bits of CSPRNG entropy; (b) `open(tmp, "w", 0o600)` passes the secure mode argument so both the tmp file AND (via rename inheritance on modern Linux) the final target are owner-only. Also tightens `saveCredentialPoolStore` parent directory creation from default umask (0o755 = world-listable) to `mode: 0o700` so an attacker enumerating the parent cannot even see the pool exists. 3 new tests at `tests/internal/persistence/atomic-write-tmp-secure.test.ts` (mode 0o600 verified via stat, content roundtrip, concurrent-write no collision). 46/47 persistence tests GREEN — the 1 pre-existing failure (`integration-stack.test.ts:75`) is unrelated NODE_MODULE_VERSION mismatch on `better-sqlite3` native binding from the preflight workaround documented in `CLAUDE.md`. Closes DR6 finding #7.

- **`__Host-` cookie prefix + deterministic clear (T5.3 of plan `sdk-superiority-2026-06-07`, DR6 finding #3, BREAKING)**: pre-T5.3 the OAuth tx-cookie was named `theo_oauth_tx` — browsers accepted it without enforcing any cookie-prefix contract, leaving the subdomain-fixation vector open (a malicious page on `evil.example.com` could plant a same-name cookie that the parent app at `example.com` would happily decrypt). T5.3 renames the cookie to `__Host-theo_oauth_tx` per RFC 6265bis — browsers now enforce the contract that the cookie MUST be set with `Secure`, MUST NOT carry a `Domain` attribute, and MUST have `Path=/`. Pre-T5.3 `clearCookie` also did a buggy double-write: first an empty-value `setCookie` (which still carried `Max-Age=600` from the live cookie) AND THEN a separate explicit `Max-Age=0` header — creating a duplicate Set-Cookie response some legacy clients did not handle deterministically. T5.3 collapses this to a single clean clear with both `Max-Age=0` (modern browsers) AND `Expires=Thu, 01 Jan 1970 00:00:00 GMT` (legacy fallback), while preserving all `__Host-` prefix attributes (HttpOnly + Secure + SameSite=Lax + Path=/). **Breaking only at the wire — no public API change**: consumers calling `defineAuth().startSignIn()` / `finishSignIn()` see no source-level change because the cookie name is internal; only the HTTP wire format moves from `theo_oauth_tx=...` to `__Host-theo_oauth_tx=...`. In-flight cookies from pre-T5.3 sessions will fail decryption on the next callback and the flow restarts cleanly. 6 new tests at `tests/server-auth-host-cookie-prefix.test.ts` + 1 fixture update at `tests/server-auth.test.ts` (cookie header line widened to the prefixed name). 29/29 server-auth tests GREEN.

- **Forbidden-path blocklist expansion + case-insensitive matching (T5.6 of plan `sdk-superiority-2026-06-07`, DR6 finding #6)**: pre-T5.6 `isForbiddenPath` blocked only `.env*`, `.git/`, `node_modules/`, `.theo/`, and 4 lockfile basenames — and it compared case-sensitively. A coding agent recursing through a developer laptop could happily read `.ssh/id_rsa`, `.aws/credentials`, `.docker/config.json`, `.kube/config`, `.npmrc`, `.netrc`, `.pgpass`, `authorized_keys`, `known_hosts`, OR any `*.pem` / `*.key` file. On macOS/Windows case-insensitive filesystems, `.ENV` and `.SSH/` slipped through entirely because the path string was compared verbatim against lowercase constants. T5.6 (a) lowercases the normalized path BEFORE matching, defeating case-only bypass; (b) adds 3 new pattern sets: `SENSITIVE_FIRST_SEGMENTS` (.ssh / .aws / .docker / .kube / .npmrc / .netrc / .pgpass at top level), `SENSITIVE_BASENAMES` (id_rsa / id_ed25519 / id_ecdsa / id_dsa / authorized_keys / known_hosts / .npmrc / .netrc / .pgpass at any depth), and `SENSITIVE_SUFFIXES` (.pem / .key / .p12 / .pfx at any depth). Implementation matches the `.env.example` allowlist contract — `isForbiddenPath` returns false for safe templates. 28 new tests at `tests/internal/security/path-guard-forbidden-expansion.test.ts`; 102/102 path-guard sink tests GREEN across 6 files. Closes DR6 finding #6.

- **NUL byte + C0/DEL control-char rejection across path-guard primitives (T5.5 of plan `sdk-superiority-2026-06-07`, DR6 finding #5)**: pre-T5.5 `safePathJoin`, `assertNoSymlinkEscape`, and `sanitizeIdentifier` did NOT explicitly reject NUL (`\x00`) or C0/DEL control characters (`\x01-\x1F`, `\x7F`) in path-shaped or identifier-shaped inputs. NUL bytes in path strings have a long history of security bugs: legacy N-API callers historically truncated paths silently at the NUL boundary, letting `foo.txt\x00.env` be opened as `foo.txt` while the upstream caller saw the full string and approved it. C0 control chars are universally invalid in POSIX paths and identifiers. `validateArtifactPath` (T1.4 — line 269) already rejected NUL, so T5.5 propagates the same defense to the sibling primitives so a caller can never bypass NUL/control checks by choosing a different entrypoint. New internal helper `rejectNulAndControlChars(input, role)` centralizes the check; wired into `safePathJoin` (for `base` + each `part`), `assertNoSymlinkEscape` (for `path` + `base`), and `sanitizeIdentifier`. The latter previously threw a generic "invalid characters" message via the alphanumeric-only `IDENTIFIER_PATTERN`; T5.5 routes NUL through the same helper so operators see a precise `<nul-byte>` / `<control-char-0x..>` diagnostic instead — making prompt-injection traces legible per Unbreakable Rule 3. 11 new tests at `tests/internal/security/path-guard-nul-rejection.test.ts` + 1 pre-existing assertion at `tests/internal/security/path-guard.test.ts:249` updated to match the new specific NUL message. 68/68 path-guard sink tests GREEN across 4 files (path-guard unit / property / public-api / agent-session-store).

- **HKDF-SHA256 key derivation for OAuth tx-cookie AES-256-GCM key (T5.1 of plan `sdk-superiority-2026-06-07`, CRITICAL — DR6 finding #1)**: pre-T5.1 `server/auth/oauth-transaction-store.ts:deriveKey` zero-padded secret bytes to 32 if shorter and truncated if longer. This is NOT a key derivation function. Two near-identical secrets (e.g., `"a".repeat(31)` vs `"b".repeat(31)`) produced AES keys differing in only one byte across 32 — an attacker who recovered one cookie could brute-force adjacent deployments cheaply. T5.1 replaces the zero-padding with HKDF-SHA256 (RFC 5869) using `info="theokit:oauth-tx-v1"` and a salt sourced from `THEOKIT_OAUTH_TX_SALT` env var (defaults to RFC 5869 zero-string; operators MUST set per-app salt in production to eliminate cross-deployment collision risk). Distinct secrets now produce avalanche-distinct keys (Hamming distance > 160 bits empirically). **Breaking validation**: `encodeTransaction` (and via the SDK's `defineAuth` chain, any `startSignIn`/`finishSignIn` flow) now throws the new typed `AuthSecretTooShortError` when the configured secret has fewer than 32 bytes of UTF-8 encoded entropy. Pre-T5.1 secrets shorter than 32 bytes were silently zero-padded and produced insecure keys; rejecting them surfaces the misconfiguration honestly per Unbreakable Rule 3. Generate a fresh value with `openssl rand -base64 33`. New test seam `__TESTING__deriveKey` exposed for unit-test avalanche assertions; NOT in the public barrel. 7 new tests at `tests/server-auth-hkdf-derive-key.test.ts` + 1 fixture update at `tests/server-auth.test.ts` (`secret` widened 31 → 32 bytes). 23/23 server-auth tests GREEN.

### Added

- **Redactor pattern expansion (12 → 30 builtin patterns) (T5.4 of plan `sdk-superiority-2026-06-07`)**: pre-T5.4 the canonical redactor at `internal/security/redact.ts:48-63` shipped only 12 vendor-specific builtin regex patterns (Anthropic / OpenAI / OpenAI-project / GitHub PAT classic+fine-grained / GitLab / AWS / Google API / Slack / Sentry / Stripe live+restricted). DR6 finding #4 + #24 surfaced major credential classes leaking through unmasked: JWT (3-segment base64url), GCP service-account PEM private_key block, Azure Storage SAS signature, HuggingFace tokens, Anthropic admin keys, plus a long tail of vendor-specific prefixes (Perplexity / Groq / Replicate / Voyage / xAI / Fireworks / Pinecone / npm / SendGrid / Twilio / Mailgun / Discord / LaunchDarkly). T5.4 grows BUILTIN_PATTERNS to 30 with PEM block first (so the multi-line span runs before any per-line patterns can fire), JWT second, Azure SAS third (lookbehind on `?sig=`/`&sig=`), and the rest alphabetized by prefix for maintainability. PARAM_PATTERN keyword set expanded from 6 → 16 (added `client_secret`, `credential`, `credentials`, `id_token`, `jwt`, `private_key`, `refresh_token`, `service_account`, `session_token`, `token`); `auth` and `bearer` deliberately excluded — they would re-catch the post-BUILTIN-masked form (D71 prefix-preservation `sk-ant...xxxx`) and double-mask to `***`. The `redactSecrets` callback gains a guard that skips PARAM masking when the value contains the D71 `...` separator, preserving prefix-mask debuggability when BUILTIN already fired. New test seam `__TESTING__BUILTIN_PATTERN_COUNT()` exposed via `test-reset.ts` for the floor assertion. 23 new tests at `tests/internal/security/redact-pattern-expansion.test.ts`; 158/158 redaction-sink tests GREEN across 13 files (security/lint/telemetry/migration/agent-session). Closes DR6 finding #4 (pattern coverage) + #24 (PARAM keyword vocabulary).

### Refactored

- **Cycle #4 closed via `types/handoff-descriptor.ts` leaf with TAgent generic (iter-20)**: `HandoffDescriptor` + `HandoffOptions` + `HandoffContext` + `HandoffHistory` + `HandoffResult` moved to a new leaf file. The leaf has `HandoffDescriptor<TInput, TAgent>` parameterized over the target agent shape — no dependency on `SDKAgent` or any other agent.ts type. `types/handoff.ts` re-exports the leaf types with `TAgent = SDKAgent` pinned for back-compat callers. `types/agent.ts` now imports `HandoffDescriptor` from the leaf, breaking the bidirectional `types/agent.ts ↔ types/handoff.ts` edge. madge final state: **2 cycles** (only D428-acknowledged rollup-dts subscribe-at-sub-path remain). Cycle gate threshold tightened ≤ 2.
- **`internal/runtime/plugins/` sub-folder promotion + T5.1 complete (4 of 4, FO#1)**: 2 plugin-\* files moved from `internal/runtime/` to `internal/runtime/plugins/` via `git mv`. Direct file count: 50 → 48. **T5.1 complete across 4 iterations (15-18)**: cumulative 21 files moved across fixtures/ (5) + context/ (8) + registry/ (6) + plugins/ (2). `internal/runtime/` direct file count dropped 69 → 48. Audit ideal heuristic is 25; remaining 23-file gap is documented as out-of-scope (no further cohesive 5+ file cluster remains). 254/254 runtime + architecture tests GREEN.
- **`internal/runtime/registry/` sub-folder promotion (T5.1 partial 3 of 4, FO#1)**: 6 _-registry_ files moved from `internal/runtime/` to `internal/runtime/registry/` via `git mv`. Direct file count: 56 → 50. T5.1 status PARTIAL — 3 of 4 clusters done (fixtures + context + registry). Remaining: plugins/. Cross-package caller surgery covered: `src/agent.ts`, `src/index.ts`, 5 runtime siblings, 4 test files, 1 dynamic `import("./agent-factory-registry.js")` in `local-agent-runtime-extensions.ts`. 253/253 runtime + architecture tests GREEN; madge unchanged.
- **`internal/runtime/context/` sub-folder promotion (T5.1 partial 2 of 4, FO#1)**: 8 context-\* files moved from `internal/runtime/` to `internal/runtime/context/` via `git mv`. Direct file count: 64 → 56. T5.1 status PARTIAL — 2 of 4 clusters done (fixtures + context). Remaining: registry/, plugins/. Sibling callers (`local-agent`, `local-agent-bootstrap`, `system-prompt/local-assembly`) had their imports rewritten to `./context/context-X.js` (or `../context/context-X.js` from system-prompt/). 8 test files updated. 252/252 runtime + architecture tests GREEN.
- **`internal/runtime/fixtures/` sub-folder promotion (T5.1 partial, FO#1)**: 5 fixture-\* files moved from `internal/runtime/` to `internal/runtime/fixtures/` via `git mv`. Direct file count: 69 → 64. T5.1 status PARTIAL — fixtures is 1 of 4 clusters (context/registry/plugins remain for follow-up iterations). Internal-only refactor; sibling callers (`cloud-run`, `local-run`, `real-local-run`, `real-cloud-run`) had their imports rewritten to `./fixtures/fixture-X.js`. 251/251 runtime + architecture tests GREEN; madge cycle count unchanged.
- **`internal/memory/storage/` sub-folder promotion (T10.1, FO#3)**: 7 storage-primitive files moved from `internal/memory/` to `internal/memory/storage/` via `git mv` — `markdown-store.ts`, `transcript-store.ts`, `session-loader.ts`, `session-summary-writer.ts`, `reader.ts`, `wiki-loader.ts`, `chunk-markdown.ts`. Direct file count in `internal/memory/`: 28 → 22 (under the 25-file god-folder heuristic). Internal-only refactor; zero public API surface change. All sibling imports, runtime/\* callers, and test paths updated in the same slice. Architecture guard `tests/architecture/memory-folder-budget.test.ts` (NEW) asserts the budget. 140/140 architecture + memory tests GREEN; madge cycle count unchanged.
- **`dispatchSingleCall` orchestrator split (T10.4, PV#2)**: the 158 LOC body in `internal/agent-loop/tool-dispatch.ts` was decomposed into 7 named single-concern helpers (`applyRepairAndExtractCall`, `vetoFromForkWhitelist`, `startToolCallSpan`, `vetoFromPluginPreHook`, `vetoFromFileHookPreDecision`, `runToolWithLifecycle`, `finalizeSpanAndPostHook`). The orchestrator now reads as a ~28 LOC sequence; the previous complexity-suppression `biome-ignore` directive is removed. Zero public-API surface change; 51/51 regression tests (tool-dispatch + hooks + golden custom-tools) continue to pass.

### Fixed

- **5 LOW type-only cycles closed via 3 leaf extractions + self-ref drop (T4.1, ADR D438)**:
  - `types/agent-prims.ts` (NEW leaf) holds `ModelParameterValue`, `ModelSelection`, `CustomTool`; `types/run.ts` + `types/messages.ts` now import these from the leaf (no longer from `types/agent.ts`). Re-exported via `types/agent.ts` barrel — `import type { ModelSelection, CustomTool } from "@theokit/sdk"` keeps working.
  - `types/messages-base.ts` (NEW leaf) holds `UserMessage`; `types/updates.ts` imports from the leaf. Re-exported via `types/conversation.ts`.
  - `internal/memory/active-memory-types.ts` (NEW leaf) holds `ActiveMemoryQueryMode`, `ActiveMemoryStatus`, `ActiveMemoryResult`; `active-memory-cache.ts` imports from leaf. Re-exported via `active-memory.ts`.
  - Self-cycle on `types/agent.ts` (audit #3) closed by replacing the inline `import("./agent.js").SDKAgent` in `AgentOptions.handoffs?` with a direct forward-reference to the locally-defined `SDKAgent` interface.
  - madge cycle count: **8 → 3** in one slice. Closed: cycles #3/#5/#6/#7/#10. Remaining: #1+#2 D428-acknowledged (rollup-dts subscribe-at-sub-path); #4 documented as deviation requiring HIGH-impact SDKAgent-interface extraction (out of T4.1 scope).
  - Zero public type surface change. Public-type-surface smoke test in `tests/architecture/type-cycles-closed.test.ts` verifies barrels still resolve.
- **Architecture-test integrity fix (T4.1 follow-up)**: `tests/architecture/cycle-{8,9,11-12-13}-closed.test.ts` were passing **vacuously** because `repoRoot = resolve(__dirname, "../../../../..")` (5 ups) landed in the meta-repo `theokit-tools` which has no pnpm workspace — `pnpm exec madge` errored out and the cycle-line filter returned `[]`. Corrected to 4 ups (theokit-sdk workspace root). The underlying cycle closures from T1.1/T2.1/T3.1 are real (12/12 architecture tests now PASS against actual `madge --circular` output post-fix); the prior test integrity bug is surfaced honestly here per Unbreakable Rule 3 rather than buried.
- **CRITICAL runtime↔persistence cycle #9 closed**: extracted `internal/runtime/session-types.ts` (leaf types file ~15 LOC) holding `SessionMessage`. `agent-session-store.ts` now imports the type from this leaf; `agent-session.ts` re-exports it for back-compat with downstream importers. Closes the audit's only CRITICAL cycle (Phase 5 cartographer cycle #9 — `agent-session.ts → conversation-storage-fs.ts → agent-session-store.ts → agent-session.ts`, runtime↔persistence layer-crossing). madge cycle count: 9 → 8. Architecture test asserts via spawnSync. **Plan-vs-reality deviation:** ADR D432 prescribed a full port-and-adapter refactor; empirical inspection found the back-edge was a single types-only import, so type-leaf extraction is the smallest break that actually closes the cycle. Documented in `session-types.ts` JSDoc.
- **Memory cluster cycles #11 + #12 + #13 closed**: extracted `internal/memory/index-manager-contract.ts` (leaf types file holding `MemorySearchHit`, `IndexStatus`, `SearchOptions`, `MemoryBackend`, `OpenIndexOptions`). All 4 cluster members (`index-manager.ts`, `index-manager-dispatch.ts`, `lance-memory-adapter.ts`, `memory-index.ts`) now import these types from the contract; only the orchestrator imports runtime functions from dispatch (one direction). Single ~70 LOC extraction closes 3 HIGH cycles in one move (T2.1 of plan `arch-review-fixes-2026-06-06`, ADR D433). madge cycle count: 12 → 9. Back-compat re-export preserved on `index-manager.ts`. No public API touched.
- **Runtime cycle #8 closed**: extracted `internal/runtime/agent-registry-contract.ts` (leaf types file, ~60 LOC) holding `AgentRuntime` + `RegisteredAgent`. Both `agent-registry.ts` and `agent-registry-store.ts` now import these types from the contract; the previous runtime↔store 2-node cycle is closed (T3.1 of plan `arch-review-fixes-2026-06-06`, ADR D431). Back-compat re-export preserved on `agent-registry.ts` for existing downstream importers — no public API change. madge cycle count: 13 → 12 (HIGH cycle #8 resolved; remaining 12 covered by T1.1/T2.1/T4.1).

### Changed

- **BREAKING (shape only): `AgentRunError.providerError` getter now returns a redacted string (T1.5 of plan `sdk-superiority-2026-06-07`)**: pre-T1.5 the getter returned the raw `metadata.raw` object reference, which could carry `sk-...` tokens, Bearer JWTs, or other secret-shaped substrings straight into logs / Sentry / Langfuse. T1.5 wraps the value in `redactSecrets()` at the getter boundary and stringifies non-string payloads. Object identity is intentionally NOT preserved — secrets are stripped at the boundary. New `AgentRunError.toJSON()` OMITS `metadata.raw` from JSON output by default; operators opt in via `THEOKIT_DEBUG_RAW_ERRORS=1` to surface the (still-redacted) raw payload for diagnostics. All other fields (name/message/code/provider/requestId/conversationId/metadata.provider/metadata.endpoint/metadata.code/...) remain accessible. 5 new tests at `tests/security/error-redact.test.ts`; 2 pre-existing tests updated to reflect the new contract.

### Added

- **Reconnect storm prevention via `CredentialPool.waitForAvailable` (T3.9 of plan `sdk-superiority-2026-06-07`)**: pre-T3.9 the pool exposed only the instantaneous `hasAvailable()` probe (`internal/llm/credential-pool.ts:107-109`); concurrent callers that observed `select() === null` threw `CredentialPoolExhaustedError` immediately. Outer-layer retries then re-hit the pool the moment the first cooldown expired — every waiter woke at the same instant and hammered the upstream provider, defeating the cooldown's protective intent. T3.9 adds two new internal helpers on `CredentialPool`: `earliestResetAt()` (smallest `lastErrorResetAt` across exhausted entries) and `waitForAvailable(signal, { maxWaitMs, sleeper? })`. The wait loop uses full-jitter exponential backoff (AWS Brooker 2015 — same pattern shipped in T3.4's `computeBackoffMs`): each iteration sleeps a random fraction of the window to the earliest cooldown reset, so concurrent waiters stagger their re-probe instead of synchronizing. The `sleeper` parameter is a dependency-injection seam so tests stay deterministic without `vi.useFakeTimers()` — that timer mismatch was the blocker that deferred T3.4's wiring; T3.9 sidesteps it entirely. `PoolAwareLlmClient.stream()` now calls `pool.waitForAvailable` when `select()` returns null and the new `waitForAvailableMs` constructor option (default `30_000`) is non-zero; passing `0` opts out for legacy callers and for the two existing `pool-aware-client.test.ts` tests that assert the throw-fast contract. 5 new tests at `tests/internal/llm/credential-pool-wait-for-available.test.ts`; 110/110 llm tests GREEN. Closes DR3 finding #9 (reconnect storm under multi-tenant pool exhaustion).

- **Anthropic native cache-token surfacing on `LlmFinish` (T3.8 of plan `sdk-superiority-2026-06-07`)**: pre-T3.8 the Anthropic accumulator at `internal/llm/anthropic.ts:167-170` read only `input_tokens` and `output_tokens` from `message_delta.usage` — silently dropped `cache_creation_input_tokens` and `cache_read_input_tokens` even though Anthropic emits them when the `cache_control: {type:"ephemeral"}` annotation (shipped in T3.5) is present on system blocks. As a result the budget accumulator's 5-bucket telemetry stayed at zero and cost calculations couldn't apply the 1.25x cache_write / 0.1x cache_read discounts. T3.8 widens the `AnthropicMessageDelta` type, threads both counters through `handleMessageDelta` (treating 0 as "no cache activity" to mirror the usage-accumulator filter), and emits them on `LlmFinish`. New `__testing__AnthropicAccumulator` seam exposes the class directly so unit tests drive the message_delta path without spinning the SSE parser. 4 new tests at `tests/internal/llm/anthropic-cache-tokens.test.ts`; 105/105 llm tests GREEN. Closes the algorithm half of DR3 finding #8 (telemetry observability); real-LLM proof (live Anthropic round-trip with a ≥ 1024-token cacheable prefix returning `cache_read_input_tokens > 0` on the second send) lands in T6.1.
- **`ErrorCode.quota_exceeded` + provider-mapping completeness (T3.7 of plan `sdk-superiority-2026-06-07`)**: `ErrorCode` union widened with `quota_exceeded` (was missing per the TODO comment in `internal/errors/mappers/openai-compatible.ts:110`). `mapOpenAICompatibleError` now returns the canonical bucket for HTTP 402, OpenRouter "Insufficient credits", and body codes `insufficient_quota` / `quota_exceeded` — previously folded into `invalid_request`. Anthropic 529 (overloaded) and Vertex 401/403 are pinned by new contract tests (already correctly mapped to `server_error` and `auth_failed` respectively). 5 new tests at `tests/internal/errors/mappers/t3-7-quota-completeness.test.ts`; 2 pre-existing tests updated to assert the new T3.7 contract. 53/53 mapper tests GREEN. Closes DR3 finding #7 (MEDIUM — error-mapping completeness).
- **OpenAI structured outputs `response_format: json_schema` emission (T3.6 of plan `sdk-superiority-2026-06-07`)**: new `LlmResponseFormat` discriminated union at `internal/llm/types.ts` covers both `{type:"json_schema", jsonSchema:{name, schema, strict?}}` (canonical, defaults `strict: true`) and `{type:"json_object"}` (legacy JSON-mode hint). New `LlmRequest.responseFormat?: LlmResponseFormat`. `internal/llm/openai.ts:buildOpenAIBody` routes via new `encodeOpenAIResponseFormat` helper to emit OpenAI's wire shape verbatim. Same patch closes a latent T3.5 bug: `buildOpenAIBody` was naively pushing `request.system` (now `string | LlmSystemBlock[]`) into OpenAI's `content` field — would break for the array form. New `openAISystemText` helper collapses to a joined string the same way `ollamaSystemText` does. Real-LLM proof (Agent.generateObject prefers native path against `gpt-4o-2024-08-06+`) deferred to T6.1 with the live API. 4 new tests at `tests/internal/llm/openai-structured-outputs.test.ts`; 101/101 llm tests GREEN. Closes DR3 finding #6 (HIGH — native structured outputs unreachable).
- **Anthropic prompt-cache emit + `LlmRequest.system` widening (T3.5 of plan `sdk-superiority-2026-06-07`)**: new `LlmSystemBlock` type at `internal/llm/types.ts` with `text: string` + `cacheable?: boolean`. `LlmRequest.system` widened from `string` to `string | LlmSystemBlock[]` (back-compat preserved — pre-T3.5 string callers unchanged). `internal/llm/anthropic-shared.ts:buildAnthropicCommonBody` now translates the array form into Anthropic's content-block wire shape `{type:"text", text, cache_control?: {type:"ephemeral"}}` so consumers can opt into Anthropic prompt caching (1-3x cache_read billing discount on subsequent same-content turns). Empty array short-circuits to `undefined` (omitted system). `ollama-native.ts:buildOllamaChatBody` collapses the array form into a joined string for providers that don't support per-block caching. Real-LLM proof (cache_read_input_tokens > 0 on second send) lands in T3.8 + T6.1 with a ≥ 1024-token static prefix. 5 new tests at `tests/internal/llm/anthropic-prompt-cache.test.ts`; 97/97 llm tests GREEN.
- **Exponential backoff + full jitter helper (T3.4 of plan `sdk-superiority-2026-06-07`, partial)**: new `internal/llm/retry.ts` exposes `computeBackoffMs({attempt, baseMs?, capMs?, retryAfterMs?, rng?})` (AWS Brooker 2015 full-jitter pattern with provider Retry-After hint precedence + cap clamp) and `sleepWithAbort(ms, signal)` (resolves early on abort). Closes the algorithm half of DR3 finding #4 (pre-T3.4 the pool retried 429 immediately with no wait, burning every credential in <1ms under coordinated load). 10 new tests cover Retry-After in/out of range, exponential ceiling doubling, jitter spread (50-sample distinctness), cap enforcement, and abort-aware sleep. **Wiring into `pool-aware-client.ts` deferred to follow-up**: existing pool-aware-client tests use `vi.useFakeTimers()` which would stall on the new `setTimeout`-based sleeps; integration requires either test refactor to advance timers OR a sleeper-injection seam (out of iter scope). Helper module shipped + tested standalone.

### Fixed

- **SSE / NDJSON body stream cancels on EVERY exit path (T3.3 of plan `sdk-superiority-2026-06-07`, CRITICAL)**: extends T3.2's abort-only cancel to also cover consumer break (early `[DONE]` exit, satisfied stop condition) and consumer throw (JSON.parse failure, downstream `yield event` rejection). Pre-T3.3 the cancel-on-abort flag-tracking only fired when `signal.aborted === true`; if the OpenAI / Anthropic consumer broke out on `[DONE]` without aborting, the body stayed open and the TCP socket leaked. T3.3 collapses the conditional to unconditional `reader.cancel()` inside both `parseSseStream` and `parseNdjsonStream` finally blocks. WHATWG spec guarantees `cancel()` on a finished stream is a no-op, so always-cancel is safe. Helper renamed `cancelOnAbort → cancelReaderQuietly`. 2 new tests at `tests/internal/llm/sse-break-cancels-body.test.ts` (break + throw paths both observe `ReadableStream.cancel`). Zero regression across 82 llm tests. Closes DR3 finding #2 (T3.2+T3.3 together — required for T6.2 1000-conn load test).
- **SSE / NDJSON abort now cancels the body stream (T3.2 of plan `sdk-superiority-2026-06-07`, CRITICAL)**: pre-T3.2 `internal/llm/sse.ts:30-37` and `internal/llm/ollama-native.ts:243` only released the reader lock when `AbortSignal` fired — the underlying ReadableStream kept draining and the upstream HTTP connection's TCP socket stayed in CLOSE_WAIT. Over 100s of concurrent SSE clients (T6.2 load test) this leaked sockets to exhaustion. T3.2 mirrors a `aborted` flag and calls `reader.cancel()` in the `finally` block when the signal aborted, so cancellation propagates to the body stream. Best-effort catch around `cancel()` per ADR D34 safe-exporter contract (cancel-time errors never propagate to caller). 2 new tests at `tests/internal/llm/sse-abort-cancels-body.test.ts` (aborted signal triggers `ReadableStream.cancel`; normal close does NOT). Zero regression across 80 existing llm tests. Closes DR3 finding #2.
- **SSE parser HTML Living Standard § 9.2.6 compliance (T3.1 of plan `sdk-superiority-2026-06-07`, CRITICAL)**: `internal/llm/sse.ts:73` previously called `.trim()` on every `data:` / `event:` value, which (a) stripped ALL leading whitespace instead of exactly one space, and (b) destroyed legitimate trailing whitespace in payloads. Per HTML LS § 9.2.6 step 5 of "Process the field", only a single leading U+0020 SPACE should be removed. T3.1 replaces `.trim()` with a `stripOneLeadingSpace` helper. The bug was the root cause of intermittent stream truncation observed in DR3 review finding #1 — payloads with intentional padding (chunked JSON, message-id headers ending in a space) lost characters. 6 new tests at `tests/internal/llm/sse-spec-compliance.test.ts` cover both `data:` and `event:` fields, multi-line payloads, and chunk-boundary preservation. Zero regression across 78 existing llm tests.

### Added

- **`validateResponse` D93 bailout wiring (T2.1 of plan `sdk-superiority-2026-06-07`)**: previously `internal/runtime/validate-response.ts` was an orphan export with ZERO production callers (DR2 finding #1). The bailout-detector exists for the weak-model failure mode where Gemini Flash / Mistral 7B sometimes return `{ stopReason: "end_turn", text: "", toolCalls: [] }` and the run silently "finishes" with no visible answer. T2.1 wires `validateResponse` in `continueOrTerminate` and adds `LoopContext.nudgeAttempts` capped at 2: empty/whitespace-only bailout shapes inject a "Please continue or provide a final answer" user message and re-run the LLM turn. If the model still bails after 2 nudges, the loop finishes (gives up — break out of infinite spin). 4 new tests at `tests/internal/agent-loop/validate-response-nudge.test.ts` (LLM stub returns empty then real; whitespace-only triggers same path; nudgeAttempts cap; non-empty does NOT over-fire). Zero regression across 20 existing agent-loop + validate-response tests.
- **`downloadArtifact` path-traversal hardening (T1.4 of plan `sdk-superiority-2026-06-07`)**: previous inline check only rejected `..` substring + leading `/`. New centralized `validateArtifactPath` in `internal/security/path-guard.ts` rejects 7 vectors at the boundary: classic `..` parent-directory traversal, backslash escapes (`..\\windows`), URL-encoded `%2e%2e` (with double-decode to defeat `%252e%252e`), NUL byte injection (`\x00`), Windows drive letter prefix (`C:`, `D:\\`), home-tilde expansion (`~/`, `~root/`), and absolute paths (`/etc/passwd`). `cloud-agent.ts:downloadArtifact` delegates to the validator and preserves the typed `ConfigurationError({code:"artifact_path_traversal"})` contract. 7 new tests at `tests/security/artifact-path-traversal.test.ts`. Closes DR1 finding #2 (CRITICAL path traversal).
- **API key boundary validation (T1.3 of plan `sdk-superiority-2026-06-07`)**: new `internal/auth/api-key-validator.ts` exposes `validateApiKeyShape(key, opts?)` with a two-tier check — Tier 1 always rejects empty / whitespace-only / sub-4-char shapes; Tier 2 (strict, default-on) adds 16-char minimum + provider-prefix sanity (`sk-` for openai, `sk-ant-` for anthropic, `sk-or-` for openrouter) + embedded-whitespace rejection. Strict tier is bypassed when `shouldUseRealLocalRuntime(key)` is true (the env-credential path doesn't use the apiKey for the provider fetch). `Agent.create` wires the validator into both `createLocalAgent` and `createCloudAgent`. Failures throw `AuthenticationError({code:"malformed_api_key", message})`. 14 new tests at `tests/security/api-key-validation.test.ts` + zero regressions across 209 telemetry/errors/golden tests.
- **`RegisteredAgent` contract snapshot test (T1.2 of plan `sdk-superiority-2026-06-07`)**: new `tests/contract/registered-agent.test.ts` pins the public shape of `RegisteredAgent` + `AgentRuntime` + `RegisteredAgent.status` closed union. Tsc enforces the snapshot; any field drop / rename / type change surfaces at typecheck. Note: the leaf-extraction part of T1.2 (`agent-registry-contract.ts`) was already shipped under the prior plan `arch-review-fixes-2026-06-06` T3.1 / ADR D431. Madge cycle count unchanged (2 baseline).

### Changed

- **BREAKING (type-level only): `AgentRunErrorCode` is now closed (T1.1 of plan `sdk-superiority-2026-06-07`)**: the previous `(string & {})` escape hatch is removed. New canonical type `KnownAgentRunErrorCode` exposes the closed literal union; `AgentRunErrorCode` remains as a back-compat re-export alias (no source change required for code that uses the alias). Boundary helper `coerceToKnownAgentRunErrorCode(raw)` collapses unknown strings to `"unknown"` at the call boundary; `Agent.prompt` adopted it for `RunErrorDetail.code` translation. Migration codemod ships at `packages/sdk/scripts/migrations/error-code-string-2-known.mjs` (regex-based dry-run by default; pass `--write` to apply). Closes DR1 finding #1 (CRITICAL).

### Added

- **Load + chaos suite scaffold (T0.3 of plan `sdk-superiority-2026-06-07`)**: 6 new test files at `tests/load/{1000-concurrent-sse,leaky-generators,slow-consumer-backpressure}.test.ts` and `tests/chaos/{kill-mid-stream,partition-fs,oom-recovery}.test.ts`. Three harness modules ship alongside: `tests/load/_harness/sse-driver.ts` (in-process SSE driver — NOT autocannon — per SEPA brief § E; tracks p50/p95/p99 latencies + SSE event count via `\n\n` terminators per HTML LS § 9.2.6), `tests/load/_harness/socket-monitor.ts` (Linux-only `ss -tnp` probe with no-op fallback for Mac/Win; CI asserts `closeWaitCount ≤ threshold`), `tests/chaos/_harness/process-control.ts` (child-process spawn + SIGKILL injection per ADR D37 methodology). Today's scaffold uses 100 concurrent SSE (override via `T0_3_CONCURRENCY=1000`); T6.2 ratchets to the full 1000-conn p95 < 200ms perf gate, T6.3 wires the kill-mid-stream chaos against the SDK's real streaming surface, T6.4 wires partition-fs against persistence paths, T6.5 wires OOM against the memory subsystem.
- **Real-LLM CI matrix scaffold (T0.2 of plan `sdk-superiority-2026-06-07`)**: 15 env-gated integration test files at `tests/integration/real-llm/{openai,anthropic,openrouter}-{tools,vision,stream,cache,structured}.test.ts`. Each file uses `describe.skipIf(...)` so the suite is silent when the relevant API key is absent. `tests/integration/real-llm/_helpers/real-llm-env.ts` centralizes the provider-key resolver with OpenRouter fallback for non-native scenarios (Anthropic cache stays native-only per SEPA initial brief § C). With keys set the matrix validates the happy path for tool use, streaming, vision content parts, prompt caching, and structured outputs across the 3 routes — expanded depth (cache_read_input_tokens > 0 assertion, parallel tool dispatch, error-retry) lands in T3.5 / T3.8 / T6.1. Default model `openai/gpt-4o-mini` per cost budget. Today: 15/15 files skip cleanly.
- **OTel hot-path wiring foundation (T0.1 of plan `sdk-superiority-2026-06-07`)**: emit canonical spans `agent.create`, `agent.send` (parent), and `memory.recall` when `telemetry.enabled: true`. New closed-enum `internal/telemetry/span-names.ts` (14 names + `SpanName` literal type) anticipates the no-`(string & {})` discipline of T1.1. `TelemetryHandle` interface extended with `recordHistogram(name, valueMs, attrs)` and the OTel `metrics` namespace is lazy-loaded the same way `trace` is (graceful no-op when missing). First histogram name registered: `theokit_memory_recall_duration_ms` (recorded with `userId/namespace/scope/status` dimensions). Integration tests use a real `@opentelemetry/sdk-trace-base` `InMemorySpanExporter` (NOT module mocks) — added as devDep alongside `@opentelemetry/api` and `@opentelemetry/sdk-metrics`. Wiring triad: pillar (a) callers are `Agent.create` (production), `LocalAgent.send` (production), `runActiveMemory` (production); pillar (b) covered by `tests/telemetry/*.test.ts` (8 tests). Remaining acceptance items — `agent.send.<step>` 8 child spans, `tool.call`, `llm.call` spans — deferred to T1.7 / T2.4 / T3.\* per SEPA brief (zero plan-deviation).
- **`SecretRedactor` interface** at `internal/security/secret-redactor.ts` (T9.1 of plan `arch-review-fixes-2026-06-06`, ADR D437). Types-only — no runtime exports; canonical `redactSecrets` from `redact.ts` satisfies the interface structurally. Closes AF#16 (Martin Zone of Pain D=0.923) from the 2026-06-06 architecture audit through documentation + minimal abstraction without violating D68/D69/D70/D71/D73 (security primitives stay concrete + stable). Rationale + coupling metrics at `internal/security/README.md`.

### Changed

- **Renamed `internal/runtime/system-prompt/providers/` → `internal/runtime/system-prompt/sources/`** (FO#6, plan `arch-review-fixes-2026-06-06` T10.3). The directory previously shared its basename with `internal/providers/` (LLM provider profiles per ADR D105-D107) — auditor flagged the duplicate folder name as a findability hazard. `sources/` better describes the semantic: these 5 modules are system-prompt _sources_ (ActiveMemoryPromptProvider, BasePromptProvider, ContextPromptProvider, MemoryPromptProvider, SkillsPromptProvider), not LLM provider profiles. Internal-only rename; no public API touched. Git-rename detection preserved (5/5 files moved with `git mv`); import paths in `pipeline.ts` + 5 golden tests updated atomically.

### Fixed

- **`safeListTools` no longer silently swallows MCP failures** (PV#6, plan `arch-review-fixes-2026-06-06` T8.1). When `client.listTools()` throws (MCP server unreachable, auth refused, etc.), the agent loop now emits a structured `[theokit-sdk] mcp listTools failed (server=<name>): <error>` line to stderr **while preserving the empty-list fallback** that consumers depend on for graceful degradation. The previous behaviour violated Unbreakable Rule 8 (`FAIL loud, FAIL early, FAIL clear`). `safeListTools` is now `export`ed from `internal/agent-loop/loop.ts` to enable unit-test access to the catch path — NOT promoted to the public `@theokit/sdk` API surface.

### Notes

- **Cycles #1, #2 (type-only, ADR D428 acknowledged):** the 2026-06-06 architecture audit (`/loop-architecture-review`) found 2 type-only dependency cycles in `packages/sdk/src/types/agent.ts ↔ internal/runtime/fork-agent.ts` that manifest in the rollup-dts bundle. Per ADR D428 (subscribe-at-sub-path) these are intentional: keeping `subscribe` at the `@theokit/sdk/subscription` sub-path avoids promoting types through the cycle. They are NOT runtime cycles (JS-erased at build time) and are not breakable without regressing D428. Plan `arch-review-fixes-2026-06-06` T11.1 documents this rationale.
- **PV#8 — ISP / SDKAgent bundles local + cloud methods (ADR D122 acknowledged):** the 2026-06-06 architecture audit flagged the `SDKAgent` public interface as bundling local-only and cloud-only methods (ISP marginal). Per ADR D122 (`run-until-cloud-unsupported`), `CloudAgent` throws `UnsupportedRunOperationError` for runtime ops it cannot service while sharing the same TypeScript surface — the bundled shape is intentional cross-runtime API parity, not a design defect. Splitting `SDKAgent` into local/cloud interfaces would force consumers to branch on runtime at call sites, contradicting D122's "single typed surface" decision. Plan `arch-review-fixes-2026-06-06` T11.1 documents this rationale.

### Fixed

- Restored green `pnpm validate` after G8 subscription landing (`9fda7d7`). Biome 2.4 gate: 24 lint findings in `subscription/` prod + tests resolved with `biome-ignore` annotations (9× `useYield` intentional empty/throw test handlers; 13× `noExcessiveCognitiveComplexity` refactor-candidate; 1× `noConfusingVoidType` idiomatic callback shape; 1× `noAssignInExpressions` idiomatic line-parser). Stale `// eslint-disable-next-line require-yield` comments replaced — Biome does not honor ESLint pragmas. Lint-gate T1.5.2 `no-unredacted-sink` whitelisted `subscription/internal/server-integration.ts` (writes declarative `SubscriptionManifest`, no PII). Build/publint: `scripts/mirror-dts-to-cts.mjs` targets extended to cover `subscription/` so `dist/subscription/index.d.cts` is emitted (fixes `pkg.exports["./subscription"].require.types` missing). Dead-code/knip: ignore glob extended from `src/internal/**` to `src/**/internal/**` for per-feature internal namespaces. Architecture/depcruise `no-orphans`: `pathNot` extended with `(^|/)packages/sdk/src/[^/]+/internal/` (same exemption rationale as `src/internal/` — type-only exports erased at runtime).

## 1.7.0 - 2026-06-04

### Added

- **`@theokit/sdk/subscription` sub-path** (per blueprint G8 SHIPPABLE 98.3) — typed subscription primitive with WS + W3C SSE transports + opaque resume tokens (`lastEventId`). Form 4 Hybrid (D423): low-level adapters (`createNodeWsAdapter`, `encodeSseChunk`, `parseSseW3C`) + high-level DSL (`defineSubscription`, `subscribe`, `tracked`).
- **8 exports** at `@theokit/sdk/subscription`:
  - `defineSubscription<TInput, TOutput>({input, output, handler})` — server-side typed RPC factory (D427)
  - `subscribe<TInput, TOutput>(name, input, opts)` — client-side AsyncGenerator with transparent reconnect + lastEventId propagation (D428)
  - `tracked(id, payload)` + `isTrackedEnvelope(value)` — resume token envelope helpers
  - `SubscriptionTransport = 'ws' | 'sse' | 'auto'` (D425)
  - `SubscriptionCtx`, `SubscriptionDescriptor<TInput, TOutput>`, `TrackedEnvelope<T>` (types)
- **3 typed error classes:** `SubscriptionError`, `SubscriptionInputError` (carries Zod `issues`), `SubscriptionDisconnectError` (carries `closeCode`/`closeReason`). All extend `TheokitAgentError`.
- **`ws@>=8.0.0` + `@types/ws@>=8.0.0` optional peer deps** — Node WS adapter loads `ws` via dynamic `import()` with actionable error when missing (D426). SSE-only consumers pay zero cost.
- **W3C-spec SSE encoder + parser** — independent of the D38 Data Stream v1 wire format (which stays locked for `streamAssistant` LLM streaming). Both coexist (D429).
- **Server integration primitives** — `scanSubscriptions({appDir, outFile})` emits `.theo/subscriptions.json` mirroring G6 routes scanner; `mountSubscriptions({manifest, appDir})` returns `{handleSseRequest, handleWsUpgrade}` ready to wire into `http.Server`. theokit-side Vite plugin + dev-server wiring is a cross-repo follow-up (D430).

### ADRs absorbed

- **D423** — Form 4 Hybrid (low-level primitives + high-level DSL)
- **D424** — `lastEventId` opaque, server-defined replay semantics
- **D425** — Transport selection `'ws' | 'sse' | 'auto'` (default `'auto'` = WS-preferred)
- **D426** — `ws` Node canonical (optional peer); CF Workers / Bun / Deno deferred to v1.8.x as separate packages
- **D427** — `defineSubscription` AsyncGenerator + Zod input/output
- **D428** — `subscribe` lives at `@theokit/sdk/subscription` sub-path only (NOT promoted to `Theokit.subscribe` due to pre-existing `agent.ts ↔ fork-agent.ts` rollup-dts cycle; same isolation pattern as `path-safety`)
- **D429** — W3C SSE wire format (independent of the D38 Data Stream)
- **D430** — Server auto-route via `theokit.subscriptions` scanner (cross-repo follow-up for theokit-side wiring)

### Security threats addressed

| Threat                              | Mitigation                                                                                                                                                                                    |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resume token replay                 | Consumer SHOULD bind token to session + rotate per reconnect; SDK ships TTL knob via custom `tracked()` envelope semantics                                                                    |
| WS connection hijacking             | Auth at HTTP upgrade — `WsAdapter.upgrade(ctx, raw)` exposes the `request` so consumer middleware (G11 `defineAuth`) runs BEFORE upgrade. Rejected upgrade returns null → caller responds 401 |
| Subscription input tampering        | Zod schema validation BEFORE handler invocation; throws `SubscriptionInputError` carrying issues                                                                                              |
| Resource exhaustion                 | Per-subscription `AbortSignal`; `SubscriptionRuntime.getActiveConnectionCount()` for ops visibility; consumer wires rate-limit middleware (P#10) at upgrade boundary                          |
| Sensitive data in logs              | Telemetry seam (D34) captures metadata only (`subscriptionName`, `lastEventId`, `connectionId`); never payloads (per D73 redact at output boundaries)                                         |
| Long-lived WS survives token expiry | `ctx.disconnect(code, reason)` lets consumer's auth middleware force-close when session revoked                                                                                               |

### Multi-runtime compatibility matrix

| Runtime            | v1.7.0                    | v1.8.x (planned)                   |
| ------------------ | ------------------------- | ---------------------------------- |
| Node 22+           | yes (canonical `ws` peer) | yes                                |
| Cloudflare Workers | consumer adapter only     | yes (`@theokit/sdk-ws-cloudflare`) |
| Bun                | consumer adapter only     | yes (`@theokit/sdk-ws-bun`)        |
| Deno               | consumer adapter only     | yes (`@theokit/sdk-ws-deno`)       |

### Notes

- v1.7.0 is **additive** — no breaking changes. Existing `streamAssistant` (Data Stream wire format, D38) untouched.
- Tests: **45 GREEN + 1 honest-SKIP** under `tests/subscription/` + `tests/integration/subscription-resume.test.ts` (real `ws.WebSocketServer` + `http.Server` real SSE roundtrip + lastEventId resume) + `tests/integration/subscription-real-llm.test.ts` (env-gated `OPENROUTER_API_KEY` — verified GREEN against real OpenRouter `openai/gpt-4o-mini` per `real-llm-validation.md`).
- Build: `dist/subscription/index.{js,cjs,d.ts,d.cts}` emitted; JS+CJS via tsup, DTS via tsc + `tsconfig.tools-dts.json` (mirrors `tools/` + `path-safety` pattern to avoid pre-existing `types/agent.ts ↔ fork-agent.ts` rollup-dts cycle).

## 1.6.0 - 2026-06-03

### Added

- **`@theokit/sdk/server/auth` sub-path** (per ADR D6 of plan g11-auth-architecture-implementation v1.4) — orchestrator-only auth surface ships `defineAuth<TSession>(opts)` factory + 5 supporting types. Implements **Path C (Hybrid)** from discovery blueprint `g11-auth-architecture-decision` (SHIPPABLE 97.9). Providers ship as opt-in `@theokit/auth-*` packages (Tier 1: Google + GitHub + Magic Link — separate packages, semver-independent). Aligned with `AUTH-DELEGATION` lock in `theokit/CLAUDE.md:217-225` (lock's own escape-hatch clause "If we do adopt later: ship providers as separate optional packages under `@theokit/auth-*`, NEVER in the framework core").
- **6 type exports** at `@theokit/sdk/server/auth`:
  - `defineAuth<TSession>(opts): AuthOrchestrator<TSession>` factory
  - `DefineAuthOptions<TSession>` config shape
  - `AuthOrchestrator<TSession>` 5-method surface (`startSignIn`, `finishSignIn`, `signIn`, `signOut`, `getSession`)
  - `AuthProvider<TProfile, TName>` provider contract
  - `AuthResult<TProfile, TName>` callback return shape
  - `OAuthTransaction` cookie-state transaction shape
- **4 typed error classes:** `AuthConfigError`, `AuthProviderNotFoundError`, `AuthCallbackError`, `AuthCancelledError` (extends `AuthCallbackError`).
- **`validateReturnTo(returnTo, baseUrl)` helper** — same-origin validation for OWASP A01:2021 open-redirect mitigation.

### Edge cases absorbed inline (from plan v1.1 edge-case-plan)

- **EC-1** — `AuthCancelledError` thrown on OAuth `?error=access_denied` callback (RFC 6749 §4.1.2.1) BEFORE attempting code-exchange. Apps catch distinctly to render "Login cancelled" UX vs opaque "callback failed".
- **EC-2** — `validateReturnTo` rejects protocol-relative URLs (`//evil.com`), cross-origin absolute URLs, and bare strings. Defaults to `/` when unsafe.
- **EC-10** — `rotateSession()` called BEFORE `createSession()` in `finishSignIn` + `signIn` per OWASP A07:2021 session-fixation mitigation.
- **EC-6** — Typed `oauth_transaction_expired` code on `AuthCallbackError` for expired cookie-state transactions (≥ 10min old).
- **D5** — OAuth transaction stored in encrypted cookie (`theo_oauth_tx`, AES-256-GCM, 10-min expiry, HttpOnly + Secure + SameSite=Lax).

### Notes

- v1.6.0 is **additive** — no breaking changes. Existing consumers of `createSessionManager` (from `theokit/server/auth`) unaffected.
- Providers (`@theokit/auth-google`, `@theokit/auth-github`, `@theokit/auth-magic-link`) ship in separate npm packages (Phase 2-4 of plan G11). They will publish to `@next` tag first per ADR D3 (4-6 week telemetry observation window before promote to `@latest`).
- Tests: 16/16 GREEN in `tests/server-auth.test.ts` covering config validation, EC-1, EC-2, EC-10, Path A signIn, expired transaction, unknown provider.

## 1.5.0

### Changed

- **`publishConfig.provenance` removed (aligned with the monorepo's policy).** This was the only `package.json` of 11 publishable packages with `provenance: true`; architectural drift — the flag promised cryptographic attestation but no repo in the monorepo has a release.yml with `id-token: write` permission to mint an OIDC token against the npm registry. Result: local publishes failed with `EUSAGE: Automatic provenance generation not supported for provider: null`. Decision: align intent with the current infrastructure (10 of the 11 other packages declare no provenance). **Strategic follow-up:** adding a release.yml with `id-token: write` across every repo (theokit-sdk + theokit + theokit-plugins + theo-ui) enables universal provenance — separate scope.

### Breaking Changes

- **`Workflow` and `Eval` moved out of the main barrel into dedicated sub-paths.** The migration is mechanical (rewrite the `from` string); no behavior changes. `@theokit/sdk` main barrel no longer exports:

  - From workflow: `Workflow`, `WorkflowBuilder`, `agentStep`, `fn`, `WorkflowAlreadyRunningError`, `WorkflowCompensateNotImplementedError`, `WorkflowDuplicateStepIdError`, `WorkflowMaxIterationsExceededError`, `WorkflowNotSerializableError`, `WorkflowParallelError`, `WorkflowResumeStepNotFoundError`, `WorkflowSnapshotNotFoundError` — **import from `@theokit/sdk/workflow` instead**.
  - From eval: `Eval`, `EvalAlreadyRunningError`, `Scorers` — **import from `@theokit/sdk/eval` instead**.
  - From `types/*`: type aliases for workflow + eval (e.g., `EvalRun`, `Scorer`, `Score`, `EvalOptions`, `EvalAggregate`, `Step`, `FnStep`, etc.) no longer reach the main barrel via `types/index.ts`; surface only through the new sub-paths.

  Rationale: Interface Segregation. The barrel exported 17+ feature areas, forcing consumers to pay the DTS cost of `Workflow`+`Eval` even if they only used `Agent`+`Memory`. Sub-paths reduce DTS surface and align with the existing pattern (`@theokit/sdk/cron`, `/tools`, `/path-safety`, `/task-store`, `/errors`).

  **Migration:**

  ```ts
  // Before
  import { Workflow, Eval, Scorers } from "@theokit/sdk";

  // After
  import { Workflow } from "@theokit/sdk/workflow";
  import { Eval, Scorers } from "@theokit/sdk/eval";
  ```

### Added

- `@theokit/sdk/workflow` sub-path entry (with full ESM + CJS conditions, `.d.ts` + `.d.cts` mirror for attw compliance).
- `@theokit/sdk/eval` sub-path entry (same shape; `Scorers` co-located here per locality of reference).

## 1.4.1 (workspace-only — NOT published to npm)

> **Drift note (2026-06-02):** versions 1.4.0 and 1.4.1 landed in workspace and were merged to develop, but never reached the `@latest` npm dist-tag. npm `@theokit/sdk@latest` remains at **1.3.0** (last shipped 2026-05-30). The 1.4.x patch chain will be consolidated into the next published release (1.5.0 or higher) — consumers who need the LanceDB wiring fix (1.4.0) or the zod v3/v4 universal converter (1.4.1) must install `@theokit/sdk@1.5.0-next.X` (when published on `next`) or wait for the consolidated `latest` cut. Drift root cause: 1.4.0 sub-paths extraction work changed the publish requirements (workspace `pnpm changeset version` chain was bumped but `pnpm changeset publish` was deferred while 1.5.0 sub-path API surface stabilized). All entries below reflect REAL code changes that DID land on develop.

### Patch Changes

- **`defineTool` now works on zod v3 + v4 (universal converter).** Before this patch, `defineTool({ inputSchema: z.object(...) })` failed at runtime with `z.toJSONSchema is not a function` whenever the consumer's resolved `zod` was v3 (which is the case for `theokit` and `dogfood-app` today — both pin `^3.25.0`). The SDK delegates conversion to the existing universal `internal/zod/to-json-schema.ts` adapter (feature-detect zod 4 native `toJSONSchema` → fallback to `zod-to-json-schema` peer lib). Caught end-to-end via Chrome MCP dogfood — `/api/tools`, `/api/admin/sdk-config`, `POST /api/chat` all 500'd before the fix; all 200 after.
- **`internal/zod/to-json-schema.ts` cross-version safety net:** when the SDK runs under a dev-server (Vite SSR), `createRequire("zod")` resolves to the SDK's OWN `node_modules/zod` (v4 in devDeps), while the schema was built by the consumer's zod v3 instance. Calling v4's `toJSONSchema(v3Schema)` throws. The native path now catches that error and falls through to `zod-to-json-schema` (which understands both v3 and v4 schemas). Mode toggled in cache so subsequent calls go directly to the working path.
- Added `zod-to-json-schema: "^3.24.0"` as optional `peerDependency` (already silently required by zod-3 consumers; now declared explicitly so `pnpm install` resolves it deterministically).

## 1.4.0 (workspace-only — NOT published to npm)

> See drift note at the top of the 1.4.1 section. Code landed; npm `@latest` still at 1.3.0.

### Minor Changes

- **`Memory.create({ index: { backend: "lance" } })` is now wired end-to-end.** The `LanceIndex` implementation existed since 2026-05-17 (ADR D43) but `IndexManager.open` did not dispatch — public API accepted `backend: "lance"` silently and always fell through to SQLite. Fix: factory dispatcher in `IndexManager.open` + new portable `MemoryIndex` interface + new `LanceMemoryAdapter` wrapper + `@lancedb/lancedb` declared as optional `peerDependency` (`^0.30.0`).

  **Migration path:** consumer that wants Lance:

  ```bash
  pnpm add @lancedb/lancedb apache-arrow@^18.1.0
  ```

  ```ts
  await Memory.create({
    index: { backend: "lance" },
    embedding: { provider: "openai", apiKey: process.env.OPENAI_API_KEY },
  });
  ```

  Default keeps SQLite (zero added deps, zero breaking change vs 1.3.0).

  **When to opt-in (benchmark evidence — `.claude/knowledge-base/benchmarks/memory-backends-2026-05-31.md`):**

  - Lance wins **43x** ingest throughput at 100k facts (59849 ops/s vs SQLite-vec 1875 ops/s).
  - Lance uses **65% less disk** at 100k (33.8 MB vs 93.5 MB).
  - SQLite-vec recall p95 stays competitive up to 100k (~25 ms). Use Lance when ingest velocity or disk pressure matters; SQLite handles latency well below 1M facts.

  **EC-1 hardening:** new `ConfigurationError({code:"invalid_memory_backend"})` for typo-protection — `backend: "lancedb"` (typo) now throws instead of silently falling back to SQLite. Same hardening for `lance_requires_embedding` and `lance_backend_unavailable` typed errors.

  **Gotchas:**

  - `@lancedb/lancedb` ships prebuilds for linux-x64-gnu, darwin-arm64, darwin-x64, win32-x64-msvc. Alpine/musl/ARM-Linux require `node-gyp` toolchain. SQLite default covers those cases.
  - Bundlers (Next.js/Vite/webpack/rollup) must externalize `@lancedb/lancedb`:
    - Next.js: `experimental.serverComponentsExternalPackages: ["@lancedb/lancedb"]`
    - Vite: `optimizeDeps.exclude: ["@lancedb/lancedb"]` + `ssr.external: ["@lancedb/lancedb"]`
    - webpack/rollup: add to `externals` array

  Closes ADR D12 ("LanceDB deferred to v1.1") via fulfillment of D43.

- **EC-1/EC-8 fixes shipped atomically** (caught by the new integration test against real `@lancedb/lancedb@0.30.0`):
  - `LanceIndex.search` now uses SQL string predicate with `escapeSqlValue()` (single-quote doubling) instead of object filter — Lance 0.30 only accepts SQL string in `.where()`, contrary to D43's original assumption.
  - `LanceIndex.open` dim-mismatch detection now reads `schema().fields.type.listSize` (Apache Arrow `FixedSizeList` typeId=16 layout in Lance 0.30) — previously checked `fixedSize` which never matched.

### Patch Changes

- Refactored `RealLocalRun.executeAgentLoop` (complexity 11 → ≤10) via Extract Method: introduced `applyAgentLoopOutput` private helper that copies events/conversation/result/usage/cost/error onto the script. Behavior preserved byte-for-byte. (theokit-sdk-biome-cleanup)
- Removed redundant `// biome-ignore` directive from `internal/llm/fault-injection.ts` that no longer applied after the workspace enabled `javascript.parser.unsafeParameterDecoratorsEnabled`. (theokit-sdk-biome-cleanup)
- Extracted message-builder helpers (`buildSystemEvent`, `buildUserEvent`, `buildAssistantEvent`, `buildAssistantTurn`) from `internal/agent-loop/loop.ts` into a new sibling `message-builders.ts` to bring `loop.ts` back under the G8 file-size budget (400 LoC). Pure refactor — no behavior change. (theokit-sdk-biome-cleanup)
- Removed redundant `export` on `GraphSnapshot` interface (internal-only). (theokit-sdk-biome-cleanup)
- Added inline `// biome-ignore lint/correctness/useYield` on two intentional non-yielding async-generator mocks in `tests/internal/agent-loop/error-packaging.test.ts` (legitimate test seam — throws before yielding). (theokit-sdk-biome-cleanup)
- Vitest configuration: switched `pool` to `forks` (top-level) with `singleFork: false` so each test file runs in its own subprocess. This is the only reliable way to isolate `process.env.HOME` mutations across the discovery / context-import-resolver / personality test files, which were producing 5 flaky failures under parallel-package validate. Stack-keyed `process.env.HOME` save/restore added to `vitest.setup.ts` for additional safety. (theokit-sdk-biome-cleanup)

- Refactored `RealLocalRun.executeAgentLoop` (complexity 11 → ≤10) via Extract Method: introduced `applyAgentLoopOutput` private helper that copies events/conversation/result/usage/cost/error onto the script. Behavior preserved byte-for-byte. (theokit-sdk-biome-cleanup)
- Removed redundant `// biome-ignore` directive from `internal/llm/fault-injection.ts` that no longer applied after the workspace enabled `javascript.parser.unsafeParameterDecoratorsEnabled`. (theokit-sdk-biome-cleanup)
- Extracted message-builder helpers (`buildSystemEvent`, `buildUserEvent`, `buildAssistantEvent`, `buildAssistantTurn`) from `internal/agent-loop/loop.ts` into a new sibling `message-builders.ts` to bring `loop.ts` back under the G8 file-size budget (400 LoC). Pure refactor — no behavior change. (theokit-sdk-biome-cleanup)
- Removed redundant `export` on `GraphSnapshot` interface (internal-only). (theokit-sdk-biome-cleanup)
- Added inline `// biome-ignore lint/correctness/useYield` on two intentional non-yielding async-generator mocks in `tests/internal/agent-loop/error-packaging.test.ts` (legitimate test seam — throws before yielding). (theokit-sdk-biome-cleanup)
- Vitest configuration: switched `pool` to `forks` (top-level) with `singleFork: false` so each test file runs in its own subprocess. This is the only reliable way to isolate `process.env.HOME` mutations across the discovery / context-import-resolver / personality test files, which were producing 5 flaky failures under parallel-package validate. Stack-keyed `process.env.HOME` save/restore added to `vitest.setup.ts` for additional safety. (theokit-sdk-biome-cleanup)

## 1.3.0

### Minor Changes

- Fix Finding B: provider/transport errors no longer leak as `SDKAssistantMessage` content. They surface structured on `RunResult.error` (`{ message, code?, cause? }`).

  **Background.** Previously, the agent loop's stream catch block (`internal/agent-loop/loop.ts`) and the runtime's `emitErrorEvent` (`internal/runtime/real-local-run.ts`) both pushed an `SDKAssistantMessage` carrying the error text. Downstream surfaces (notably `theokit`'s `streamAgentRun`) then yielded `{ type: 'message' }` events instead of `{ type: 'error' }`, hiding the failure from consumers' typed error handling and from chaos tests.

  **What changed.**

  - `AgentLoopOutput` now carries an optional `error?: AgentLoopErrorDetail` field.
  - The loop catch path and the in-stream `{ type: "error" }` event both populate `ctx.error` via a single `registerLoopError(ctx, cause)` helper that enforces the set-once invariant (first-error-wins, ADR D3) and EC-1 typeof-guards `cause.code` so a non-string code never lands on the wire as the literal `"undefined"`.
  - The abort path (`signal.aborted === true`) still emits `"[aborted]"` as an `SDKAssistantMessage` — that is a UX seam, not an error.
  - `executeAgentLoop` copies `output.error` onto `script.errorDetail`, which `buildResult()` already surfaces as `RunResult.error` (set-once invariant preserved).
  - `emitErrorEvent` (used by MCP-init / build-inputs / outer-catch paths) no longer pushes an assistant message — those errors flow exclusively via `script.errorDetail` → `RunResult.error`.

  **Migration (EC-8).** If your code grepped for the error inside `for await (const msg of run.stream()) { if (msg.type === 'assistant' && /401|API error/.test(...)) }`, switch to `const result = await run.wait(); if (result.status === 'error') { result.error.message; result.error.code; }`. The abort case still arrives as an assistant message with content `"[aborted]"` — distinct from errors.

  **Tests added.** `tests/internal/agent-loop/error-packaging.test.ts` (5 unit tests covering auth, transport, abort UX preservation, first-error-wins, happy-path sanity). `tests/runtime/error-packaging-e2e.test.ts` (2 E2E tests covering full `Agent.create → send → wait → result.error` pipeline with mocked 401 fetch and the EC-6 double-negative invariant).

## 1.2.0

### Minor Changes

- **D14 — Test fault injection via `THEOKIT_TEST_RESPONSE_OVERRIDE` env var.**

  Adds a deterministic chaos-testing seam at the LLM transport layer. When `NODE_ENV=test` AND `THEOKIT_TEST_RESPONSE_OVERRIDE` is set to a JSON string of shape `{"status": number, "body": object | string}`, every provider client returned by `resolveProviderChain` short-circuits the real network call and synthesizes the configured response.

  **Use cases (replaces flaky chaos patterns):**

  ```bash
  # 429 rate-limit — deterministic, zero quota burn
  export NODE_ENV=test
  export THEOKIT_TEST_RESPONSE_OVERRIDE='{"status":429,"body":{"error":{"code":"rate_limit_exceeded","message":"Rate limit hit"}}}'

  # 500 server error — for retry / circuit-breaker tests
  export THEOKIT_TEST_RESPONSE_OVERRIDE='{"status":500,"body":{"error":{"code":"internal_error"}}}'

  # 200 happy path — deterministic text for snapshot tests
  export THEOKIT_TEST_RESPONSE_OVERRIDE='{"status":200,"body":{"choices":[{"message":{"content":"hello"}}]}}'
  ```

  **Design (FAANG-grade fail-safe):**

  - **Two-gate activation.** Both `NODE_ENV === "test"` AND a non-empty env var must be present. Production deployments are unaffected (cheap noop in the hot path).
  - **Decorator pattern** (`FaultInjectingLlmClient`) wraps every resolved transport. Composes cleanly with `PoolAwareLlmClient` (credential pools D123-D133) and per-provider transports without modifying them.
  - **Graceful degradation on malformed JSON** — one-shot stderr warn + fall-through to the real client. Never throws on bad config.
  - **Error parity** — injected non-200 statuses go through the existing `mapOpenAICompatibleError` mapper, so the error class hierarchy (`RateLimitError`, `AuthenticationError`, `NetworkError`, `ConfigurationError`) is byte-equal to what the real provider would raise.
  - **Transparent passthrough** when override is absent — the wrapper preserves `client.name` for telemetry and exposes `inner` so layered-transport assertions (router pool-wiring tests, telemetry inspectors) can walk one level deep.

  **Tests:** 12 unit tests (`tests/llm-fault-injection.test.ts`) + 3 wiring tests (`tests/llm-fault-injection-router-wiring.test.ts`) — gate negative + active for each status class + idempotence + name preservation.

  **Rejects the anti-patterns:** "50 parallel requests to force 429" (flaky + quota burn + cost overrun), `nock`/`msw` (violates stranger persona), conditional code in templates (Strategy pattern instead).

  Inspired by Stripe test-mode + AWS SDK `AWS_SDK_LOAD_CONFIG=0`. Documented in dogfood-stranger Phase 13 (theokit plan `dogfood-fixes-and-coverage-expansion-plan.md` ADR D14).

## [Unreleased — pre-changeset legacy, superseded by the 3.x sections above]

### Added — `THEOKIT_TEST_RESPONSE_OVERRIDE` env var (D14 fault injection)

Deterministic chaos-testing seam at the LLM transport layer. When both
`NODE_ENV=test` AND `THEOKIT_TEST_RESPONSE_OVERRIDE` are set to a JSON string
of shape `{"status": number, "body": object | string}`, every provider client
returned by `resolveProviderChain` short-circuits the real network call and
synthesizes the configured response.

Replaces flaky chaos patterns like "50 parallel requests to force 429" with
zero quota burn + zero network. Composes with credential pools (D123-D133)
and per-provider transports without modification (decorator pattern).

Use cases:

- Inject 429 for rate-limit handling tests
- Inject 5xx for retry / circuit-breaker tests
- Inject 200 with deterministic content for snapshot tests

See `docs.md` § "Test fault injection (v1.22+)" for the full contract,
supported status classes / body shapes, and graceful-degradation semantics.

Implementation:

- `src/internal/llm/fault-injection.ts` — `FaultInjectingLlmClient` decorator
  - parser + activation gate + one-shot stderr warn on malformed JSON
- `src/internal/llm/router.ts` — wraps every resolved client (1-line wire)
- `tests/llm-fault-injection.test.ts` — 12 unit tests (gate negative + active
  per status class + idempotence + name preservation)
- `tests/llm-fault-injection-router-wiring.test.ts` — 3 wiring tests proving
  end-to-end the override reaches `Agent.send` via the router

### Fixed — `Agent.getOrCreate` no longer returns disposed cached agents

Pre-existing race: any caller that did `await agent.dispose()` followed by
`Agent.getOrCreate(sameId, opts)` received the DISPOSED instance from
`Agent.registry`; the subsequent `agent.send()` threw
`"Agent has been disposed"`. Surfaced as 9/48 failures in the telegram-pro
2026-05-28 dogfood (`Remember:`, `/recall`, `/tool uuid`, `/tool roll`,
`/personality coder/poet/none/ghost`, post-personality text).

Fix:

- `LiveAgentRegistry.forget(id)` — new internal helper that removes a cache
  entry WITHOUT calling `dispose()` or `onEvict` (idempotent on unknown ids).
- `LocalAgent.dispose()` now calls `liveAgentRegistry.forget(this.agentId)`
  inside the `disposed = true` block, so a subsequent `Agent.getOrCreate(id)`
  always builds a fresh instance.

Regression tests:

- `tests/agent-registry-cache.test.ts` —
  `dispose() self-evicts so next getOrCreate returns a fresh agent`.
- `tests/internal/runtime/live-agent-registry.test.ts` —
  `forget(id) removes from cache without calling dispose` +
  `forget(id) is idempotent for unknown ids`.

Verified end-to-end by the telegram-pro 2026-05-28 dogfood after the fix:
**47/48 PASS, 1 SKIP (HONCHO_API_KEY env unset), 0 FAIL** (vs 38/48 PASS, 9
FAIL before the fix).

### Added — Auto-populated `RunResult.usage` + `RunResult.cost` (ADRs D375-D388, T4.2 scope-cut lifted)

- `agent.send`-driven runs now expose aggregated token usage on
  `RunResult.usage` (5-bucket `TokenUsage` per D376) and an inferred
  `RunResult.cost` (`CostBreakdown` per D377) automatically. No caller-side
  composition required for the read side — callers still wrap with
  `preflightCheck` / `chargeAndCheckThresholds` for budget enforcement.
- OpenAI / OpenRouter SSE accumulator parses 5 token buckets:
  `prompt_tokens_details.cached_tokens` → `cacheReadTokens`,
  `completion_tokens_details.reasoning_tokens` → `reasoningTokens`, plus the
  top-level `cache_read_input_tokens` /
  `cache_creation_input_tokens` fallback for Anthropic-on-OpenRouter.
- `stream_options: { include_usage: true }` is now sent on every
  Chat Completions request so the final usage chunk arrives reliably.
- Agent loop carries a `UsageAccumulator` per send; each LLM turn merges in,
  the totals land on `AgentLoopOutput.usage` / `AgentLoopOutput.cost`.
- `FixtureScript` extended with `usage?` / `cost?` so non-fixture runs (the
  real local runtime) plumb the values into `RunResult` via
  `buildResult` in `FixtureRunBase` — fixture mode remains unchanged.
- Validated end-to-end against OpenRouter (`openai/gpt-4o-mini`): real
  reply, real tokens (`input=68 output=2`), real cost (`$0.000011 estimated`),
  ledger reconciles bit-identical. Report:
  `.claude/knowledge-base/reviews/budget-dogfood-2026-05-28.md`.

### Added — Task observability registry (ADRs D361-D374, Adoption Roadmap gap #2)

- `Task` namespace (`@theokit/sdk`) exposing static methods `submit`, `list`,
  `get`, `cancel`, `subscribe`, `configure`. Closed 5-state lifecycle
  (`queued | running | finished | error | cancelled`).
- Pluggable `TaskStore` interface + 2 backends — `InMemoryTaskStore` (default,
  transient) and `JsonFileTaskStore` (opt-in, one JSON file per task,
  single-process invariant documented). SQLite backend deferred to v0.2.
- New sub-export `@theokit/sdk/task-store` for cross-process readers
  (the `theokit tasks` CLI consumes this).
- Ring buffer (cap 64) per task for late-attach `subscribe` replay (D372).
- Idempotent cancel — `Task.cancel(id, reason?)` returns
  `{ cancelled, alreadyTerminal }`, never throws.
- Cross-process best-effort cancel via `cancelRequested: boolean` field on
  `TaskHandle`; the CLI writes it, the owning Node process honors it at the
  next checkpoint (EC-7).
- 3 OTel spans via existing telemetry seam (D34): `task.submit`,
  `task.transition`, `task.cancel` (D371). No new peer deps.
- Errors: `InvalidTaskIdError`, `TaskNotFoundError`,
  `UnsupportedTaskOperationError` exported from the main entry.
- Auto-eviction: terminal tasks GC'd after retention (InMemory 1h, JsonFile 7d
  defaults; configurable via `Task.configure({ retentionMs })`).
- 62 SDK tests passing across 6 files. 16 edge cases absorbed (EC-1..EC-16).

### Scope cuts (v1)

- `Agent.send` / `Agent.batch` / `Workflow.run` / `Cron.register` do NOT yet
  accept a `{ task: true }` option — that adapter integration is deferred to
  v0.2 (see plan v1.2). Today: callers compose via
  `Task.submit("kind", async (ctx) => agent.send(prompt, { signal: ctx.signal }))`.
- SQLite cross-process backend deferred to v0.2 — JsonFileTaskStore is
  documented as single-process-only.
- `CloudAgent` task ops throw `UnsupportedTaskOperationError` (D370).

## 1.1.0

### Minor Changes

- Production-readiness for serverless and multi-host deploys (6 gaps from TheoKit cross-repo handoff).

  **Added:**

  - **`ConversationStorageAdapter`** interface + `FileSystemConversationStorage` (default) + `InMemoryConversationStorage`. New `AgentOptions.conversationStorage` opt-in. Postgres + Redis recipes in `docs/recipes/`. Strict resume integrity check via `requiresCustomStorage` marker (D325).
  - **`Agent.registry`** — LRU + idle-timeout GC for live `SDKAgent` instances. `configure / evict / evictAll / size / ids` + `onEvict` listener. Defaults: `maxAgents: 100`, `idleTimeoutMs: 30 min`. Eliminates OOM in 24/7 Node deploys.
  - **`AgentRunErrorCode`** discriminated union (16 codes including `quota_exceeded`, `tool_runtime_error`, `aborted`, `invalid_model`, `safety_blocked`, `provider_unreachable`). Plus `AgentRunError.requestId` / `.conversationId` fields and `.retriable` / `.retryAfterMs` / `.providerError` getters. Anti-leak invariant: `providerError` never in `.message`.
  - **`SendOptions.signal`** propagates end-to-end to LLM `fetch({ signal })`. Tokens stop billing on caller cancel. `anySignal` ponyfill for edge runtimes without native `AbortSignal.any`. `agent.dispose()` fires lifecycle abort. Aborted runs throw `AgentRunError({ code: "aborted" })`; no partial assistant message persists.
  - **`AgentOptions.onToolStart` / `onToolEnd` / `onToolError`** — observation callbacks with `callId` pair correlation + `durationMs`. Hook errors swallowed (do not crash run).
  - **`AgentOptions.onBeforeCreate` / `onBeforeSend`** — admission gates for multi-tenant quota. Errors propagate (NOT swallowed — these are blockers, not observers).

  25 new ADRs (D303-D325). 113 new tests. 3 real-LLM examples in `examples/{conversation-storage,abort-mid-stream,tool-hooks-tracking}/`. Postgres + Redis recipes in `docs/recipes/`. Full `docs.md` sections: Conversation storage, Agent registry lifecycle, Error codes, Cancellation, Tool lifecycle hooks, Quota / abuse hooks.

  **Backward compatibility:** all new fields opt-in with safe defaults. Existing apps (telegram-pro, slack-bot, whatsapp-bot, email-bot, teams-bot, vertex-bot, bedrock-bot, handoffs, workflows, cache, eval, skills-google-workspace) compile and run unmodified.

  Closes Gaps 1-6 of `docs/handoffs/from-theokit/2026-05-25-production-readiness.md`.

## [Unreleased — pre-changeset legacy, superseded by the 3.x sections above]

### Added (`onBeforeCreate` / `onBeforeSend` quota gates — Production-Readiness #6)

Closes Gap 6 of the TheoKit cross-repo handoff. Lets multi-tenant SaaS deploys enforce per-user / per-conversation quotas at the SDK boundary.

- **`AgentOptions.onBeforeCreate`** fires BEFORE the agent is registered or persisted. Receives `{ conversationId, userId? }`. Throwing blocks creation — error propagates as `Agent.create` rejection.
- **`AgentOptions.onBeforeSend`** fires BEFORE each `agent.send` (before LLM call, before storage append). Receives `{ conversationId, previousMessageCount }`. Throwing blocks the send.
- **Errors are NOT swallowed (D322).** Unlike tool lifecycle hooks (observation), quota hooks are admission gates — their throws propagate by design.
- **Order: validate → quota gate → side effects (D323).** Rejected hooks leave zero orphan state on disk or in memory.
- **`onBeforeCreate` skipped on `Agent.registry` cache hit** — caching is per-process, cold-path always runs the hook.
- **ADRs:** D322 (errors propagate), D323 (fire before side effects).
- **Tests:** 8 new in `tests/agent-quota-hooks.test.ts` covering resolve/reject paths, `userId` propagation, no-orphan-on-reject, `previousMessageCount` semantics.

### Added (`onToolStart` / `onToolEnd` / `onToolError` tool lifecycle hooks — Production-Readiness #4)

Closes Gap 4 of the TheoKit cross-repo handoff. Cost tracking, audit log, per-tool retry/alerting without writing a plugin.

- **`AgentOptions.onToolStart`**, **`onToolEnd`**, **`onToolError`** callbacks accepted in `AgentOptions` (top-level — no plugin needed; D315). Familiar `onChunk`/`onFinish`-style callback ergonomics.
- **`callId` propagated** through the start/end (or start/error) pair from the existing `generateCallId()` in dispatch (D316). Consumers correlate without managing their own counter.
- **`durationMs`** measured between start hook fire and end/error hook fire — handler latency.
- **Hook errors swallowed** via single `safeEmitToolHook` chokepoint (D317). Listener throws logged to stderr but never crash the run.
- **`onToolError.event.error` is ALWAYS an `Error` instance** (EC-6 absorbed) — stderr-string-only failures wrapped in `new Error(stderr)`.
- **`attempt: 1`** always in v1 (D317 placeholder — reserved for future tool retry policy).
- **ADRs:** D315 (AgentOptions surface), D316 (callId reuse), D317 (hook errors swallowed — EC-6 absorbed).
- **Tests:** 3 new in `tests/agent-tool-hooks.test.ts` (surface acceptance + listener-throw safety).

### Added (`AbortSignal` end-to-end propagation — Production-Readiness #5)

Closes Gap 5 of the TheoKit cross-repo handoff. Tokens stop billing the moment a caller (browser, route handler, `agent.dispose`) signals cancellation.

- **`SendOptions.signal`** (already typed) now flows from `LocalAgent.send` → `dispatchRun` → `real-local-run.buildLoopInputs` → `AgentLoopInputs.signal` → `streamLlmTurn` → LLM client `fetch({ signal })`. The infrastructure was already in place at every LLM client; only the orchestrator wiring was missing.
- **`LocalAgent.#lifecycleAbortController`**: every agent owns a private controller fired by `dispose()`. `send()` composes `[userSignal, lifecycleSignal]` via `anySignal` so eviction (`Agent.registry.evict`) cancels in-flight LLM calls promptly.
- **`anySignal` ponyfill** (`internal/runtime/abort-utils.ts`) absorbs EC-5: native `AbortSignal.any` when available, ponyfill for edge runtimes that lag. Single-signal short-circuit, undefined entries filtered, abort `reason` propagated.
- **`AgentLoopInputs.signal`** new optional field; loop uses caller's signal when present, never-aborting placeholder otherwise (legacy behavior preserved when nothing wired).
- **Aborted runs surface as `AgentRunError({ code: "aborted", retriable: false })`** (D321 + T3.5 finalization). `err.cause` preserves the original `DOMException`.
- **Aborted runs do not persist partial assistant messages** (D320): the user message persists at entry; the abort path skips the assistant append, preserving conversation history invariant.
- **ADRs:** D318 (signal plumbing), D319 (lifecycle controller composition), D320 (no partial persist), D321 (AgentRunError aborted wrapping), D324 (anySignal ponyfill — absorbed from EC-5).
- **Tests:** 13 new (abort-utils — native + ponyfill + edge cases) + 3 wiring sanity tests. Full real-LLM abort dogfood is part of Phase 7.

### Added/Changed (`AgentRunError` discriminated codes + retryAfterMs + requestId — Production-Readiness #3)

Closes Gap 3 of the TheoKit cross-repo handoff. Makes `AgentRunError` consumer-branchable for proper UX (retry CTAs, billing upsell, cancel suppression) without parsing `.message` strings.

**Added:**

- **`AgentRunErrorCode`** discriminated union (16 codes) exported from `@theokit/sdk`. Supersets `ErrorCode` with non-HTTP origins (`quota_exceeded`, `tool_runtime_error`, `aborted`, `invalid_model`, `safety_blocked`, `provider_unreachable`). Trailing `(string & {})` keeps autocomplete + accepts legacy provider-prefixed strings.
- **`AgentRunError.requestId`** + **`AgentRunError.conversationId`** fields. Provider's `x-request-id` / `request-id` header parsed via `parseRequestId` helper in `internal/errors/mappers/shared.ts`. `conversationId` settable by caller for log correlation.
- **`AgentRunError.retriable`** getter — alias for `isRetryable` (handoff contract; future v2 deprecates `isRetryable`).
- **`AgentRunError.retryAfterMs`** computed getter — `metadata.retryAfter * 1000` so callers compose with `Date.now()` / `setTimeout` directly. Returns `0` (not `undefined`) when provider sent `Retry-After: 0` (EC-11).
- **`AgentRunError.providerError`** getter — aliases `metadata.raw`. Anti-leak invariant: `.message` NEVER contains the raw body (D313).
- **`DispatchResult.errorCode`** field — distinguishes tool dispatch failures: `tool_runtime_error` (handler throw), `invalid_request` (validate failure), `unknown` (registry miss). Consumers mapping DispatchResult → AgentRunError use this directly.
- **`docs/error-codes.md`** standalone reference with provider mapping tables.

**Changed:**

- **OpenAI-compatible mapper** detects HTTP 402 + body `code: "insufficient_quota"` / `"quota_exceeded"` and maps to `invalid_request` (ErrorCode is HTTP-pure per D314 — quota_exceeded at AgentRunError layer).
- **`buildErrorMetadata`** now exposes `parseRequestId` companion for mapper consumption (D314).

**ADRs:** D311 (code union + escape hatch), D312 (retryAfterMs getter), D313 (providerError alias), D314 (mapper priorities).

**Tests:** 20 new in `tests/errors/agent-run-error-fields.test.ts` (all 6 new codes accepted, getters compute correctly, EC-11 zero-retryAfter, anti-leak invariant). 4 new in `tests/tool-dispatch/tool-error-code.test.ts`. 5 new in `tests/internal/errors/mappers/shared.test.ts` for parseRequestId. 2 new in `tests/internal/errors/mappers/openai-compatible.test.ts` for 402 / insufficient_quota.

**Backward compat:** existing `AgentRunError` callers unaffected — new fields are optional, getters compute on demand, `code: string` accepted via `& {}`.

### Added (`Agent.registry` — LRU + idle GC for live agents — Production-Readiness #2)

Closes Gap 2 of the TheoKit cross-repo handoff. Eliminates OOM in 24/7 Node deploys that previously had no eviction for the live agent set (TheoKit's `dev-agent-gc.ts` only ran in dev mode; production servers accumulated agents until heap pressure crashed them).

- **`Agent.registry`** static property exposes the process-wide `LiveAgentRegistry` singleton (ADR D310). Surface: `configure`, `evict`, `evictAll`, `size`, `ids`.
- **LRU eviction** when `size > maxAgents`. Sync `set` path; eviction runs fire-and-forget (caller doesn't await `dispose`).
- **Idle timeout sweep** drops agents whose `lastUsedAt < now - idleTimeoutMs`. Configurable sweep interval (default 60s). `setInterval` is `unref()`'d so it does not keep the event loop alive at process exit.
- **`onEvict(id, reason)`** observability listener. Reason is `"lru" | "idle" | "explicit"`. Listener errors are swallowed with stderr warn (D309 — eviction must not block).
- **Defaults** (ADR D308): `maxAgents: 100`, `idleTimeoutMs: 30 min`, `sweepIntervalMs: 60_000`. Calibrated for indie/small-team deploys. High-traffic SaaS sets larger; `maxAgents: 0` disables the cache entirely.
- **`agent.dispose()` called on every eviction** (D309). Errors caught + swallowed so a stuck dispose doesn't block subsequent evictions.
- **`Agent.getOrCreate` cache hit** (T2.6): consults `Agent.registry.get(id)` before resume/create. `get` refreshes `lastUsedAt` so frequently-used agents resist eviction.
- **EC-4 absorbed**: `set(id, newAgent)` when `id` already maps to a different agent disposes the old before overwriting (prevents leak under racing `getOrCreate` calls). Idempotent when same instance.
- **EC-8 absorbed**: idle sweep re-checks entry identity after the dispose await; a `set` that landed mid-sweep is not deleted.
- **ADRs:** D307 (live vs metadata registry separation), D308 (default tuning), D309 (dispose swallow on eviction), D310 (process-wide singleton).
- **Tests:** 22 new (16 unit + 6 integration). Coverage: LRU recency, refresh saves, dispose-on-overwrite, dispose-error-swallow, idle sweep eviction, onEvict reasons, maxAgents=0 disables cache.

### Added (`ConversationStorageAdapter` — pluggable conversation persistence — Production-Readiness #1)

Closes Gap 1 of the TheoKit cross-repo production-readiness handoff (`docs/handoffs/from-theokit/2026-05-25-production-readiness.md`). Unblocks serverless (Cloudflare Workers, AWS Lambda) and multi-host (K8s replicas, TheoCloud canary) deploys that cannot use the default `<cwd>/.theokit/agents/<id>/messages.jsonl` filesystem persistence.

- **`ConversationStorageAdapter`** interface exported from `@theokit/sdk`. 5 methods (`getMessages`, `appendMessage`, `deleteConversation`, optional `listConversationIds`, optional `compact`, optional `dispose`). Implementations return `Promise<>` uniformly for adapter polymorphism (ADR D306).
- **`FileSystemConversationStorage`** exported. Default when `AgentOptions.conversationStorage` is unset (zero migration — existing apps unaffected). Wraps the pre-D303 byte-identical behavior including redaction (D68) + compaction every 50 appends (D18). Path-traversal guard re-applied in `deleteConversation` (EC-1, ADR D304); ENOENT swallowed in `listConversationIds` for first-run deploys (EC-2).
- **`InMemoryConversationStorage`** exported. `Map<conversationId, StoredMessage[]>` for tests + ephemeral dev. Returns defensive copies from `getMessages`.
- **`StoredMessage`** widened from `user|assistant` to 5 roles (`user|assistant|system|tool_call|tool_result`) for forward compat with tool-shaped messages flowing through the adapter (EC-10, ADR D304). Legacy JSONL files continue to parse — `readSessionFile` filters defensively.
- **`AgentOptions.conversationStorage?`** opt-in field. Backward compatible: undefined → default FS adapter at `local.cwd`.
- **Strict resume integrity (EC-3, ADR D325)** — when an agent is created with a custom `conversationStorage`, the registry stores a `requiresCustomStorage: true` marker. `Agent.resume` throws `ConfigurationError(code: "conversation_storage_required")` if the marker is set and the caller did not pass `conversationStorage` again. Prevents silent FS fallback that would lose Postgres/Redis history.
- **Recipes** at `docs/recipes/conversation-storage-postgres.md` and `docs/recipes/conversation-storage-redis.md`. Both ship Node (pg / ioredis) + Edge (`@neondatabase/serverless` / `@upstash/redis`) flavors. SDK keeps these out of core deps to stay light (ADR D305).
- **Tests:** 33 new tests in `tests/internal/persistence/conversation-storage-*.test.ts` + `tests/agent-conversation-storage.test.ts`. Contract suite runs against both InMemory + FS via `describe.each`. Coverage includes: lazy create, insertion order, 50× concurrent appends, idempotent delete, defensive copy, path-traversal rejection, ENOENT empty list, tool_call/tool_result roles, redaction, FS-restart persistence, EC-3 marker round-trip + strict-resume throw.
- **ADRs:** D303 (main barrel export), D304 (FS default + InMemory primary), D305 (Postgres/Redis as recipes), D306 (Promise-uniform interface), D325 (requiresCustomStorage marker).

### Fixed (`Agent.streamObject` / `Agent.generateObject` provider routing)

- **`StreamObjectOptions.providers?` + `GenerateObjectOptions.providers?`** — new optional field forwarded to the transient agent. Without it, the transient agent infers provider from `model.id` prefix per ADR D186; users running `model: "openai/gpt-4o-mini"` with only `OPENROUTER_API_KEY` set hit `ConfigurationError(provider_unresolved)` because the SDK looks for `OPENAI_API_KEY`. Forwarding `providers: { routes: [{capability:"chat", provider:"openrouter"}], fallback: ["openrouter"] }` routes through OpenRouter as the user expects.
- **Underlying-error surfacing** — when the transient agent fails BEFORE the LLM is called (e.g. `provider_unresolved`), both `StreamObjectError` and `GenerateObjectError` now wrap the original cause with a clear message ("Agent run failed before the model could reply: …") instead of the misleading "The model returned text instead of calling the `output` tool." Pre-fix users saw a tool-call diagnostic for what is actually a config error.
- **Evidence:** real-LLM dogfood `examples/telegram-pro` → `/factstream jazz` failed deterministically with OpenRouter key + `openai/gpt-4o-mini` model. Bot's `/factstream` handler updated to forward `buildProviderRouting()` to `Agent.streamObject({ providers })`. Post-fix: `/factstream` PASSES consistently; full dogfood 40/42 (vs prior 39/42).

### Added (`Agent.prompt` ergonomics — `throwOnError` + `AgentRunError`)

- **`AgentRunError`** — new public error class (extends `TheokitAgentError`). Carries `code`, `provider`, `raw` fields from a failed `RunResult.error`. Exported from the package barrel.
- **`AgentOptions.throwOnError?: boolean`** — opt-in flag (default `false`, non-breaking). When `true`, `Agent.prompt` rejects with `AgentRunError` instead of resolving with `{ status: 'error', error }`. Reduces idiomatic chat-handler snippets from ~10 lines (status branch) to ~6 lines (try/catch). Cancelled status (`'cancelled'`) does NOT throw — cancel ≠ error. Defensive guard skips throw when `result.error === undefined` (malformed RunResult).
- **Tests:** 8 tests for `AgentRunError` shape (instanceof chain, fields, message preservation, cause chaining, barrel export). 7 tests for `throwOnError` semantics including EC-2 (cancelled doesn't throw) + EC-3 (defensive guard).

### Security (defence-in-depth fix in `assertNoSymlinkEscape`)

- **Intermediate-symlink escape closed.** Previous implementation called `lstatSync(path)` only on the **terminal** component. If an intermediate directory in the path was itself a symlink to a location outside `base` (`/project/inner → /outside`), accessing `/project/inner/file.txt` would physically read `/outside/file.txt` and the guard would NOT detect the escape — `lstat` followed the intermediate symlink and reported a regular file. **Fix:** walk to the deepest existing ancestor, `realpathSync` it, then re-attach the lexical suffix; compare against the canonical base. Two new tests pin the fix (terminal-not-yet-created variant included). All 27 existing consumer tests (`agent-session-store`, `persistence/paths`, `lint/no-unguarded-path-input`) remain green.

### Added (`@theokit/sdk/tools` sub-export — built-in tools for coding agents)

**Drop-in toolkit any coding agent on top of `@theokit/sdk` needs without reimplementing: read, list, search, diff, test.**

- **`createReadFileTool({ projectRoot })`** — read a project-relative file as UTF-8. Refuses traversal, sensitive files (`.env*` / `.git/` / `node_modules/` / `.theo/` / lock files), binary files (null-byte detection in first 8 KB; EC-5), and files larger than 5 MB. Returns `{ ok, content, size }` or `{ ok: false, error }`. 12 tests.
- **`createListDirTool({ projectRoot, max? })`** — list direct entries of a project-relative directory. Defaults to a 500-entry cap (EC-6: avoid 5 MB JSON payloads in 10k-file projects). Each entry exposes `{ name, type: 'file' | 'directory' }`. Result includes `{ truncated, totalCount }` so the agent can refine. 8 tests.
- **`createSearchTextTool({ projectRoot, maxMatches?, maxFileSize? })`** — recursive literal-text search. Skips sensitive dirs, binary files, and files larger than 1 MB. Defaults to a 100-match cap. Returns `{ matches: [{ file, line, preview }], truncated, totalMatches }`. 8 tests.
- **`createGitDiffTool({ projectRoot, timeoutMs?, maxStdoutBytes? })`** — `git diff` wrapper. Supports `{ path, cached }` scoping. 30s timeout (kills the whole process group on expiry; EC-7). 5 MB stdout cap. Returns `{ diff, truncated }` or `{ ok: false, error: 'not_a_repo' | 'timeout' | 'git_failed' }`. 7 tests.
- **`createRunVitestTool({ projectRoot, timeoutMs?, maxStdoutBytes? })`** — vitest runner via `npx --no-install vitest`. **EC-12** fix: parser walks stdout bottom-up to extract the last valid JSON line — skips node deprecation warnings that vitest prepends. 120s timeout + process-group kill. Returns `{ ok, summary }` with `{ numTotalTests, numPassedTests, numFailedTests, success }`. Helper `extractTrailingJson` exported for direct testing. 6 tests.
- **Public surface** at `@theokit/sdk/tools`. Tsup entry `tools: "src/tools/index.ts"` produces `dist/tools.js` + `.d.ts`; package.json `exports["./tools"]` resolves both ESM + CJS + types. Sub-export smoke test (`tests/tools/sub-export-smoke.test.ts`) pins the 5 named exports.

44 tests total in `tests/tools/` (12 + 8 + 8 + 7 + 6 + 5 smoke).

### Added (`@theokit/sdk/path-safety` sub-export — path-traversal primitives go public)

- **`safePathJoin`, `assertNoSymlinkEscape`, `PathTraversalError`** now exported from `@theokit/sdk/path-safety`. Previously `@internal`; promoted so consumer agents (TheoKit Studio, cli-bot, future coding agents) can validate user-supplied paths without reinventing the guard. Wire shape is unchanged — same signatures, same `ConfigurationError` code (`path_traversal`).
- **`isForbiddenPath(input)`** — new public primitive shipping the universal sensitive-file blocklist (`.env*` except `.env.example`, `.git/**`, `node_modules/**`, `.theo/**`, lock files). Cross-platform path normalisation (backslashes folded to forward slashes). 15-case test suite covering each blocklist family. Companion error `ForbiddenPathError` (extends `ConfigurationError`, code `forbidden_path`).
- **Dedicated sub-export** (`./path-safety` in package.json `exports`, separate from the main barrel). Architectural choice: the path-guard module reaches into `internal/runtime` via `errors.js`, which participates in a known import cycle `types/agent.ts ↔ fork-agent.ts`. The dedicated sub-export keeps DTS bundling decoupled — without it, rollup-plugin-dts surfaces a fatal "ForkOptions not exported" false positive on the main bundle.
- **Public-API smoke test** (`tests/path-safety-public-api.test.ts`) pins the sub-export so a refactor cannot silently revert these to `@internal`.

### Added (Ollama integration complete — ADRs D182-D190)

**Local-first LLM stack: chat, embeddings, RAG, models discovery, plus LM Studio
and llama.cpp sibling profiles. 100% local, zero remote API keys required.**

- **Ollama builtin provider profile** (D182). `Agent.create({ model: "ollama/llama3.2:3b" })`
  works zero-config after `ollama serve`. `authType: "none"` + sentinel
  `"ollama-local"` Bearer token; local Ollama ignores the Authorization header.
- **`Ollama embedding adapter`** (D183). Sixth entry in `MEMORY_EMBEDDING_ADAPTERS`,
  targets `/v1/embeddings` (OpenAI-compat). Default model `nomic-embed-text`
  (768 dim). First adapter with `transport: "local"` — `transport` union
  extended from `"remote"` to `"remote" | "local"`. Supports `nomic-embed-text`,
  `all-minilm`, `bge-large`, `bge-m3`, `mxbai-embed-large`.
- **`Theokit.models.list({ provider: "ollama" })`** (D184). New optional
  `provider` field on `TheokitRequestOptions` routes to the provider's local
  `/v1/models` endpoint when targeted profile has `authType: "none"`. Cloud
  catalog path unchanged when no `provider` is passed (backward compat).
- **Typed actionable error mapping** (D185). New `mapOllamaTransportError`
  (ECONNREFUSED/ENOTFOUND → "Run \`ollama serve\`") and `mapOllamaHttpError`
  (404 → "Run \`ollama pull <model>\`"; 503 model-loading → retryable). Wired
  into `OpenAIClient` via new optional `providerName` constructor option.
- **Provider inference from model.id prefix** (D186). `model: "ollama/llama3.2:3b"`
  routes to the Ollama profile and sends `llama3.2:3b` as the model name to the
  LLM body. Aligned with OpenRouter / Hermes provider-prefix routing patterns. Aliases
  `llama-cpp`/`llama.cpp` → `llamacpp`, `lm-studio` → `lmstudio`.
- **CredentialPool no-op for `authType: "none"`** (D187). `apiKeys: { ollama: [...] }`
  is silently ignored with one-shot stderr warn instead of building a meaningless
  pool of sentinels.
- **LM Studio builtin profile** (D188). `name: "lmstudio"`, aliases
  `["lm-studio", "lm_studio"]`, default port 1234, `LMSTUDIO_HOST` override.
- **llama.cpp server builtin profile** (D189). `name: "llamacpp"`, aliases
  `["llama-cpp", "llama.cpp"]`, default port 8080, `LLAMACPP_HOST` override.
- **OLLAMA_HOST / LMSTUDIO_HOST / LLAMACPP_HOST baseUrl overrides** wired in
  `selectTransport` (alongside existing `OPENAI_API_BASE_URL` etc.).
- **`OLLAMA_API_KEY`** env var override (optional) for Ollama Cloud or
  reverse-proxy-with-auth setups.
- **Memory.runDreamingSweep accepts `provider: "ollama"`** in its embedding
  union — fully-local dreaming/clustering is now possible.
- **`examples/ollama-hello/`** (D190) — minimal Agent.create + send + stream
  against `ollama/llama3.2:3b`. Zero API keys.
- **`examples/ollama-local-rag/`** (D190) — 100%-local RAG pipeline: embedding
  via `nomic-embed-text`, cosine similarity ranking, context-augmented
  `agent.send` against `llama3.2:3b`. Sample corpus included.
- **Integration tests against real Ollama** (T1.2, T3.1, T5.1) under
  `tests/integration/` with `skipIf` probes — silent when daemon absent,
  proves end-to-end when present. Per `.claude/rules/real-llm-validation.md`.

**Internal: `parseModelId`** sync helper for provider/name splitting; reused by
`buildLoopInputs` and exported from `internal/llm/model-identifier.ts`.

### Added (v1.14 personality-presets — Hermes #26, ADRs D160-D169)

- **`Agent.usePersonality(name, opts?)`** public API on `SDKAgent`
  (#roadmap-row-5). Activates a personality preset for the next `send`.
  Reserved names `none` / `default` / `neutral` clear the active preset.
  Returns the resolved `PersonalityPreset` (or `null` when cleared).
  Cloud agents reject with `UnsupportedRunOperationError` (D169).
- **`PersonalityRegistry`** + **`PersonalityPreset`** re-exported from
  `@theokit/sdk` (read-only). Reads from `<cwd>/.theokit/personalities/*.md`
  (project) + `~/.theokit/personalities/*.md` (user) with project-wins-on-
  collision (D162).
- **Markdown + Zod frontmatter shape** (D161) — `name` (lowercase-only
  slug, EC-C), `description?`, `tools?` (advisory whitelist), `model?`,
  `tags?`, body = system-prompt overlay. Mirrors `.theokit/agents/*.md`.
- **Session-default + persistent-opt-in state** (D163) — in-memory per
  `agentId` by default; `{ save: true }` writes to
  `$THEOKIT_HOME/personality.json`. **EC-B:** clear with save DELETES
  the key (never `"agent-id": null`).
- **Switch lifecycle** (D164) — preserves history by default
  (`{ reset: true }` for opt-in clear), appends user-role transcript
  marker (`[persona switched to <slug>]` or `[persona cleared]`), and
  invalidates the prompt cache via D94 deferred (`reason:
"personality-switch"`).
- **Tool whitelist filter** (D167) — `applyPersonalityFilter` narrows
  the exposed `customTools` set; missing entries log a one-shot warn
  with Levenshtein-distance-≤2 "did you mean" hint. Subtractive only
  (D102 layer 4). MCP-style names (`mcp__server__tool`) matched as
  exact strings (EC-I).
- **Fork inheritance via `AsyncLocalStorage`** (D168) — fork captures
  the parent's active slug **at construction time** as a primitive
  snapshot (EC-A). Parent mid-flight `usePersonality` does NOT mutate
  the fork's voice. `usePersonality` inside a fork = no-op + one-shot
  warning.
- **CloudAgent.usePersonality** throws `UnsupportedRunOperationError`
  synchronously (D169, matches D122 pattern).

### Added (v1.13 context-files-coverage — ADRs D150-D159)

- **`FileContextManager` auto-discovery extended** beyond `.theokit/context/*.md`
  to the 2026 industry-standard set:
  - `AGENTS.md` — Linux-Foundation-stewarded, 60k+ repo adoption.
  - `CLAUDE.md` — Anthropic's house format, walk-up + `@import` syntax.
  - `GEMINI.md` — Google Gemini CLI, same shape as CLAUDE.md.
  - `.cursor/rules/*.mdc` — Cursor's current format with frontmatter
    (globs/description/alwaysApply); legacy `.cursorrules` deliberately
    skipped (deprecated by Cursor itself).
  - `.theokit/THEO.md` — new SDK-specific override file (D153 placed
    inside `.theokit/` for zero root pollution).
- **Walk-up-to-git-root discovery** (D151) — pure `existsSync` checks,
  no `.gitignore` parsing (EC-A KISS), no `.theokitignore` (EC-B scope
  creep dropped). `realpathSync` dedupes symlink chains (EC-F). Git
  worktrees work via `.git` as a file (EC-N).
- **`@path` import resolver** (D156) — Anthropic/Gemini convention,
  5-hop cap with cycle detection. EC-D: every imported file capped at
  `maxBytesPerFile` BEFORE concatenation (prevents balloon from
  multi-import). EC-Q: line-anchored (`^@\S+$`), inline references
  preserved.
- **MDC parser** (D154) — YAML frontmatter (`globs`/`description`/
  `alwaysApply`), in-house glob → regex (no `minimatch` dep). EC-I: at
  `agent.send()` time `touchedFiles=[]`, so only `alwaysApply: true`
  rules activate in v1.
- **Aggregate cap** (D155) — per-file 40_000 chars + total 120_000
  chars. 70/20 head/tail truncation with `…[truncated by theokit]`
  marker. EC-C guard: if `max ≤ MARKER.length`, return head-only slice
  without marker. EC-J: same-priority sort tie-breaks by source path lex
  for prompt-cache stability.
- **EC-E privacy fix** — disambiguation uses `relative(gitRoot ?? cwd,
dirname(path))` for source names, NEVER absolute paths. Prevents
  developer home dir / project name from leaking into LLM provider
  logs.
- **Telemetry counters** (D159) — `context_files_truncated` (per-file)
  - `context_files_total_truncated` (aggregate drop). Lazy `tracer`
    lookup via `globalThis.__theokit_tracer`; no-op when OTel not
    installed (EC-L).
- **Backward compat** (D158) — existing `.theokit/context/*.md` Zod
  frontmatter sources keep working unchanged. Legacy `.theokit/
context.json` loads CONTENT and emits one-time deprecation warning
  (EC-K verified).
- **Public API additions** in `AgentOptions.context`:
  - `maxBytesPerFile?: number` (default 40_000)
  - `maxBytesTotal?: number` (default 120_000)

### New internal modules

- `internal/runtime/context-discovery.ts` — DiscoverySpec + `findGitRoot`
  - `walkUpForFile` + `walkUpForGlob`.
- `internal/runtime/context-loaders.ts` — `loadPlainMarkdown` +
  `truncateWithMarker`.
- `internal/runtime/context-import-resolver.ts` — `resolveImports`
  with 5-hop + cycle detection + per-import cap.
- `internal/runtime/context-mdc-parser.ts` — MDC frontmatter parser +
  `shouldActivate`.
- `internal/runtime/context-aggregator.ts` — `applyAggregateCap`.
- `internal/runtime/context-discovery-runner.ts` — orchestrator over
  all specs.

### Test counts

- 1062 → **1132 PASS** baseline + **70 new tests** across:
  - `context-discovery.test.ts` (17)
  - `context-loaders.test.ts` (15)
  - `context-import-resolver.test.ts` (12)
  - `context-mdc-parser.test.ts` (8)
  - `context-aggregator.test.ts` (7)
  - `context-manager-multi-format.test.ts` (11)
  - `context-backward-compat.test.ts` (5) — 5 regression
- 10 new ADRs (D150-D159).
- CLAUDE.md SDK Roadmap row #4 → ✅ DONE.

---

### Added (v1.12 memory-provider-adapters — ADRs D141-D149)

- **`packages/sdk/src/types/memory-adapter.ts`** — public `MemoryAdapter`,
  `MemoryContext`, `MemoryFact`, `MemoryId`, `MemoryRevision`,
  `MemoryAdapterCapabilities`, `AgentMemory`, `MemoryToolSchema`,
  `MemoryTurnMessage` types. `mkMemoryId(provider, raw)` +
  `extractRawId(id, expected)` enforce cross-adapter id integrity
  (EC-B: prevents `mem0.delete(supermemoryId)` footgun).
- **`packages/sdk/src/errors.ts`** — new public `MemoryAdapterError`
  - finite `MemoryAdapterErrorCode` literal union (`"auth_failed"`,
    `"rate_limited"`, `"not_found"`, `"network"`, `"invalid_input"`,
    `"unknown"`).
- **`packages/sdk/src/internal/plugins/types.ts`** — narrows
  `MemoryProviderFactory` return type from `unknown` to
  `MemoryAdapter | Promise<MemoryAdapter>`. Adds `PreUserSendContext`,
  `PreUserSendResult`, `PostAssistantReplyContext` interfaces and
  the two new `HookName` entries.
- **`packages/sdk/src/internal/plugins/manager.ts`** —
  `runPreUserSendHooks(ctx, maxBytes)` concatenates handler results,
  caps at `maxRecallContextBytes` (EC-A), isolates per-handler
  failures to stderr. `runPostAssistantReplyHooks(ctx)` fire-and-forget.
- **`packages/sdk/src/internal/runtime/local-agent.ts`** wires the new
  hooks: `pre_user_send` injects `<memory-context>` fence around the
  prompt (EC-G safe — only injected fence is trimmed); `post_assistant_reply`
  fires after `run.wait()` via a wrapped `Run` proxy.
- **`packages/sdk/src/internal/runtime/local-agent-memory-direct.ts`**
  — `buildAgentMemory(pluginManager, cwd, defaultCtx)` builds the
  `agent.memory.{write,recall,delete}` direct API. Lazy initialize
  (EC-I, fires once on first call). Multi-adapter fan-out for writes;
  merge + dedupe by content for recalls.
- **`packages/sdk/src/types/agent.ts`** — extends `AgentOptions` with
  `memoryContext` + `maxRecallContextBytes`; `SDKAgent` interface with
  `memory: AgentMemory`. `SendOptions.signal: AbortSignal` for EC-H.

### New workspace packages

- **`@theokit/memory-supermemory@0.1.0`** — Supermemory wrapper
  (`supermemory@^4.21`, zero-dep MIT). EC-C identifier sanitization
  on every containerTag component.
- **`@theokit/memory-honcho@0.1.0`** — Honcho wrapper
  (`@honcho-ai/sdk@^2.1`). EC-D session namespaced under userId to
  prevent cross-user leak. AGPL self-host disclosure in README.
- **`@theokit/memory-mem0@0.1.0`** — Mem0 cloud-only wrapper (D148:
  no OSS local mode). Unique `history(id)` capability. Circuit
  breaker (EC-K: 429 does NOT trip). CVSS 8.1 disclosure in README.

### Test counts

- 1032 → **1062 PASS** baseline + 9 new memory-adapter tests in SDK
  (memory-adapter contract + aggregation + dispatch + direct API).
- Adapter packages: Supermemory 21/21, Honcho 17/17, Mem0 18/18 =
  **56 adapter-package tests**.
- 9 new ADRs (D141-D149).
- 3 real-LLM examples (`examples/memory-*-basic`).
- CLAUDE.md SDK Roadmap row #3 (Memory Providers, score 7) → ✅ DONE.

---

### Added (v1.11 batch-processing — ADRs D134-D140)

- **`Agent.batch(prompts, options)`** — new static method on the `Agent`
  façade. Runs N prompts in parallel with bounded concurrency, isolated
  per-prompt failures, optional `onResult` / `onProgress` callbacks, and
  `AbortSignal` support. Default concurrency 4 (D136); capped to
  `prompts.length` to avoid idle workers.
- **`packages/sdk/src/batch.ts`** — `batchImpl(prompts, options, deps)`
  core. Builds shared `CredentialPool` instances ONCE from
  `options.providers.apiKeys` and wraps the entire batch in
  `withCredentialPool(pools, ...)` (ALS) so every in-flight agent
  observes the SAME pool — one 429 cools the key down once, not N
  times (EC-A fix, D138).
- **`packages/sdk/src/types/batch.ts`** — public types: `BatchItem`,
  `BatchOptions extends AgentOptions`, `BatchResult` (discriminated
  union by `ok`), `BatchProgress`. Re-exported from `types/index.ts`.
- **`packages/sdk/src/trajectory-helpers.ts` + `types/trajectory.ts`** —
  opt-in `toShareGptTrajectory(result, options?)` helper for fine-tuning
  dataset generation (D139). Pure transformation; returns `null` for
  failed results so callers can `.map(...).filter(Boolean)`.
- **`packages/sdk/src/internal/runtime/async-semaphore.ts`** — in-house
  N-permit FIFO semaphore (~50 LoC). No `p-limit` / `p-queue` dependency
  added (D135). `createSemaphore(permits)` throws `ConfigurationError`
  on zero / negative / non-integer.
- **Router wiring** (`internal/llm/router.ts`) — `buildClient` now
  consults `currentCredentialPool(name)` (ALS) before building a fresh
  pool from `routerOptions.apiKeys`. Backward compatible: outside an
  ALS scope, the existing per-agent pool path is unchanged.

### Tests added

- `tests/batch.test.ts` — 18 RED → GREEN (empty, parallel, concurrency,
  failure isolation, order preservation, callbacks, abort, EC-A pool
  reference, EC-C pre-aborted, EC-D `signal.reason`, EC-B slow
  `onResult` parallel timing).
- `tests/batch.property.test.ts` — 5 fast-check properties × 200 runs
  each (1000+ randomized assertions): input order under random delays,
  no prompt loss, failure isolation, filter discipline, bounded
  concurrency.
- `tests/agent-batch-wiring.test.ts` — 3 façade integration tests
  (Agent.batch exists, empty array, BatchItem metadata round-trip).
- `tests/integration/batch-with-pool.test.ts` — 3 integration scenarios
  with 2-key pool + concurrency=2.
- `tests/trajectory-helpers.test.ts` — 14 tests (EC-11..EC-14, EC-F
  malformed messages, tool_use → tool_calls, completed=true).
- `tests/internal/runtime/async-semaphore.test.ts` + `.property.test.ts`
  — 9 unit + 3 properties × 200 runs (FIFO, peak in-flight bounded,
  release idempotent).

### Test counts

- 1021 → **1032 PASS** baseline + batch surface in 7 new test files
  (55 new tests + 1600 randomized fast-check assertions).
- 7 new ADRs (D134-D140).
- CLAUDE.md SDK Roadmap row #2 (Batch Processing, score 8) → ✅ DONE.

---

### Added (v1.10 credential-pools — ADRs D123-D133)

- **`internal/llm/credential-pool.ts`** — same-provider key rotation primitive
  (CredentialPool class, 4 strategies: fill_first/round_robin/least_used/random,
  ADRs D123-D124, D128).
- **`internal/llm/credential-pool-types.ts`** — `PooledCredential`,
  `CredentialPoolSnapshot`, `CredentialPoolStrategy`, cooldown ladder constants
  (D125).
- **`internal/llm/credential-pool-context.ts`** — `withCredentialPool` /
  `currentCredentialPool` AsyncLocalStorage scope for fork inheritance (D131).
- **`internal/llm/pool-aware-client.ts`** — composition wrapper over `LlmClient`
  (D127) with retry-then-rotate on 429 (D126), immediate rotate on 402/401,
  propagate on 5xx/NetworkError. EC-A: persistence failures during rotate
  degrade to in-memory; do not abort the stream. EC-D: buildClient errors
  propagate without marking pool entry exhausted.
- **`internal/persistence/credential-pool-store.ts`** — JSON persistence
  (`$THEOKIT_HOME/credential-pool.json`) with D62 versioned envelope, D61
  cross-process file lock, lazy load + 200 ms debounced write (D129).
- **`errors.ts`** — new public `CredentialPoolExhaustedError` (D133).
- **`types/providers.ts`** — extends `ProviderRoutingSettings` with optional
  `apiKeys: Record<string, string[]>` + `credentialPoolStrategy:
Record<string, CredentialPoolStrategy>` (D130).
- **Router wiring** (`internal/llm/router.ts`) — `buildClient` branches on
  pool presence: ≥2 effective keys → wrap in `PoolAwareLlmClient`; 0/1 → existing
  single-key fast path (D132 backward compat). EC-B: warn once per unknown
  provider in apiKeys config. Empty strings filtered.
- **`validate-agent-options.ts`** — EC-J ambiguity check: `apiKey` +
  `apiKeys[provider]` together throws `ConfigurationError(code:
"credential_pool_ambiguous")` with an educative message.

### CI gates

- **`tests/lint/no-unredacted-pool-token.test.ts`** — bans `.accessToken`
  outside the credential-pool module (and the MCP OAuth allowlist).
- **`tests/internal/llm/credential-pool.property.test.ts`** — 5 strategy
  invariants × 200 fast-check runs = 1000+ randomized assertions.

### Test counts

- 960 → **970 PASS** (+10 new wire tests). With property + lint + integration:
  total Phase 5 footprint adds ~55 tests.
- 11 new ADRs (D123-D133).
- CLAUDE.md SDK Roadmap row #1 (Credential Pools, score 9) → ✅ DONE.

---

### Added (v1.9 background-work-block-completion — ADRs D110-D122)

- **`internal/runtime/async-local-storage.ts`** — per-fork tool whitelist
  via `AsyncLocalStorage<Set<string>>` (ADR D111). Public helpers:
  `withToolWhitelist(set, fn)`, `currentToolWhitelist()`,
  `checkToolWhitelist(toolName)`. Parallel forks observe their own
  whitelist; nested `withToolWhitelist` shadows the outer set (EC-F).
- **`internal/runtime/fork-agent.ts`** — fork primitive (ADRs D110-D114):
  - `forkAgentImpl(parent, options, deps)` — inherits parent system
    prompt byte-identical (D112 — cache hit), credentials, model;
    overrides `agentId`, `skills`, `metadata.forkOrigin`
  - `filterMemoryPlugins(unknown)` — EC-B fix: preserves
    `kind: "memory"` plugins so fork can write memory with provenance;
    drops general/model-provider (redundant per-fork re-init)
  - `LocalAgent.fork(options)` shorthand instance method
- **`internal/judge/`** — judge primitives (ADRs D119-D121):
  - `types.ts` — `Verdict` enum (`done | continue | skipped`),
    `JudgeResult` interface
  - `parse-verdict.ts` — pure prefix matcher with fail-safe `continue`
    (ADR D121). Strict case-sensitive; documents EC-E (BOM trimmed,
    U+200B not)
  - `judge-call.ts` — `judgeCallImpl(ctx, opts, deps)` instantiates aux
    agent (default `openai/gpt-4o-mini` via `OPENROUTER_API_KEY`,
    `tools: []`, EC-A single-env-source); always disposes; folds errors
    into fail-safe `JudgeResult`
  - `verify-side-effect.ts` — `verifyClaim<T>(claims, oracle)`
    hallucination-gate helper, generic over claim type
- **`types/goal-events.ts`** — `GoalEvent` discriminated union (5
  variants, ADR D115), `GoalResult` return value, `GoalOptions`
  configuration (ADRs D117 AbortSignal, D119 judge model defaults).
- **`internal/runtime/run-until.ts`** — Ralph loop (ADR D116
  `AsyncGenerator<GoalEvent, GoalResult, void>`):
  - Yields `status_change: active` + per-turn events + final
    `status_change: completed | failed | paused`
  - EC-C: pre-aborted signal yields only `[paused]` (no preceding
    `active`)
  - EC-D: `maxTurns: 0` is supported (vacuous active → failed)
  - Counts consecutive judge parse failures; bails at
    `maxConsecutiveJudgeFailures` (default 3)
  - `LocalAgent.runUntil(goal, options)` instance method
- **Public API** — `GoalEvent`, `GoalResult`, `GoalOptions`, `Plugin`
  `kind: "memory"` Extract, re-exported via `packages/sdk/src/index.ts`.
- **`AgentOptions.metadata?: Record<string, unknown>`** — new optional
  field, used by fork (`metadata.forkOrigin` / `metadata.parentAgentId`)
  and judge (`metadata.forkOrigin: "judge"`) for downstream attribution.

### Changed (background-work-block-completion)

- `internal/agent-loop/tool-dispatch.ts:dispatchSingleCall` — whitelist
  gate fires FIRST (before plugin pre_tool_call hook and file hooks).
  A tool not in the fork's `allowedTools` returns a `tool_result` with
  `"Tool blocked by fork whitelist"` content; agent narrative continues
  unimpeded. Cost: one import + one branch (microseconds per call).
- `types/run.ts:RunOperation` — gains `"runUntil"` and `"fork"` so
  `UnsupportedRunOperationError` on CloudAgent for these surfaces
  satisfies type narrowing (ADR D122).
- `CloudAgent.runUntil()` / `CloudAgent.fork()` — throw synchronously
  with explicit messaging; documented as EC-G (sync throw despite
  AsyncGenerator return type).

### CI gates

- **`tests/lint/no-global-tool-whitelist.test.ts`** — regex grep
  test enforcing AsyncLocalStorage as the only path for per-fork
  whitelist; bans `let _toolWhitelist`-style declarations.
- **`tests/internal/judge/parse-verdict.property.test.ts`** —
  4 properties × 200 fast-check runs = 800 randomized invariant
  assertions.
- **`tests/internal/runtime/async-local-storage.property.test.ts`** —
  200 fast-check runs verifying parallel-fork whitelist isolation.

### Edge-case review (referenced from `.claude/knowledge-base/plans/background-work-block-completion-plan.md` v1.1)

- **EC-A (MUST FIX)**: judge defaults to `OPENROUTER_API_KEY` (single
  source). No multi-provider auto-detect — caller passes
  `judgeApiKey` for Anthropic-only or direct-OpenAI envs.
- **EC-B (MUST FIX)**: `filterMemoryPlugins` preserves memory plugins
  in fork; drops other kinds.
- **EC-C (SHOULD TEST)**: pre-aborted signal yields paused only.
- **EC-D (SHOULD TEST)**: `maxTurns: 0` test covered.
- **EC-E (SHOULD TEST)**: parseVerdict + BOM/ZWSP edge documented.
- **EC-F (SHOULD TEST)**: nested `withToolWhitelist` shadow test.
- **EC-G/H/I/J (DOCUMENT)**: cloud sync throw, whitelist case
  sensitivity, mid-iteration dispose, judge whitelist inheritance.

### Test counts

- 853 → 911 (+58 new tests; 1000+ fast-check runs).
- 13 new ADRs (D110-D122).
- Background work block: **3/3 ✅**. SDK roadmap totals: **19 → 22 (96%)** DONE.

---

### Added (v1.8 plugin-extension-block-completion — ADRs D97-D109)

- **`internal/plugins/`** — full Plugin contract (ADRs D97-D101):
  - `types.ts` — `Plugin` discriminated union (`general`/`model-provider`/`memory`),
    `PluginContext`, `HookName` (8 fixed hooks), `definePlugin` helper
  - `context.ts` — `createPluginContext()` with dev-mode Proxy seal (D99) +
    `ctx.on()` defense-in-depth against non-function handlers (EC-2)
  - `manager.ts` — `PluginManager` with `initialize` (once), dispatch by
    kind, `runPreToolCallHooks` (first-block-wins, D101); EC-4 duplicate
    plugin name surfaces stderr warn
  - `lifecycle.ts` — `runFireAndForgetHooks` + `runTransformHooks` (EC-6:
    null replaces; undefined keeps current)
- **`internal/tool-registry/`** — 3-layer tool surface (ADRs D102-D104):
  - `registry.ts` — `ToolRegistry` central + `ToolEntry` (with checkFn,
    requiresEnv, emoji, maxResultSizeChars)
  - `toolset.ts` — flat-list `Toolset` + `resolveToolset`/`resolveToolsetStrict`
    (EC-7: duplicates kept, caller dedups)
  - `check-fn-cache.ts` — 30s TTL per tool name + `requiresEnv` check
    (EC-8: concurrent Promise.all idempotent)
  - `result-cap.ts` — `applyResultCap` (default 100k chars)
- **`internal/providers/`** — provider-as-plugin (ADRs D105-D107):
  - `types.ts` — `ProviderProfile` data-only (D105), `ApiMode` literal union
  - `registry.ts` — `registerProvider`/`getProviderProfile`/`listProviders`
    - EC-5 alias collision warn
  - `builtin/{anthropic,openai,openrouter,gemini}.ts` — 4 profiles
    migrated from hardcoded switch
  - `discovery.ts` — lazy scan of `~/.theokit/plugins/model-providers/`
    via `pathToFileURL` (EC-9 Node 22 ESM support)
- **Public API** — `Plugin`, `PluginContext`, `HookName`, `definePlugin`,
  `ProviderProfile` re-exported via `packages/sdk/src/index.ts`.

### Changed (plugin-extension-block-completion)

- `internal/llm/router.ts:buildClient` — consults `getProviderProfile`
  - `selectTransport(apiMode)` instead of hardcoded switch (T4.3).
    EC-3: unsupported apiMode throws `transport_unavailable` with
    actionable message. EC-10: `envVars` ordered fallback (OPENROUTER_API_KEY
    then OPENAI_API_KEY for OpenRouter).
- `LocalAgent.initialize` — wires `pluginManagerCode.initialize(codePlugins)`
  via `extractCodePlugins` filter (EC-1 discriminates legacy `{ enabled }`
  metadata from new `Plugin[]`); telegram-pro + 7 examples continue to
  compile + run unchanged (D108).
- `agent-loop/tool-dispatch.ts` — invokes plugin `pre_tool_call` hooks
  BEFORE file-based hooks (T4.2). Author intent (code plugin) wins
  early over operator policy (file hooks).
- `real-local-run.ts` — `buildCustomToolsInput` concatenates plugin tools
  onto the effective tool catalog without replacing user-supplied tools.

### Fixed (plugin-extension-block-completion)

- Closes Plugin & extension block of the SDK Patterns Roadmap:
  `plugin-contract-design` (❌ → ✅), `tool-registry-pattern` (⚠️ → ✅),
  `provider-as-plugin` (❌ → ✅). Roadmap totais 16 → 19 (83%) DONE.
- Adding a new provider now requires zero code changes in `packages/sdk/`
  — publish `@theokit-provider-X` with a `ProviderProfile` and drop in
  `~/.theokit/plugins/model-providers/X/index.mjs`.

### Added (v1.7 agent-core-loop-completion — ADRs D86-D96)

- **`internal/tool-dispatch/repair-middleware.ts`** — `repairToolCall`
  applies 3 idempotent repairs (case-insensitive name match,
  JSON-string-args parse, type coercion against schema). Fixes 10+
  provider-specific failure modes catalogued in `sdk-references/
tool-call-failure-recovery.md` (Hermes v0.2 #444, v0.3 #1300,
  v0.8 #5265, etc.).
- **`internal/tool-dispatch/strip-think.ts`** — `stripThinkBlocks`
  removes `<think>...</think>` chain-of-thought from LLM responses
  BEFORE they enter the message history. Prevents prompt-cache
  invalidation with DeepSeek-R1, Qwen-QwQ providers (Hermes v0.2 #174).
- **`internal/tool-dispatch/dispatch.ts`** — `dispatchToolWithRepair`
  validate-then-execute wrapper. NEVER throws; all errors return as
  `DispatchResult { isError: true }` so the LLM can self-correct
  (ADR D89).
- **`internal/runtime/budget.ts`** — `IterationBudget` class with
  iteration cap + compression cap (default 3) + grace-call semantics.
  Closes the 4 compression death spirals Hermes shipped (v0.4 #1723,
  v0.7 #4750, v0.11 #10065, v0.11 #10472). EC-4: NaN-safe `consume`.
- **`internal/runtime/validate-response.ts`** — detects empty-content +
  zero-toolCalls as a model-bailout signal.
- **`internal/runtime/compression-helpers.ts`** — `selectCompressionWindow`
  (preserve recent N) + `assertCompressionReduced` (≥10% floor, ADR D92).
- **`internal/cache-discipline-guard.ts`** — dev-mode warns when system
  prompt / toolset / history mutates mid-conversation. Zero production
  overhead via `shouldGuard()` function (EC-1: not module-init constant).
- **`Agent.invalidateCache(reason, options?)`** public API (ADR D94).
  Default deferred — applied at next `agent.send()`. `{ applyNow: true }`
  disposes immediately.
- **CI lint gate** `tests/lint/no-history-mutation-outside-loop.test.ts`
  (ADR D85 mirror) — prevents `ctx.messages.push` outside `agent-loop/`.
  EC-8: bounded by contextual prefix to avoid false positives.
- **Adversarial property tests** via fast-check (1400+ random inputs):
  - `repair-middleware.property.test.ts` (4 properties × 200 runs)
  - `budget.property.test.ts` (3 properties × 200 runs)
- **`internal/agent-loop/strip-think-wiring.test.ts`** — integration
  test with mock LLM client validating strip-think wiring end-to-end
  (T7.2 / EC-2 fix).

### Changed (agent-core-loop-completion)

- `agent-loop/loop.ts` uses `IterationBudget` instead of a bare counter
  (T4.2, ADRs D90-D91). Grace call permits one final iteration after
  budget exhausted.
- `agent-loop/loop.ts` strips `<think>` blocks via `stripThinkBlocks`
  in `streamLlmTurn` before text returned (T4.1, ADR D96).
- `agent-loop/tool-dispatch.ts` applies `repairToolCall` before the
  registry lookup (T4.1, ADRs D86-D88). Repairs surface via telemetry
  span attribute `tool.repairs`.
- `LocalAgent` consumes pending invalidation at the start of every
  `sendLocked` via `consumePendingInvalidation()`. EC-7: failure path
  clears pending state so refresh doesn't get stuck retrying.

### Fixed (agent-core-loop-completion)

- Closes Agent core loop block of the SDK Patterns Roadmap:
  `prompt-cache-discipline` (📚 → ✅), `tool-call-failure-recovery`
  (❌ → ✅), `compression-death-spiral` (❌ → ✅). Roadmap totals
  13 → 15 (65%) DONE.

### Added (v1.6 security-block-completion — ADRs D79-D85)

- **`internal/security/path-guard.ts`** is the canonical module for
  path defense (ADR D79). Exports `safePathJoin` (resolve-then-check,
  ADR D80), `assertNoSymlinkEscape` (realpath-based chain resolution),
  `sanitizeIdentifier` (strict grammar `^[a-z0-9][a-z0-9-_]*$`, ADR D81),
  and `PathTraversalError extends ConfigurationError` with code
  `path_traversal` (ADR D65 — no new error hierarchy).
- **`internal/persistence/exclusive-create.ts`** exports `createExclusive`
  using O_EXCL semantics (ADR D82). Default mode `0o600` (owner-only) —
  EC-2 fix prevents world-readable token/lock files under typical
  umask 022.
- **`internal/persistence/sqlite-cas.ts`** exports `casUpdate` for
  optimistic concurrency in SQLite-backed stores (ADR D83). Canonical
  `UPDATE ... WHERE version = ?` pattern from Hermes `kanban_db.py`.
- **CI lint gate** `tests/lint/no-unguarded-path-input.test.ts`
  (ADR D85) prevents regression by flagging any new
  `join(cwd, ".theokit", ..., varName)` callsite that doesn't use
  `safePathJoin` or `sanitizeIdentifier`.
- **Adversarial property tests** for `safePathJoin` + `sanitizeIdentifier`
  via `fast-check` (~1200 random inputs across 6 properties).

### Changed (security-block-completion)

- `plugins-manager.assertEntryFileExists` now uses canonical
  `safePathJoin` (replaces inline T3.2 guard from
  markdown-config-migration). Error code `plugin_entry_escape` →
  `path_traversal`.
- `agent-session-store.sessionFilePath` validates `agentId` via
  `sanitizeIdentifier` (maxLen 128) + `safePathJoin`. Local
  `agent-<uuid>`, cloud `bc-<uuid>`, and bot IDs like
  `tg-dogfood-chat-A` pass natively.
- `skills-manager.refresh` wraps `entry.name` joins with
  `safePathJoin` + `assertNoSymlinkEscape` (defense-in-depth against
  hostile symlinks inside `.theokit/skills/`).
- `legacyMemoryJsonPath` (memory/types.ts) sanitizes `namespace`,
  `scope`, `userId` before joining. `storePath` (programmatic) bypasses
  sanitization (trusted).
- `mcp/client.ts` resolves stdio MCP `cwd` field via `safePathJoin`
  for relative paths; absolute paths trusted.

### Fixed (security-block-completion)

- Closes the Security block of the SDK Patterns Roadmap:
  `path-traversal-vectors` (❌ PENDING → ✅ DONE) and
  `toctou-race-prevention` (⚠️ PARTIAL → ✅ DONE). Roadmap totals
  11 → 13 DONE (57%).

### Added (v1.5 markdown-config-migration — ADRs D74-D78)

- **`.theokit/hooks/<name>.md`** is the new canonical format for hooks
  (ADR D74). One file per hook with YAML frontmatter (event, matcher,
  command, enabled, priority, timeoutMs) + optional markdown body for
  rationale prose. Mirrors `skills/<name>/SKILL.md`.
- **`.theokit/context/<name>.md`** is the new canonical format for
  context sources (frontmatter: name, path, enabled, maxTokens).
- **`.theokit/plugins/<name>/PLUGIN.md`** replaces `plugin.json` per
  plugin (frontmatter: name, version, capabilities, entry).
- **Zod schemas** type each frontmatter category (HookFrontmatter,
  ContextSourceFrontmatter, PluginFrontmatter — ADR D76). Schema
  errors surface as `ConfigurationError` with typed codes
  (`hook_frontmatter_invalid`, etc.), same pattern as D10
  SkillFrontmatter.
- **Path-traversal guard** on plugin `entry` (T3.2, EC-1 MUST FIX
  from edge-case review): rejects `..` segments and absolute paths
  with `plugin_entry_escape` code. Closes a latent security gap that
  predated the markdown migration.
- **`theokit-migrate-config` CLI** in `packages/sdk/bin/` (ADR D78,
  espelha D44 `theokit-migrate-memory`). Converts legacy JSON to MD
  with timestamped `.bak` backups, atomic writes per file, pre-flight
  abort on existing MD destination.
- **`atomicWriteText` helper** in `internal/persistence/atomic-write.ts`
  (T4.1, EC-2 MUST FIX). Same `tmpfile + rename` crash-safety as
  `atomicWriteJson`, with auto-mkdir of parent dir.

### Changed (markdown-config-migration)

- **`parseSimpleYaml` return type widened** to
  `Record<string, string | number | boolean | string[] | undefined>`.
  Empty values now coerce to `undefined` so Zod `.optional().default(...)`
  applies correctly (EC-3 fix). Skills and subagents loaders adapted
  with narrow helpers (zero behavior change in their schemas).
- **`HooksExecutor.initialize` + `loadProjectHooks`** delegate to new
  shared `loadHookConfig(cwd)` in `internal/runtime/hooks-source.ts`.
  Tries `.theokit/hooks/` first; falls back to `hooks.json` with
  one-time stderr deprecation warn (ADR D77).
- **`FileContextManager.refresh`** uses the same MD-first chain. Same
  fallback + warn semantics.
- **`PluginsManager.refresh`** detects `PLUGIN.md` per folder before
  `plugin.json`. Warns on the JSON path; warns on conflict
  ("both files detected — using markdown").
- **`telegram-pro` example** migrated: `.theokit/hooks/shell-policy.md`
  - `.theokit/context/bot-readme.md` replace the legacy JSONs.
    `workspace-seeds.ts` writes the MD files (idempotent via `ensureFile`).
    The seed-only `plugins.json` (never consumed by the SDK) was removed.

### Deprecated (markdown-config-migration)

- `.theokit/hooks.json`, `.theokit/context.json`,
  `.theokit/plugins/<name>/plugin.json` — emit a one-time stderr warn
  on each call to the loader. **Deprecated in v1.5 (warn). Removed in
  v2.0 (planned Q2 2027)** — users must migrate via
  `theokit-migrate-config` before v2.0 ships.

### Added (v1.3 secret-redaction-discipline — Security block 1/2 patterns)

- **`Security` public namespace** (ADR D68). New top-level export `Security.addPattern(re: RegExp)` registers custom redaction patterns for org-internal token shapes. Additive — built-in patterns cannot be removed. Throws if `/g` flag is missing.
- **Canonical secret redactor** in `internal/security/redact.ts` (ADR D68/D71). 12 builtin credential patterns (OpenAI/Anthropic `sk-*`, GitHub PAT classic + fine-grained, GitLab, AWS `AKIA`, Google `AIza`, Slack `xox*-`, Sentry `sntrys_`, Stripe `sk_live_` / `rk_live_`) plus parametric `key=value` matcher (Authorization Bearer, access_token, api_key, password, x-api-key) plus dedicated Bearer pattern. Two-bucket masking: short tokens (<18 chars) → `***`; longer → `prefix...suffix` for debuggability.
- **Env opt-out: `THEOKIT_REDACT_SECRETS`** (ADR D69/D70). Default ON. Set to `"false"`/`"0"`/`"no"`/`"off"` to disable; SDK emits one-time stderr warning. Env var snapshotted at module init — runtime mutation (e.g., prompt injection) cannot disable mid-process.
- **Wired at output boundaries** (ADR D73):
  - `internal/errors/mappers/shared.ts:truncateRaw` redacts `ErrorMetadata.raw` before exposure. Closes the vector created by v1.3 error-context-surfacing where 2KB of raw provider response body could echo `Authorization: Bearer sk-...` headers.
  - `internal/telemetry/tracer.ts` wraps `setAttribute`/`setAttributes`/`addEvent`/`startSpan` to redact string values before they reach Langfuse / Sentry / PostHog exporters.
  - `internal/runtime/agent-session-store.ts:appendToSessionFile` redacts JSON.stringify(record) before appendFile to the transcript JSONL.
  - `internal/memory/migrate-sqlite-to-lance.ts` wraps the migration logger so any fact text containing secrets is masked at the egress.
- **CI gate against new unredacted sinks** — `tests/lint/no-unredacted-sink.test.ts` greps `src/` for new `console.log`/`appendFile`/`writeFile`/`span.setAttribute` callsites that bypass `redactSecrets`, fails the test run if any land without joining the whitelist (with rationale).
- **Adversarial property tests** via `fast-check` — 12 builtin patterns × 200 runs + PARAM_PATTERN × 200 + BEARER × 200 + 4 sink adversarial tests × 50-100 runs each = ~3000 randomized inputs proving zero leak.

### Changed (secret-redaction-discipline)

- **`ErrorMetadata.raw` shape**: pre-T1.1 the field returned the original `body` object when ≤2KB; post-T1.1 it always returns a (possibly redacted) string because the redactor coerces non-strings via `JSON.stringify`. A workspace-wide grep at land time confirmed zero callers of `err.metadata.raw.someKey`. Consumers that need the parsed shape must `JSON.parse(err.metadata.raw)`.
- **`redactSecrets` consolidated**: the two duplicate impls in `internal/memory/types.ts` (3 patterns) and `internal/runtime/fixture-responder.ts` (5 patterns) are gone — both now route through the canonical module. The fixture sentinel `fixture-search-secret` is replaced locally in `redactEventSecrets` (NOT via `addPattern`) to avoid being cleared by the vitest `beforeEach` reset hook.
- **`vitest.setup.ts`** also resets `_extraPatterns` and re-enables redaction between tests (ADR D60 + secret-redaction EC-3) to prevent test bleed across files.

### Added (v1.3 error-context-surfacing — Error handling block 1/2 patterns)

- **`ErrorMetadata` + `ErrorCode` types exposed from `errors.ts`** (ADR D65/D66). New optional `metadata` field on `TheokitAgentError` and subclasses carries `{ provider, endpoint, code, statusCode?, retryAfter?, raw? }` when the error originates from a provider HTTP call. `ErrorCode` is a finite literal union (`"rate_limit" | "auth_failed" | "invalid_request" | "timeout" | "server_error" | "context_too_long" | "content_filtered" | "model_unavailable" | "network" | "unknown"`) enabling exhaustive `switch` checks at consumer code.
- **Provider error mappers** (ADR D67):
  - `mapAnthropicError({ status, body, headers, endpoint })` — translates raw Anthropic API HTTP errors into typed `TheokitAgentError` subclasses with full metadata. Handles 401/403/429/400/408/5xx with detail mapping (e.g., 400 with context-length signal → `context_too_long` code; 529 overloaded_error → `server_error` with retryAfter).
  - `mapOpenAICompatibleError({ providerId, status, body, headers, endpoint })` — same shape for OpenAI-compatible dialects (OpenAI, OpenRouter, DeepSeek, Together, Mistral, DeepInfra, Voyage). Inspects `body.error.code` / `body.error.type` for fine-grained mapping; gracefully falls back to status-based code when body doesn't follow the OpenAI shape (EC-3).
  - Both mappers truncate raw body to ~2KB in `metadata.raw` to avoid log bloat.
  - Both ignore HTTP-date format `retry-after` headers (EC-5) — only numeric-seconds form populates `metadata.retryAfter`.
- **Wired in call sites**:
  - `internal/llm/anthropic.ts` — `/v1/messages` HTTP errors go through `mapAnthropicError`.
  - `internal/llm/openai.ts` — `/v1/chat/completions` HTTP errors go through `mapOpenAICompatibleError`.
  - `internal/memory/adapters/openai-compatible.ts` — `/v1/embeddings` HTTP errors go through `mapOpenAICompatibleError`; legacy `mapErrorStatus` deleted.
  - `internal/llm/fallback-client.ts` — fallback decision now considers `AuthenticationError` and `RateLimitError` (not just `NetworkError`), so 401 / 429 from one provider triggers fallback to the next (EC-1 fix).

### Changed

- **Refined subclass selection on HTTP errors** (breaking change for callers asserting on specific subclasses). Previously every non-OK HTTP response from Anthropic/OpenAI/OpenRouter/embedding adapters threw a `NetworkError` (or a coarse mapping). Now:

  - `401` / `403` → `AuthenticationError`
  - `429` → `RateLimitError`
  - `400` → `ConfigurationError` (with `code: "context_too_long" | "content_filtered" | "model_unavailable" | "invalid_request"` depending on body inspection)
  - `408` → `NetworkError` (`code: "timeout"`)
  - `5xx` → `NetworkError` (`code: "server_error"` — covers Anthropic 529 overloaded_error)
  - Other → `UnknownAgentError`

  Callers using `instanceof TheokitAgentError` (the base class) are unaffected. Callers using subclass-specific `instanceof` may need to broaden (e.g., switch from `instanceof NetworkError` to `instanceof TheokitAgentError`) or handle the additional subclasses. **Affected internal tests updated**: `tests/golden/llm/anthropic-client.golden.test.ts` (401 now asserts `AuthenticationError`), `tests/golden/memory/openai-embedding.golden.test.ts` (400 now asserts `ConfigurationError`).

### Added (v1.3 persistence & state hardening — 6 patterns from sdk-references)

- **`internal/persistence/` shared primitives directory** (ADR D59). Cross-cutting state helpers consolidated in one place; `internal/memory/atomic-write.ts` and `internal/memory/cwd-mutex.ts` kept as backward-compatible re-export shims.
- **`getTheokitHome(cwd)` + `getProfilesRoot()` + `displayTheokitHome(cwd)`** (ADR D60). Canonical path resolver. Honors `THEOKIT_HOME` env override when set (test isolation, profile switching, multi-tenant deployments); defaults to `<cwd>/.theokit`. Profile root always anchored to `~/.theokit/profiles/` regardless of env.
- **`atomicWriteJson<T>(path, data, options?)` typed helper** with auto-mkdir of the parent directory (EC-4 fix). Sits on top of existing `replaceFileAtomic`. Migrated callers: `agent-registry-store`, `transcript-store`, `mcp/token-storage`.
- **`withFileLock<T>(path, fn, options?)` cross-process file-lock helper** (ADR D61). Uses `proper-lockfile` optional peer dep with a companion `<path>.lock` file and `realpath: false` so the target file does not need to exist yet (EC-1 fix). Falls back gracefully to in-process `withCwdMutex` (with one-shot stderr warning) when the peer dep is missing. Combines `withCwdMutex` + `proper-lockfile` for full in-process AND cross-process serialization.
- **`migrateSchema({ db, currentVersion, migrations })`** SQLite forward-only migration runner via `PRAGMA user_version` (ADR D62). Migrations run inside a transaction (atomic rollback on failure); downgrade attempts throw; gaps in the migration sequence are accepted (result.to reflects last applied version).
- **`readVersionedJson<T>(opts)` / `writeVersionedJson<T>(path, data, version)`** JSON envelope helpers with `_schemaVersion` field. The migrate callback receives the FULL parsed object (not just `.data`), so legacy shapes without the wrapper migrate correctly (EC-2 fix). Agent registry migrated from ad-hoc `SCHEMA_VERSION = "1.0"` to standard envelope; legacy-on-disk files are auto-migrated on next save.
- **`applyWalWithFallback(db, label)`** SQLite WAL mode helper with DELETE fallback for NFS/SMB/FUSE filesystems (ADR D63). Wired in `internal/memory/index-db.ts` for the memory index. Warns once per label on fallback.
- **`sanitizeFts5Query(query)` + `containsCjk(text)`** FTS5 query sanitization (ADR D64). 6-step port of Hermes' `_sanitize_fts5_query` — preserves quoted phrases, strips unmatched specials, collapses repeated asterisks, strips dangling boolean operators, auto-quotes hyphenated/dotted/underscored identifiers, restores phrases. Empty-after-sanitize is short-circuited at call sites (EC-3 fix) to avoid `MATCH ''` runtime errors. CJK detection deferred-routing helper for v1.4 trigram table.

### Added (test infrastructure)

- **Vitest hermetic test isolation** (`vitest.setup.ts`). Autouse `beforeEach` sets `THEOKIT_HOME` to a fresh tmpdir per test; `afterEach` cleans up + restores the original env value. Tests never touch the developer's real state.
- **Lint test `tests/lint/no-hardcoded-theokit-path.test.ts`** that audits `.theokit` literal usage in `src/` and gates regressions (current debt allowlisted; new code MUST use `getTheokitHome(cwd)`).
- **Integration E2E test** exercising the full persistence stack — env override → atomic-write → file-lock → schema migration → WAL → FTS5 sanitization — in a single hermetic test.

### Changed

- `agent-registry-store.ts` now reads/writes via `readVersionedJson` + `writeVersionedJson`. Legacy on-disk shape `{ schemaVersion: "1.0", agents: {...} }` is migrated transparently on next save to `{ _schemaVersion: 1, data: {...} }`.
- `index-manager.ts:ftsSearch` now uses `sanitizeFts5Query` (replacing the previous coarse per-token quoter) and short-circuits when the sanitized result is empty.
- `index-db.ts` calls `applyWalWithFallback` before applying schema; `MemoryDb` interface now exposes `pragma()`.
- `index-schema.ts` PRAGMA_STATEMENTS no longer includes `journal_mode=WAL` (now applied via the helper for graceful fallback).
- `transcript-store.ts` switched from non-atomic `writeFile` to `atomicWriteJson` (auto-mkdir + atomic rename).
- `mcp/token-storage.ts` switched from sync `writeFileSync` to async `atomicWriteJson` (still followed by `chmodSync(0o600)` for POSIX permission tightening).

### ADRs added

- D59 — `internal/persistence/` is the home for cross-cutting state primitives; memory/ re-exports preserved for backward compat
- D60 — `getTheokitHome(cwd)` returns `THEOKIT_HOME || join(cwd, ".theokit")` (single getter, env override optional)
- D61 — file-lock via `proper-lockfile` optional peer dep with companion lockfile + graceful in-process fallback
- D62 — schema versioning: SQLite `PRAGMA user_version` + JSON `_schemaVersion` envelope, forward-only migrations
- D63 — WAL primary, DELETE journal fallback on NFS/SMB; warn once per label
- D64 — FTS5 sanitizer 6-step + CJK auto-detection (trigram routing deferred to v1.4)

### Added (v1.2 features)

- **`Agent.streamObject<T>({ schema, prompt, ... })`** — typed structured output WITH partial-object streaming via synthetic forced tool (ADR D39). Returns `AsyncIterator<StreamObjectEvent<T>>` emitting zero or more `{ type: "partial", partial: DeepPartial<T>, attempt }` events plus exactly one `{ type: "complete", object: z.infer<T>, ... }` at the end. Reuses 80% of `generateObject` infrastructure. EC-4 (cancellation cleanup), EC-5 (refine/transform fallback), EC-6 (parallel tool-use dedup) covered by tests.
- **`@theokit/react` v1.2.0 — family of 3 hooks** (ADR D40): `useTheoChat` (multi-turn, existing) + `useTheoCompletion` (single-shot text gen) + `useTheoAssistant<T>` (object-shaped streaming, wraps `Agent.streamObject`). Each hook has a matching server-side handler: `streamTheoChat`, `streamCompletion`, `streamAssistant`. Shared SSE parser in `internal/sse-parser.ts` handles all wire codes including new `o:`/`O:` for object streaming (ADR D45).
- **OAuth 2.1 PKCE for MCP HTTP servers** (ADR D41). `McpAuthConfig.oauth` opts into the flow. Two modes: `manual` (paste callback URL via stdin, SSH-friendly) and `localhost` (auto-spawned http.createServer on a free port). Token storage prefers OS keychain (`keytar`, optional peer dep) with `~/.theokit/mcp-tokens.json` (chmod 600) fallback. EC-2 (state CSRF validation), EC-9 (concurrent refresh serialization), EC-10 (default expires_in 3600s) covered.
- **Auto-instrumentation of telemetry vendors** (ADR D42). `tracer.ts` feature-detects `@langfuse/node` v3+, `@sentry/node`, and `posthog-node` via `createRequire`. When present + `telemetry.enabled: true`, registers OTel exporter automatically. Opt-out via `telemetry.autoDetect: false` OR `telemetry.disable: ["langfuse"]`. EC-12 (double-billing prevention) covered.
- **LanceDB backend for Memory.index** (ADR D43). `Memory.create({ index: { backend: "lance" } })` activates `@lancedb/lancedb` (optional peer dep). SQLite remains default. Lance scales to 100k+ facts. Filters use Lance's structured filter API — NO string interpolation, EC-1 MUST FIX. EC-8 (embedding dim mismatch) typed error.
- **Migration CLI `theokit-migrate-memory`** (ADR D44). Migrates Memory.index from SQLite to Lance preserving 100% of facts. Atomic commit via rename (`lance-new/` → `lance/`); SQLite preserved by default for rollback. EC-3 MUST FIX: validation uses NFC unicode normalization on both sides so facts with accents/emojis migrate correctly.

### Added (ADRs locked)

- D39 — `Agent.streamObject<T>` returns AsyncIterator with partial+complete events
- D40 — React hooks family: 3 separate hooks (useTheoChat / useTheoCompletion / useTheoAssistant)
- D41 — OAuth 2.1 PKCE for MCP HTTP + token storage with keychain fallback
- D42 — Auto-instrumentation via createRequire feature-detect
- D43 — LanceDB backend behind same IndexManager interface
- D44 — Migration SQLite → Lance is standalone CLI (theokit-migrate-memory)
- D45 — `SDKObjectDelta` variant + wire codes `o:`/`O:`
- D46 — Cross-agent shared memory deferred to v1.3 (threat-model own scope)

### Deferred

- **Cross-agent shared memory** (`MemoryOptions.scope: "global" | "team"`): postponed to v1.3 because the threat-model around write authorization across users requires its own ADR. Workaround in the meantime: `scope: "user"` with constant `userId` (e.g., `"team-shared"`).

### Added (v1.1 features)

- **`Agent.generateObject<T>({ schema, prompt })`** — typed structured output via synthetic forced tool (ADR D33). Returns `{ object: z.infer<T>, raw, usage, finishReason }`. Retry-on-parse-fail with `maxRetries` (default 1). Transient agent disposed AND hard-deleted from registry across retries (EC-3 no leak). Same provider routing/fallback as `agent.send`.
- **`AgentOptions.telemetry`** — opt-in OpenTelemetry spans for `agent.send`, `llm.call`, `tool.call` (ADR D34). Privacy-by-default: NO content logged unless `includeContent: true`. `@opentelemetry/api` is OPTIONAL peer dep loaded via `createRequire`. All OTel calls wrapped in `safe()` so exporter errors NEVER propagate to `agent.send` (EC-1).
- **`@theokit/react` v1.0.0** — new workspace package (ADR D32). `useTheoChat` React hook (HTTP fetch + SSE parser, AbortController on unmount, EC-6 5xx handling, EC-8 graceful close). `streamTheoChat` Next.js-compatible SSE handler (EC-2 pre-stream typed errors return HTTP 400/401). Wire format = Data Stream v1 (drop-in `useChat` migration; no `ai` package runtime dep). React peer dep `^18 || ^19`.

### Validations (v1.1 pillar audits)

- **Persistence chaos** — 20/20 random-timed SIGKILL recoveries, 0 registry corruptions (snapshot: `persistence-chaos-2026-05-17.md`).
- **MCP servers** — 4 distinct MCP servers operational across stdio+http (filesystem, mcp-http, tavily, puppeteer); snapshot: `mcp-audit-2026-05-17.md`.
- **Memory at scale** — 12 facts → 12 clusters via `text-embedding-3-small`, 100% Active Memory recall on 4 thematic queries (snapshot: `memory-scale-2026-05-17.md`).
- **Chat-bot DX portability** — N=2 examples using all 4 helpers: `telegram-pro` + new `cli-bot` (snapshot: `dx-chatbot-portability-cli-2026-05-17.md`).
- **Adversarial safety** — 8/8 validation/permission/state scenarios blocked; 0 crashed (snapshot: `safety-adversarial-2026-05-17.md`).

### Added

- Public `AgentOptions.tools` field for inline custom tools (#tools-inline). The SDK now exposes a `CustomTool` type — `{ name, description, inputSchema, handler }` — that consumers can pass at `Agent.create()` or `Agent.resume()`. Handlers are invoked locally when the model emits `tool_use`. Local runtime only; cloud agents throw `ConfigurationError(code: "cloud_custom_tools_rejected")` when `tools.length > 0`. Handlers are not persisted (allow-list strip in `stripSecretsFromOptions`) — re-pass on resume. Reserved-name collisions (`shell`, `memory_search`, `memory_get`, `mcp_*`) and duplicate names rejected at validation time.
- Per-call `SendOptions.tools` override (#tools-percall). `agent.send(msg, { tools: [...] })` fully replaces `AgentOptions.tools` for that run, matching the existing `mcpServers` semantics. `undefined` → fall back to agent-level tools; `[]` → explicit clear (no custom tools); `[t1, t2]` → exact replacement. Same validation rules apply per-call. Cloud agents reject per-call tools with the same `cloud_custom_tools_rejected` code.
- `Agent.getOrCreate(agentId, options)` static helper (ADR D22). Consolidates the resume-or-create dance into a single call: tries `Agent.resume` first; falls through to `Agent.create({ ...options, agentId })` on `UnknownAgentError`; retries `Agent.resume` once on same-process create race (`ConfigurationError(agent_id_already_exists)`). Re-throws every other error verbatim. Eliminates ~30 LoC of boilerplate from each of the 6 examples that previously hand-rolled the pattern.
- `createAgentFactory(common)` public function (ADR D23). Captures shared `AgentOptions` once and exposes `forSession(agentId, overrides?)` + `getOrCreate(agentId, overrides?)`. Top-level shallow merge with `overrides` winning; deep merge for `local`/`memory`/`cloud`; total replace for collection-shaped fields. The function-level `agentId` always wins. Designed for chat-bot patterns where most config is shared across users.
- `defineTool<T extends ZodType>(spec)` Zod-driven type-safe builder for `CustomTool` (ADR D24). Converts schema to JSON Schema via Zod 4's native `z.toJSONSchema` (with `unrepresentable: "any"` for transforms/refines). Wraps the handler with a runtime `schema.parse` step — handler receives `z.infer<T>` instead of `Record<string, unknown>`. Removes `as` casts in tool handlers. Zod is an OPTIONAL peer dependency — consumers who don't use `defineTool` don't pay any bundle cost.
- `Agent.builder()` fluent alternative to the options bag (ADR D25). Returns an `AgentBuilder` with chainable setters (one per top-level `AgentOptions` field) and three terminals: `.build()` (shallow-cloned snapshot), `.create()` (delegates to `Agent.create`), `.getOrCreate(agentId)` (delegates to `Agent.getOrCreate`). Validation runs inside the terminal — no duplicate rules.

## 1.0.0

### Major Changes

- v1.0.0 — General availability.

  This release closes the 14 gaps tracked in `.claude/knowledge-base/plans/sdk-v1-ga-completion-plan.md` and locks the architectural decisions in the ADR directory (`.claude/knowledge-base/adrs/D01-..D14-`).

  ### Highlights

  **Memory subsystem** (already in 0.x, now stabilized):

  - Markdown-first storage at `.theokit/memory/MEMORY.md` + `notes/*.md`
  - SQLite + FTS5 + sqlite-vec hybrid index
  - `memory_search` / `memory_get` tools
  - Active Memory with circuit breaker + LRU cache
  - Dreaming/REM consolidation with `dream-diary.md`

  **Embedding catalog** (ADR D11):

  - 5 fully-implemented providers: `openai`, `mistral`, `openrouter`, `voyage`, `deepinfra`
  - `lmstudio`, `google`, `bedrock` are deferred to v1.1 (ADRs in the SDK repo)

  **`OpenAiCompatibleConfig.embeddingsPath`** (EC-2 fix):

  - New optional config field on the shared embedding factory. REPLACES the default `/v1/embeddings` suffix; never concatenates. DeepInfra uses `/v1/openai/embeddings`.

  **Strict skills frontmatter** (ADR D10) — BREAKING:

  - `.theokit/skills/<name>/SKILL.md` now requires YAML frontmatter with `name` + `description`.
  - Malformed YAML or missing required fields exclude the skill from `agent.skills.list()` with a stderr warning. The agent run continues.
  - Migration: `grep -rL "^---$" .theokit/skills/*/SKILL.md` finds skills needing the frontmatter block.

  **`Symbol.asyncDispose` on `SDKAgent`** (ADR D5):

  - `await using agent = await Agent.create(...)` typechecks and runtime-works on both Local and Cloud runtimes.
  - `CloudAgent.dispose()` is now idempotent (EC-3); double-dispose runs the side-effect at most once.

  **Embedding adapter unknown-model rejection** (EC-4):

  - `createOpenAiCompatibleRuntime` throws `ConfigurationError(code: "embedding_unknown_model")` when the chosen model is not in the adapter's dimension table. Prevents downstream vec0 dimension mismatches.

  **Node 22.12+ mandatory** (ADR D1):

  - All gates (test, typecheck, biome, knip, validate, dogfood) run on Node 22.12+.
  - Pre-push hook gates Node version with a friendly remediation message (EC-1).
  - GitHub Actions CI matrix pins Node 22.12 + 22-latest.

  **`pnpm validate` strict on publint + attw** (ADR D6):

  - Either tool's failure blocks `pnpm validate` and CI. No warning-only mode.

  ### Default model id

  The default agentic model is `google/gemini-2.0-flash-exp:free` (OpenRouter free tier). Override per-agent with `model: { id: "..." }` or query `Theokit.models.list()` for the canonical PaaS catalog (ADR D4).

  ### Cloud runtime

  Pre-release. `Agent.getRun({ runtime: "cloud" })`, `agent.listArtifacts()`, `agent.downloadArtifact()` throw `ConfigurationError(code: "cloud_runtime_pre_release")` when invoked with non-fixture API keys. Fixture mode (`theo_test_*` keys) remains the documented test seam.

All notable changes to `@theokit/sdk` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased — pre-changeset legacy, superseded by the 3.x sections above]

### Added (multimodal demo `examples/telegram-pro`)

- **New `examples/telegram-pro/`** — ~600 LoC Telegram bot demonstrating the 5 highest-value Telegram integration patterns on top of `@theokit/sdk` 1.0.0:
  - **Voice transcription** ([`src/transcribe.ts`](../../examples/telegram-pro/src/transcribe.ts)) — downloads the OGG/Opus from Telegram, POSTs multipart to Whisper. Provider order: `OPENAI_API_KEY` → `GROQ_API_KEY` → graceful "voice not configured" reply. Transcript is injected into the agent loop as `[voice transcript: ...]`.
  - **Vision** ([`src/vision.ts`](../../examples/telegram-pro/src/vision.ts)) — photo and sticker descriptions via `google/gemini-2.0-flash-001` multimodal on OpenRouter. Disk-cached at `.theokit/cache/vision/<sha256>.txt` keyed by Telegram's `file_unique_id`, so repeated stickers (common in groups) skip the LLM roundtrip.
  - **Inline buttons** ([`src/buttons.ts`](../../examples/telegram-pro/src/buttons.ts)) — agent emits `[BUTTONS: A | B | C]` at end of reply; example strips the marker, renders a grammy `InlineKeyboard`, and routes button taps back to the agent as `[user tapped button: A]` so conversation history stays consistent.
  - **Group `@mention` gating** ([`src/group-policy.ts`](../../examples/telegram-pro/src/group-policy.ts)) — `shouldRespondInChat(ctx, policy)` filter; private chats always pass; groups only when message text contains `@<botname>`, replies to the bot, or starts with `/`.
  - **Forum-topic scoping** ([`src/agent.ts`](../../examples/telegram-pro/src/agent.ts)) — per-`message_thread_id` agentId (`tg-pro-tpc-<chatId>-<threadId>`) so each topic in a supergroup gets its own isolated session JSONL. Memory namespace stays scoped to `userId` so facts follow the user across topics.
- **README walkthrough** — full BotFather setup including `/setprivacy → Disable` (so the bot sees all group messages, not just commands), per-pattern try-it examples, filesystem layout inspection, and an explicit "what this example does NOT cover" honesty note.
- **examples/README.md inventory** — `telegram-pro` listed at the top as the **Multimodal demo**, ahead of `telegram-assistant` (personal assistant) and `telegram-bot` (minimal reference).

### Added (chat assistant readiness — flagship demo `examples/telegram-assistant`)

- **New `examples/telegram-assistant/`** — ~300 LoC Personal Assistant Telegram bot built on `@theokit/sdk` 1.0.0. Demonstrates the full chat-assistant surface end-to-end against a real LLM:
  - **Commands**: `/start /help /me /remember /forget /recall /summary /reset` — covers explicit fact write, fact removal by substring, past-conversation search via `corpus="sessions"`, dreaming consolidation via `Memory.runDreamingSweep`, and conversation reset.
  - **Per-user isolation** — agent id = `tg-assistant-<userId>`, memory namespace pinned to `ctx.from.id` so group chats keep each member's facts separated (EC-11 documented).
  - **Allow-list** — optional `TELEGRAM_ALLOWED_USERS` env var locks the bot to specific Telegram user-ids so a randomly-discovered bot can't burn the operator's LLM budget.
  - **Format-aware replies** — Telegram MarkdownV2 escape + auto-split for responses > 4096 chars (`splitForTelegram` chooses paragraph/newline boundaries before hard-splitting at 4000 chars).
  - **Daily dreaming hook** — `runDream()` wraps `Memory.runDreamingSweep` and picks the embedding provider from available env keys (`OPENAI_API_KEY` → `MISTRAL_API_KEY` → `OPENROUTER_API_KEY`).
- **README walkthrough** — full BotFather token-acquisition flow (no prior Telegram knowledge needed), OpenRouter signup, `.env` template, restart-proof demo, file-system layout inspection, and a "what survives restart vs `/reset`" matrix.
- **examples/README.md inventory** — `telegram-assistant` listed as the **Flagship demo** at the top of the table; existing minimal `telegram-bot` reference kept intact.

### Fixed (chat assistant readiness — Phase 5 dogfood-driven bug)

- **Persistent-registry coalescing dropped second-mutation data.** Two synchronous `registerAgent` calls (e.g., create chat A then create chat B in quick succession) used to coalesce into ONE save whose snapshot only captured the agent that registered before the first microtask flushed. The second agent's full options were never persisted; on restart, `Agent.resume` cold-started a fresh agent with no model, no memory, no system prompt — the run then failed with `claude-sonnet-4-6 is not a valid model ID` because real-local-run's fallback model is not on OpenRouter. Caught in Phase 5 dogfood against real Gemini-flash.
- **Fix**: the save loop now uses a `dirtyCwds` Set. Every mutation marks the cwd dirty. The in-flight save's IIFE loops while dirty: clear flag, yield once to settle burst, snapshot, save. If a mutation arrives DURING the save's await, the loop runs again. Two registers within one microtask burst still coalesce to one save; mutations during the save no longer drop on the floor.
- **No regression** — 284/284 vitest suite green; Phase 0 golden tests (50 parallel `Agent.create` calls produce valid JSON) still pass with the new loop.

### Added (chat assistant readiness — Phase 5 / Dogfood QA)

- **`examples/telegram-bot/src/dogfood.ts` + `dogfood-restart.ts`** — automated end-to-end validation against a REAL LLM (OpenRouter gemini-2.0-flash-001), no Telegram token required:
  1. Two distinct chats (`tg-dogfood-chat-A`, `tg-dogfood-chat-B`) on the same workspace cwd, each says "Remember: ..." and asks a follow-up. **PASS** in-process recall.
  2. Inspect persisted state: registry.json + per-agent messages.jsonl + sessions corpus dir all exist on disk.
  3. **Real process restart** via `spawnSync("npx tsx ...", ...)` runs a fresh node process. The subprocess `Agent.resume`s both chats — pulling registry.json + messages.jsonl + MEMORY.md from disk. Both LLMs answer with the persisted facts ("Vitest + alpha-7", "PostgreSQL + project-beta") after the restart boundary. **PASS** post-restart recall.
  4. Concurrent burst: 5 parallel sends into one chat produce strictly-alternating user/assistant records (16 records total). **PASS** mutex serialization.
  5. Sessions corpus: 11+ `.md` summaries on disk after all runs. **PASS** corpus seeding.
- **Result**: 10 PASS / 0 WARN / 0 FAIL against real LLM. The chat assistant pattern works end-to-end with `@theokit/sdk` v1.0.0.

### Added (chat assistant readiness — Phase 4 / `examples/telegram-bot`)

- **New `examples/telegram-bot/`** — ~120 LoC `grammy` bot proving the chat assistant pattern end-to-end. One persistent agent per chat (`Agent.resume(`tg-${chatId}`)` first, fall back to `Agent.create` on `UnknownAgentError`). Memory enabled with `namespace: "telegram-bot"`, `userId: ctx.from.id`, `activeRecall.enabled`. A `/recall <query>` command uses `memory_search({ corpus: "sessions" })` to surface past conversations.
- **README walkthrough** documents: BotFather setup, `.env` template, run, chat, `kill -9`, restart, chat-again-and-see-memory. Inspects `.theokit/agents/registry.json`, `.theokit/agents/<id>/messages.jsonl`, `.theokit/memory/MEMORY.md`, and `.theokit/memory/sessions/<runId>.md` to show what survived.
- **EC-10 doc** — explicit callout that v1 supports exactly ONE SDK process per cwd; co-locating a bot + a standalone cron worker on the same workspace will race the registry.
- **EC-11 doc** — explicit callout that group-chat `ctx.chat.id` is the group id (not the user); the example uses `ctx.from.id` to keep per-user memory isolated in groups.
- **examples/README.md inventory** updated with the bot at the top of the list — it is the marquee proof for v1.0 chat assistant readiness.

### Added (chat assistant readiness — Phase 3 / ADR D20)

- **`memory_search({ corpus: "sessions" })` actually works.** Per-run summaries are written to `<cwd>/.theokit/memory/sessions/<runId>.md` after every finished run. IndexManager discovers them via the new `session-loader` and tags each chunk with `source: "sessions"`. The `corpus` filter in `memory_search` was already wired; this PR plugs in the data source.
- **EC-9: only `status === "finished"` runs write summaries.** Cancelled, errored, or still-running runs leave no marker behind, so the recall corpus never returns fragments of failed conversations as authoritative context.
- **EC-3: post-run sync is automatic.** `writeSessionSummary` triggers `IndexManager.sync()` in the background immediately after the markdown write. `memory_search({ corpus: "sessions" })` sees the new file on the next call without an ambiguous lazy trigger.
- **Secret redaction.** Both user and assistant text run through the shared `redactSecrets` regex before persisting, matching the MEMORY.md write pipeline.
- **`local-agent.ts` post-run hook moved INSIDE the send mutex.** The user-turn append, assistant-turn append, summary write, hooks executor, and `flushSessionWrites` all happen before the lock releases. `agent.dispose()` waits on the same mutex so it can never return before the summary lands on disk.
- **`agent.dispose()` is now strict** — it acquires the per-agent send mutex before flushing, guaranteeing the in-flight `run.wait()` and post-run lifecycle complete before any caller's `await dispose()` resolves.
- **New tests**: 8 golden cases under `tests/golden/memory/sessions-corpus.golden.test.ts` cover summary-on-finish, hit-on-sessions-search, memory-corpus excludes sessions, redaction, corrupt-file tolerance, EC-3 sync-after-wait, EC-9 cancelled-run, and EC-9 errored-run.

### Added (chat assistant readiness — Phase 2 / ADR D19)

- **Per-agent send mutex** keyed by `agent-send:${agentId}` (ADR D19). `LocalAgent.send` and `CloudAgent.send` now serialize end-to-end per agent: dispatch → `run.wait()` → assistant-turn append → disk flush all happen inside the lock. Two webhook calls hitting the same chat id can no longer interleave `appendSessionMessage` records mid-turn.
- **Concurrent-distinct-agents stay parallel** (EC-8) — the mutex key is per-agentId. A parent agent's send and a subagent send (distinct ids) acquire different locks and run concurrently. Proven by the deadlock-free golden case.
- **`agent.send()` returns the Run as soon as it dispatches**, but the mutex internally awaits completion + post-run hook + session flush before releasing. Streaming consumers keep their `run.stream()` access unchanged; the only observable difference is that a second `agent.send()` on the same agent now waits for the first to finish.
- **New tests**: 5 golden cases under `tests/golden/agent/concurrent-send.golden.test.ts` cover two-concurrent-sends-serialize (strict role alternation), different-agents-stay-parallel, EC-8 subagent no-deadlock, sequential history linearity, and dispose-with-pending-send safety.

### Added (chat assistant readiness — Phase 1 / ADR D18)

- **Persistent session messages** at `<cwd>/.theokit/agents/<agentId>/messages.jsonl` (ADR D18). Append-only JSONL with one record per turn (`{role, text, at}`). `LocalAgent.send` now writes both the user turn and the assistant turn to disk; `Agent.resume()` hydrates the conversation back into memory on `initialize()`. Survives `kill -9` between sends.
- **Opportunistic compaction** — when the JSONL exceeds 400 lines (2× the default `maxTurns=200`), the file is trimmed copy-on-write to the most recent 200 turns. Compaction also runs once during `dispose()` so a long-running chat does not leave 10k stale lines on disk.
- **Race-free append + compaction** (EC-2) — both operations chain through a single per-`(agentId, cwd)` promise queue. Appends and compactions never race each other on the read+rename window. Reentry into `withCwdMutex("agent-send:...")` was rejected because Phase 2's send mutex uses the same key (non-reentrant) and would deadlock; the dedicated queue is the canonical serializer.
- **Multi-line text** (EC-6) — `JSON.stringify` on append and `JSON.parse` per-line on read keep newlines, tabs, and embedded quotes intact across a restart.
- **Crash-safe reader** (EC-7) — malformed lines (e.g., a half-written final record from a power loss) are skipped with a stderr warning. The reader never throws.
- **New tests**: 10 golden cases under `tests/golden/runtime/agent-session-persistence.golden.test.ts` cover round-trip restart, compaction trim, EC-2 (concurrent appends + compaction across threshold), per-agent isolation, EC-6 (tricky text), EC-7 (partial last line), JSONL validity, hydrate-fills-cache, end-to-end Agent.create→send→resume conversation continuity, and direct 500-record compaction.

### Added (chat assistant readiness — Phase 0 / ADRs D17 + D21)

- **Persistent agent registry** at `<cwd>/.theokit/agents/registry.json` (ADR D17). Every `Agent.create / archive / update / delete` mutation triggers a coalesced, atomic write-through. The in-memory `Map` stays as the read-through cache; persistence is keyed per-cwd (EC-5). Survives `kill -9` + process restart.
- **`Agent.resume()` falls back to disk** (ADR D21). On in-memory miss, `Agent.resume(id)` reads the persisted registry, validates the rehydrated entry (local agents check `local.cwd` still exists), and reconstructs the matching `LocalAgent` / `CloudAgent`. Throws `UnknownAgentError(code: "agent_rehydration_failed")` when the workspace path is missing.
- **`Agent.create({ agentId })` collision** (EC-1) — pinning an `agentId` that already lives in the persisted registry now throws `ConfigurationError(code: "agent_id_already_exists")`. Forces the resume-first pattern that chat assistants need.
- **Secret stripping on persist** — `apiKey`, MCP server `headers` / `env`, hook closures, and inline tool handlers are never written to disk. The allow-list mirrors the cloud-config-serializer (ADR D15).
- **Corrupt-registry recovery** (EC-4) — invalid JSON / schema-version mismatch logs a stderr warning and falls back to `{}`. The next mutation overwrites the file with valid JSON.
- **`replaceFileAtomic` multi-writer safe** — per-call unique `.<pid>.<rand>.tmp` suffix replaces the shared `.tmp` path. Removes a cross-process race that surfaced as `ENOENT` on rename when parallel writers raced on the same target.
- **New tests**: 11 golden cases under `tests/golden/runtime/agent-registry-persistence.golden.test.ts` cover round-trip, cross-restart rehydration, stale-cwd rejection, secret stripping, concurrent-write integrity (50 parallel creates), archived-flag persistence, cloud-agent rehydration, EC-1 collision throw, EC-4 corruption recovery, and EC-5 per-cwd isolation.

### Changed (default model: composer-2 → free agentic model)

- **Default model id swept SDK-wide from the placeholder `composer-2` to `google/gemini-2.0-flash-exp:free`** (OpenRouter free tier, solid tool-calling for agentic flows).
- **New `internal/runtime/default-model.ts`** exports `DEFAULT_AGENTIC_MODEL_ID` — single source of truth for the fallback model id, used by `cloud-agent.ts`, `local-run.ts`, and `internal/catalog/fixtures.ts`.
- **`FIXTURE_MODELS` catalog** swapped to the new model id + display names ("Gemini 2.0 Flash (free)"). Golden snapshot `tests/golden/theokit/models.json` updated.
- **All 30+ tests + golden JSON snapshots + 10+ doc pages + 3 examples** swept from `composer-2` to the new id. Public `docs.md` examples now show a runnable default.
- Rationale: under the no-stubs-no-mocks-no-wired rule, a placeholder model id that maps to nothing real surfaces fixture mode to consumers who pass real keys. The new default is a real, free OpenRouter model — works out of the box with `OPENROUTER_API_KEY`, and per-call `model: { id: "..." }` override is unchanged.

### Changed (cloud pre-release guard — no-stubs-no-mocks-no-wired enforcement, round 2)

- **`CloudAgent.listArtifacts()` and `CloudAgent.downloadArtifact()`** now throw `ConfigurationError(code: "cloud_runtime_pre_release")` when invoked with a non-fixture API key. Previously they returned hardcoded fixture data (`buildFixtureArtifacts()` + `Buffer.from("fixture artifact content for ...")`) regardless of key — silently passing fixture content off as real PaaS responses.
- **Fixture artifacts are now lazy-built** inside the fixture-mode branch of `listArtifacts/downloadArtifact` instead of eagerly seeded in the constructor. Real-key callers no longer carry fixture state.
- **`CloudAgent` `summary` field** is now `"Cloud contract fixture"` only in fixture mode; real-key cloud agents register as `"Cloud agent"`.
- **New `isFixtureMode()` private** centralizes the "are we in fixture mode?" check (matches the rule in `internal/fixture-mode.ts`: `theo_test_*` key + no `THEOKIT_API_BASE_URL`).
- **New golden test** `cloud-prerelease-guard.golden.test.ts` (4 cases) locks the behavior: real keys get `cloud_runtime_pre_release`, fixture keys get fixture artifacts, path-traversal still rejected.

### Added (OpenRouter embedding adapter)

- **`openrouter` embedding adapter** — proxies through `https://openrouter.ai/api/v1/embeddings` (OpenAI-compatible shape). Caller selects the underlying model via the standard OpenRouter ids (`"openai/text-embedding-3-small"`, `"mistralai/mistral-embed"`, etc.). Honors `OPENROUTER_API_KEY` + `OPENROUTER_API_BASE_URL`.
- **`MemorySettings.index.embedding.provider`** and **`DreamingSweepOptions.embedding.provider`** unions extended with `"openrouter"`.
- **`examples/memory-dreaming`** now accepts `OPENROUTER_API_KEY` in addition to `OPENAI_API_KEY` / `MISTRAL_API_KEY`. Validated end-to-end: 6 facts → 4 semantic clusters (3 Vitest paraphrases grouped correctly).
- **Stubbed-fetch test** in `multi-adapter.golden.test.ts` proves the OpenRouter adapter actually embeds (1536-dim vectors round-tripped from the OpenAI-compatible response shape).

### Changed (cheaper agentic chat model in examples)

- **`openai/gpt-4o-mini` → `google/gemini-2.0-flash-001`** in the 4 chat examples (`memory`, `memory-search`, `memory-get`, `active-memory`). ~33% cheaper input tokens at similar tool-calling fidelity for these recall scenarios. Pricing as of 2026-05.

### Removed (no-stubs-no-mocks-no-wired rule enforcement)

- **5 stub embedding adapters removed from the catalog**: `voyage`, `deepinfra`, `lmstudio`, `google`, `bedrock`. Files deleted; `MEMORY_EMBEDDING_ADAPTERS` now exposes only `openai` + `mistral` (the implementations that actually ship).
- **`stub-adapter.ts` factory deleted** — no callers remain.
- **LanceDB backend stub removed**. `MemoryBackend` is now `"sqlite-vec"` only. `IndexManager.open({ backend: "lancedb" })` no longer compiles; the runtime throw is gone.
- **`ActiveMemoryOptions.mode` field removed** — the `"subagent"` member was a typed promise with no implementation. Active Memory was always running in `"search"` mode regardless of the option.
- **`createStubRun` + `createHistoricalCloudRun` deleted**. `stub-run.ts` removed entirely. Two callers replaced with typed errors:
  - `Agent.getRun(runId)` now throws `UnknownAgentError(code: "run_not_found")` when the registry has no record (was: synthetic Run with `agentId: "agent-pending"`, `status: "finished"`).
  - `Agent.getRun(runId, { runtime: "cloud" })` now throws `ConfigurationError(code: "cloud_runtime_pre_release")` (was: stub historical Run).
  - `runCronJob` with orphan `agentId` now throws `UnknownAgentError(code: "agent_not_registered")` (was: stub Run stuck at `status: "running"`).
- **`MemoryEmbeddingRuntime` public BYO surface removed** — `Memory.runDreamingSweep` no longer accepts `embedding: { runtime: ... }`. The only consumer was a demo fallback that itself has been removed. The type alias is gone from the public barrel.
- **`makeLocalDemoRuntime` removed from `examples/memory-dreaming/`**. The example now fails fast when neither `OPENAI_API_KEY` nor `MISTRAL_API_KEY` is set.
- **`@lancedb/lancedb` removed from `tsup.config.ts` external list** — no longer referenced by the bundle.

### Changed (no-stubs-no-mocks-no-wired rule enforcement)

- **Public `MemorySettings.index.embedding.provider`** narrowed from a 7-id union to `"openai" | "mistral"`. Consumers selecting a removed provider now get a TypeScript error at the call site instead of a runtime crash.
- **`docs.md` and the docs site** updated to reflect the trimmed catalog and BYO-runtime removal.
- **`examples/memory-dreaming/README.md`** removed the "future-work cron integration" claim. Scheduling consolidation is documented as a user concern (call `Memory.runDreamingSweep` from any scheduled context).
- **`placeholderScript` renamed to `unusedFixtureScript`** in `real-local-run.ts` + `real-cloud-run.ts` with a clarifying comment — the FixtureScript shape is required by the base Run class but never consumed by the real-LLM path.
- **`index-schema.ts` comment** corrected — `meta` table description matches what the code actually persists (embedding identity), and the `embeddings` virtual table is now documented.

### Changed (memory-system parity, Increment D — Dogfood follow-ups)

- **`local-agent.ts` decomposed** — memory glue (lazy IndexManager + tools cache + Active Memory breaker + summary cache) extracted to `local-agent-memory.ts`. Brings `local-agent.ts` under the G8 400-LoC cap.
- **`legacyMemoryJsonPath` centralized in `memory/types.ts`** — removes the 9-line jscpd clone between `migration.ts` and `runtime/memory-store.ts`. Both now call the leaf-module helper.

### Added (memory-system parity, Increment C — Dogfood examples + Memory namespace)

- **`Memory` public namespace** exported from `@theokit/sdk` — `Memory.runDreamingSweep({ cwd, embedding })` lets users trigger consolidation outside of `agent.send()` (e.g. from a cron job handler).
- **`MemoryEmbeddingRuntime` public type** — `embedding` now accepts either a built-in provider id (`{ provider, model? }`) OR a BYO runtime (`{ runtime: MemoryEmbeddingRuntime }`). Enables self-hosted/local embedding models and self-contained demos without external API creds. Follows the `EmbeddingRuntime` shape from ADR D3.
- **4 new example apps** under `examples/`:
  - **`memory-search`** — LLM uses `memory_search` to find facts in MEMORY.md.
  - **`memory-get`** — LLM uses `memory_get` for bounded reads of `notes/*.md`.
  - **`active-memory`** — blocking pre-send recall injects an `<active-memory>` block.
  - **`memory-dreaming`** — `Memory.runDreamingSweep` consolidates duplicates + clusters + writes a dream-diary entry. Ships with a deterministic local-demo embedding fallback so the example runs without `OPENAI_API_KEY` / `MISTRAL_API_KEY`.
- **`examples/README.md` inventory** updated with all 4 new examples marked ✅ Full.

### Added (memory-system parity, Increment B — Active Memory wire-up)

- **`memory.activeRecall.enabled`** runtime wire-up — when `true`, the SDK calls `runActiveMemory` before every `send()` and prepends the recall summary as a `<active-memory>` block to the LLM system prompt (priority 5 — above context/skills/memory).
- **Per-agent `CircuitBreaker` + `ActiveMemoryCache`** — instantiated lazily on first send with active recall enabled. Keyed by `agentId` so multiple agents in the same process don't share state.
- **Stub-server E2E proof** — captured Anthropic request body contains `<active-memory>` when enabled, and does NOT when disabled.
- **Active recall config surface** — `queryMode` (`"message"` / `"recent"` / `"full"`), `timeoutMs`, `maxSummaryChars`, `persistTranscripts` are all wired from `MemorySettings.activeRecall` through to `runActiveMemory`.

### Added (memory-system parity, Increment A — Agent.create/send wire-up)

- **`MemorySettings.index`** public field — `{ tools?: boolean; backend?: "sqlite-vec" | "lancedb"; embedding?: { provider, model? } }`. When `memory.enabled === true` and `index.tools !== false`, the SDK lazily opens an `IndexManager` on first send + registers `memory_search` and `memory_get` with the LLM. Default backend is `sqlite-vec`; default embedding is none (FTS-only mode).
- **`MemorySettings.activeRecall`** public field — reserved for Phase 7 wire-up (next increment). Type surface live today; runtime hookup pending.
- **Stub-server E2E tests** prove memory tools appear in the captured Anthropic request body's `tools` array when memory is enabled, and are absent when disabled or opted-out via `index.tools: false`.
- **Lazy embedding adapter resolution** — when `index.embedding.provider` is set, the SDK looks the adapter up via `MEMORY_EMBEDDING_ADAPTERS` and instantiates it on first send. Adapter failures degrade gracefully to FTS-only mode with a stderr warning.

### Added (memory-system parity, Phase 13)

- **Cross-validation report** at `.claude/knowledge-base/reviews/cross-validation/memory-system-parity-xval-2026-05-16.md`. Verdict **APROVADO COM RESSALVAS**, zero BLOCKERs. All 10 ADRs cross-checked against shipped code; all 13 edge cases verified resolved or documented.

### Added (memory-system parity, Phase 12)

- **Backend selector** — `IndexManager.open({ backend: "sqlite-vec" | "lancedb" })`. Default `"sqlite-vec"`. `"lancedb"` reserved for Phase 12.1; throws `ConfigurationError(code: "memory_backend_not_implemented")` today (same KISS pattern as the Phase 11 stub embedding adapters).

### Added (memory-system parity, Phase 11)

- **`MEMORY_EMBEDDING_ADAPTERS` catalog** exports all 7 provider ids: `openai`, `mistral`, `voyage`, `deepinfra`, `lmstudio`, `google`, `bedrock`. Switching is one config field.
- **Mistral adapter** fully implemented — `mistral-embed` (1024 dims) via shared OpenAI-compatible factory (`POST /v1/embeddings`). Honors `MISTRAL_API_KEY` + `MISTRAL_API_BASE_URL`.
- **`createOpenAiCompatibleRuntime` shared factory** — extracted from the OpenAI adapter so any provider exposing the `{ model, input }` → `{ data: [{ embedding }] }` REST shape can plug in with a one-file thin wrapper.
- **5 stub adapters** (Voyage, DeepInfra, LMStudio, Google, Bedrock) — metadata-only. `embed()` throws `ConfigurationError(code: "adapter_not_implemented")` so callers detect the gap without crashing the agent loop.

### Added (memory-system parity, Phase 10)

- **Wiki supplements** — files under `.theokit/memory/wiki/*.md` are read-only auxiliary corpora discovered by `discoverWikiFiles`. Indexed alongside `MEMORY.md` + `notes/*.md` with `source: "wiki"` tag in the `files` table.
- **Corpus filtering in search** — `IndexManager.search(query, { sources: ["wiki"] })` returns only wiki hits; default search returns memory + wiki together. `memory_search` tool already honors `corpus: "wiki" | "memory" | "all"` per the tool schema from Phase 6.
- **Source coercion on conflict** — `upsertFile` accepts an explicit `source` arg so reclassifying a file (moving a note into the wiki dir, etc.) updates the tag on next sync via `ON CONFLICT DO UPDATE SET source = excluded.source`.

### Added (memory-system parity, Phase 9)

- **`runDreamingSweep`** — cron-driven memory consolidation (ADR D7). Three phases:
  - **light** — drop near-duplicate facts via cosine similarity (default threshold 0.95).
  - **REM** — single-link agglomerative clustering by cosine similarity (default threshold 0.75).
  - **deep** — write a `notes/dreamed-<ts>.md` per sweep with consolidated clusters.
- **Dream-diary at `.theokit/memory/dream-diary.md`** — append-one-entry-per-sweep. Each entry carries timestamp + content hash (idempotency contract) + counts (`factsBefore`, `factsAfter`, `duplicatesRemoved`, `clustersCreated`, `notesWritten`).
- **All dreaming writes are atomic (EC-3)** — `replaceFileAtomic` for notes and diary; per-cwd mutex held for the whole sweep so concurrent `Remember:` appends can't race.
- **LLM narrative summarization deferred to Phase 9.1** — v1 ships deterministic clustering only. The interface is stable enough to plug an LLM-mediated `narrative.ts` later without changing the orchestrator.

### Added (memory-system parity, Phase 8)

- **CircuitBreaker** for Active Memory — `{ maxTimeouts: 3, cooldownMs: 60000 }` defaults. After N consecutive timeouts, `shouldSkip(key)` returns `true` until cooldown elapses. `recordSuccess` resets the counter immediately. Per-key isolation (multiple agents in one process don't share state).
- **`ActiveMemoryCache`** — TTL-bounded LRU keyed by `sha256(userText + queryMode)`. Default TTL 15s, capacity 1000. Cache hits skip the IndexManager search entirely.
- **`runActiveMemory` integration** — accepts optional `breaker` + `cache` + `agentKey` + `runId` + `persistTranscripts` + `cwd`. Breaker is consulted on entry and updated by status; cache stores results on the way out; transcripts written under `.theokit/memory/transcripts/active-memory/<runId>.json` when enabled.
- **`persistActiveMemoryTranscript`** — JSON transcript persistence. Failures swallowed with stderr warning so transcript IO never crashes the agent run.

### Added (memory-system parity, Phase 7)

- **`runActiveMemory`** — blocking pre-send recall (ADR D6). Default `mode: "search"` calls `IndexManager.search` deterministically; `mode: "subagent"` (LLM-mediated curation) is stubbed for Phase 7.1. Query modes: `"message"` (only the user text), `"recent"` (user text + last N user turns, default 2), `"full"` (entire conversation). Hard timeout via `Promise.race` (default 15000ms) — returns `status: "timeout"` instead of throwing.
- **Status discriminator** — `ActiveMemoryStatus` covers `"ok" | "timeout" | "skipped" | "no-recall" | "error"`. Caller-side dispatch is one switch statement.
- **`ActiveMemoryPromptProvider`** at priority 5 (before context/skills/memory) — contributes the `<active-memory>` block via `SystemPromptAssemblyContext.activeMemorySummary`. Summary is XML-escaped (D9). Block omitted when summary is empty.
- **Pipeline auto-registration** — `SystemPromptPipeline.default()` now wires 5 providers: ActiveMemory (5) → Context (10) → Skills (20) → Memory (30) → Base (100).

### Added (memory-system parity, Phase 6)

- **`memory_search` + `memory_get` tools** (ADR D5) with well-defined JSON schemas and descriptions. `memory_search` returns ranked hits with `{ path, startLine, endLine, score, snippet, citation, source }`; `memory_get` returns bounded excerpts with truncation info.
- **Path-traversal guard (EC-2)** — `memory_get` resolves the requested path against the memory root and throws `ConfigurationError(code: "memory_path_escapes_root")` if the resolved path escapes (e.g. `../../etc/passwd`).
- **Result-size cap (EC-10)** — `memory_search` truncates the response when concatenated snippets exceed `maxTotalChars` (default 16384). Low-rank hits are dropped first; `truncated: true` marker on the payload.
- **Agent-loop integration** — new `AgentLoopInputs.memoryTools?: MemoryToolSpec[]` field; `collectTools` appends memory tools alongside shell + MCP tools; `tool-dispatch` routes `origin === "memory"` calls through a dedicated handler that wraps JSON-encoded results.

### Added (memory-system parity, Phase 5)

- **sqlite-vec vector index** under the existing SQLite DB (ADR D2). `vec0` virtual table stores per-chunk embeddings; `vectorSearch` runs KNN with `MATCH` syntax. `loadSqliteVecExtension` wraps the native load with a typed `sqlite_vec_unavailable` ConfigurationError (EC-8) instead of a raw native exception.
- **`meta` table tracks embedding identity** (`providerId` + `model` + `dimension`). On `IndexManager.open`, current adapter config is compared against stored meta — any mismatch drops the `embeddings` table and forces a full re-embed on next `sync()` (EC-1).
- **Hybrid scoring** (ADR D4): FTS top-K + vector top-K merged, scores combined via `vectorScore * vectorWeight + textScore * textWeight` (defaults `0.6` / `0.4`, configurable per-call). Vector-only hits surface alongside FTS hits via a chunk-id outer join. `MemorySearchHit.vectorScore` exposed when vector backend is active.
- **`IndexManager.open({ cwd, embedding? })`** — embedding-aware constructor. FTS-only still works when `embedding` is omitted; backend reported via `status().backend` as `"fts-only"` or `"hybrid"`.

### Added (memory-system parity, Phase 4)

- **`MemoryEmbeddingProviderAdapter` interface** (ADR D3) defines the adapter contract: `id`, `defaultModel`, `transport`, `authProviderId`, `autoSelectPriority`, `create(options) → EmbeddingRuntime`. Adapters live under `internal/memory/adapters/`.
- **OpenAI embedding adapter** (`openai-embedding.ts`) — native fetch only, no `openai` SDK dep. Batches at 100 texts/call. Retries once on 429 + 5xx with linear backoff (EC-9). Empty inputs skipped. Honors `OPENAI_API_KEY` + `OPENAI_API_BASE_URL`. Default model `text-embedding-3-small` (1536 dims).
- **LRU embedding cache** keyed by `sha256(model+text)`. Max 5000 entries; oldest evicted first. Observable via `runtime.stats()` (`cacheHits` / `cacheMisses` / `httpCalls` / `retries`).

### Added (memory-system parity, Phase 3)

- **SQLite + FTS5 index** at `.theokit/memory/.index/memory.sqlite` (ADR D2). Schema: `files`, `chunks`, `chunks_fts` (FTS5 virtual table), `meta`. Triggers keep FTS in sync with `chunks` on insert/delete. WAL mode, foreign keys on. Backed by `better-sqlite3` (optional peer dep) — `node:sqlite` fallback path documented for Node 22.5+.
- **`IndexManager.open / sync / search / status / close`** — full lifecycle. `sync()` walks `MEMORY.md` + `notes/*.md`, computes content hashes, skips unchanged files, deletes old chunks before reindexing changed ones. `search()` runs FTS5 BM25 ranking, returns `MemorySearchHit[]` with `path`, `startLine`, `endLine`, `score`, `textScore`, `snippet`, `source`, `citation` (path:startLine-endLine).
- **Corrupt-DB recovery (EC-7)** — when opening fails with "malformed" / "not a database" / "encrypted" errors, the file is renamed to `<path>.corrupt-<ts>` (plus `-wal` and `-shm` siblings) and the schema is rebuilt from scratch. Diagnostic line emitted to stderr.

### Added (memory-system parity, Phase 2)

- **`chunkMarkdown`** splits markdown by heading boundaries + blank-line paragraph boundaries. Oversize paragraphs split on word-boundary nearest the cap (EC-6) — never mid-word. Each chunk carries `startLine` / `endLine` / `text` / `hash` (sha256) / optional `heading`.
- **`readMemoryFileBounded`** — bounded read with `from` (1-indexed) + `lines` (default 200, matching the `DEFAULT_MEMORY_READ_LINES` constant). Returns `linesReturned`, `totalLines`, `remainingLines`, `truncated` (true when content remains past the slice). Foundation for Phase 6's `memory_get` tool.
- Public types `MemoryChunk`, `MemoryReadResult`, `MemoryFileEntry` in `internal/memory/types.ts` capturing the engine-storage shapes.

### Added (memory-system parity, Phase 1)

- **Markdown-first memory storage** (ADR D1) — facts now persist to `.theokit/memory/MEMORY.md` under a `## Facts` section, human-editable and git-friendly. The legacy JSON file (`.theokit/memory/<namespace>/<scope>-<userId>.json`) migrates one-shot on first read and is deleted afterward (ADR D8). Behavior is preserved: `readMemoryFacts` + `appendMemoryFact` keep their signatures.
- **`replaceFileAtomic` + per-cwd mutex** — every append writes to `<file>.tmp`, fsync, rename; concurrent appends within the same process serialize through a per-`cwd` mutex (edge-case review EC-4). Multi-process safety is out of scope for v1 (documented).
- **`MEMORY.md` section creation** preserves any free-form content the user added (edge-case review EC-5).

### Added (v1-completeness)

- **Memory auto-write-on-send** in the real LLM runtime (ADR D1/D2 of v1-completeness). When `memory.enabled === true` and the user message starts with `Remember: <fact>`, the SDK persists the fact via `appendMemoryFact` BEFORE the LLM call so durability is independent of the LLM. The same `<memory>` block recalls it on subsequent sends. Empty facts are skipped (EC-3); memory must be opt-in (EC-4). Fixture and real-runtime paths share `isMemoryWritePrompt` + `extractMemoryFact` helpers — no behaviour drift between modes.

### Changed (v1-completeness)

- **`Agent.resume(agentId)` now awaits `initialize()`** before returning the LocalAgent handle, matching `Agent.create` semantics. Previously, resumed agents had empty `context.snapshot()`, empty `skills.list()`, and unloaded hooks/plugins/subagents — silent breakage for users (and for Cron's internal use). The fix is monotone: callers that worked before still work; callers that were silently broken are now correct.
- **Real LLM runtime now threads prior session history** into every `agent.send()`. `AgentLoopInputs.priorMessages` carries the user+assistant turns from previous sends on the same agentId; `initLoopContext` prepends them to the LLM message array before the current user message. Enables `Agent.resume(agentId)` to continue a conversation in the real runtime — previously the LLM saw only the latest message. Fixture path was unaffected; it already had session messages wired.
- Removed the now-redundant `persistMemoryFact` wiring from `createFixtureRun`. The shared auto-write path in `LocalAgent.send` covers both fixture and real runtimes; the fixture's `beforeComplete` hook becomes a no-op (its `persistMemoryFact` parameter is unset). Eliminates the double-write hazard the auto-write feature would otherwise introduce in fixture mode (EC-2).

### Added (runtime-gaps fix)

- `SystemPromptPipeline` + `SystemPromptProvider` strategy pattern (ADR D8) — Context (priority 10), Skills (priority 20), Memory (priority 30), Base (priority 100) auto-injected as XML-tagged blocks into the LLM system prompt. Future blocks plug in by writing one new provider class.
- `FallbackLlmClient` wraps the resolved provider chain. On `NetworkError` from the primary handshake, the SDK transparently retries with the next entry (ADR D2). Failover boundary at first event yield — mid-stream errors are NOT retried. Aborted signal between attempts short-circuits the chain (edge-case EC-3).
- `SendOptions.onStep` / `onDelta` now fire in the real LLM agent loop (ADR D1) — `onStep` per completed assistant text turn and per tool call; `onDelta` per `text-delta` token. Callback errors are caught and logged, never crash the run.
- `SkillsSettings.autoInject` (default `true`) — opt out of the `<skills>` block via `AgentOptions.skills.autoInject: false`.
- `MemorySettings` (`AgentOptions.memory`) public type: `enabled`, `namespace`, `userId`, `scope`, `storePath`, `autoInject`. Recalled facts auto-inject as a `<memory>` block on every send.
- `SystemPromptContext.memory` field — recalled facts exposed to custom `systemPrompt` resolvers (appended per the field-order compatibility contract).
- `escapeBlockBody` helper (ADR D9) — every dynamic block body (context source, skill description, memory fact) is XML-escaped before embedding so workspace content containing literal `</context>` cannot break out of its block (prompt-injection defence).

### Added

- Initial package scaffold: dual ESM+CJS build via tsup 8, types-first `exports` map with sub-paths for `.`, `./cron`, and `./errors` (initial scaffold).
- Public type contract from [`docs.md`](../../docs.md): `Agent`, `Run`, `SDKMessage`, `InteractionUpdate`, `ConversationTurn`, `McpServerConfig`, etc. (initial scaffold).
- Error class hierarchy: `TheokitAgentError`, `AuthenticationError`, `RateLimitError`, `ConfigurationError`, `IntegrationNotConnectedError`, `NetworkError`, `UnknownAgentError`, `UnsupportedRunOperationError` (initial scaffold).
- `Cron` namespace skeleton: `Cron.create()`, `Cron.list()`, `Cron.get()`, `Cron.delete()`, `Cron.enable()`, `Cron.disable()`, `Cron.run()` (manual fire), and scheduler control via `Cron.start()` / `Cron.stop()` / `Cron.status()`. Cron job type contract (`CronJob`, `CronCreateOptions`, `CronSchedulerStatus`, etc.) (initial scaffold).
- Smoke test verifying public API is importable and stub methods reject with `ConfigurationError` (initial scaffold).
- Context manager type contract: `ContextSettings`, `ContextSource`, `ContextSnapshot`, `SDKContextManager`. `SDKAgent.context?` exposes the manager when context is enabled via `AgentOptions.context`.
- Provider routing type contract: `ProviderCapability`, `ProviderRoute`, `ProviderRoutingSettings`, `PluginsSettings`, `ResolvedProviderRoute`, `SDKProvidersManager`, `SDKProvider`. `SDKAgent.providers?` exposes the manager. `Theokit.providers.list()` stub for provider catalog reads.

### Changed

- License standardized to **Apache-2.0** (was MIT). Aligns all Theo open-core pillars under a single license — see root `CLAUDE.md` strategic review of 2026-05-14.
- `UnsupportedRunOperationError` now extends `TheokitAgentError` with `isRetryable: false` and stable `code: "unsupported_run_operation"`. Previously extended `Error` directly — old `instanceof TheokitAgentError` checks against this error now return `true`.
- `RunOperation` union extended with `"listArtifacts"` and `"downloadArtifact"`. Agent-level operations can now be reported through `UnsupportedRunOperationError.operation`.

### Changed (runtime-gaps fix)

- Memory recall lifted from the fixture-only path into the shared agent path. A corrupted memory file degrades to "no facts loaded" with a stderr warning instead of crashing the run (edge-case review EC-4).
- `FileContextManager` exposes a new internal `internalAssemblySnapshot()` so the system-prompt pipeline can read per-source token slices without the public `snapshot()` having to leak the same shape.

### Fixed

- 5 previously ⚠️ Partial example flows now work end-to-end against real providers: `examples/streaming-callbacks` (steps/deltas fire), `examples/provider-fallback` (`status=finished` after primary failover), `examples/context-manager` (model answers "8675309"), `examples/skills` (model lists `code-review, doc-writer`), `examples/memory` (model recalls the persisted fact via auto-injected `<memory>` block).
- `setupSchema` of fixture providers no longer leaks env-var-name shaped strings (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ...) that matched the hygiene regex. Schemas now use a generic `credential` property name (internal contract change; public shape unchanged).

### Implementation status (Phase 2 — real runtime)

- **Real cron scheduler** powered by `croner@^9.0.0`. `Cron.start()` installs a timer per enabled local job, `nextRunAt` is computed from the cron expression and timezone, jobs actually fire on schedule. `Cron.disable()` / `Cron.enable()` / `Cron.delete()` add/remove timers without losing the job state.
- **Real hook execution** via `HooksExecutor`: `.theokit/hooks.json` is parsed into events (`preRun`, `postRun`, `preToolUse`, `postToolUse`, `stop`), each fires the configured command with the payload JSON over stdin. Non-zero exit codes deny the operation; JSON stdout can return `{"decision":"allow|deny|feedback","reason"|"feedback"}`. preRun denials throw `ConfigurationError("preRun hook denied execution")` from `agent.send()`. preToolUse denials short-circuit the tool with `exitCode: 126`.
- **Real MCP client** for `stdio` (spawn + JSON-RPC over stdin/stdout) and `http` (fetch+JSON-RPC). Implements `initialize`, `tools/list`, `tools/call` per MCP 2024-11-05.
- **Real shell tool** spawning `sh -c <command>` with stdout/stderr capture, SIGKILL-on-timeout, and a sandbox heuristic that refuses obvious unsafe commands when `local.sandboxOptions.enabled` is true.
- **Real LLM provider clients** (Anthropic Messages SSE, OpenAI Chat Completions SSE, OpenRouter via the OpenAI shape). Use native `fetch` only — no SDK dependencies. Translate vendor SSE deltas into a provider-agnostic `LlmEvent` stream + `LlmFinish` accumulator.
- **Real agent loop** orchestrates the LLM-tool-LLM cycle: system event → user event → LLM stream → assistant event → optional `tool_use` dispatch (with preToolUse + postToolUse hooks) → result fed back → next turn. Max 8 iterations by default.
- **Real cloud Run** via Theo PaaS SSE: `POST /v1/agents/{id}/runs` with `accept: text/event-stream`, translates `status`, `assistant`, and `result` events into the SDK `SDKMessage` stream. Activates when a non-fixture API key + `THEOKIT_API_BASE_URL` are set.
- **Streaming progressive events**: `Run.stream()` is now a true progressive AsyncGenerator — events arriving from the real runtime over time are yielded as soon as they're appended, not only at termination.
- **Real local runtime activation**: when the API key is not a `theo_test_*` fixture key and at least one of `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` is set, `LocalAgent.send()` routes through the real agent loop instead of fixture mode.

### Implementation status (Phase 1 — fixture-mode parity)

- `Agent.create()`, `Agent.send()` (both local + cloud), `Agent.resume()`, `Agent.list()`, `Agent.get()`, `Agent.listRuns()`, `Agent.getRun()`, `Agent.archive()`, `Agent.unarchive()`, `Agent.delete()` — implemented with deterministic fixture-mode responses for `theo_test_*` API keys.
- `Theokit.me()`, `Theokit.models.list()`, `Theokit.repositories.list()`, `Theokit.providers.list()` — implemented; route to real HTTP when `THEOKIT_API_BASE_URL` is set, otherwise serve fixture data.
- `Cron.create()` / `list()` / `get()` / `delete()` / `enable()` / `disable()` / `run()` — implemented with POSIX cron and shorthand validation, IANA timezone validation, and deterministic `nextRunAt` estimate.
- File-based discovery from `.theokit/`: `agents/*.md` (subagents), `skills/<name>/SKILL.md`, `plugins/<name>/plugin.json`, `mcp.json`, `hooks.json`, `context.json`, `cron/jobs.json`, `memory/<scope>.json`.
- Run lifecycle: `stream()` (AsyncGenerator of SDKMessage), `wait()`, `cancel()`, `conversation()`, `onDidChangeStatus()`. Status machine: `running → finished | error | cancelled`.
- Cloud runtime adapter calls Theo PaaS when `THEOKIT_API_BASE_URL` is set; otherwise emulates PaaS via fixture mode (CREATING / RUNNING / FINISHED status events, git metadata on result, artifact listing/download).
- Memory subsystem: file-backed store under `.theokit/memory/`, redacted public surface, namespace/scope keying.
- Skills, plugins, MCP, hooks, subagents, providers, context — public managers and file-based loaders.
- Quality Gates G1–G10 all green: typecheck, lint+format (Biome), publint, attw, smoke + roadmap tests (136/136), knip (dead code), depcruise (cycles), G8 LoC ≤ 400, G9 cognitive complexity ≤ 10, G10 jscpd 0 clones.
