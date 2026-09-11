---
"@theokit/sdk": minor
---

An organisation can impose policy on an agent. `managed-settings.json` is read, and the project cannot switch it off.

Measured: `grep -rl managed-settings` returned 0 here, 0 in the 4.52.1 dist and 0 in the 5.5.0 dist,
against a control of 31 files for `hooks`. Claude Code defines the file as settings a user "cannot
override, except for limited exceptions". An organisation that deployed one got it dropped in
silence, while the same file was enforced by the tool it was written for.

**This was not an incomplete feature — it was an ignored security control**, and the failure
direction is permit.

The decision behind it is recorded in `packages/agents/README.md` § "Who decides policy": an
operator who did not write the code CAN impose policy on it. Hooks, MCP servers, permissions and
skill execution were each a value the *programmer* passed at build time — defensible for a framework,
indefensible for anything an organisation deploys, because the person answerable for what an agent
may do on a machine had no way to say so.

Precedence, highest first: `managed-settings.json` → the project's `settings.json` →
`defineAgent({ … })`.

**The first control lifted is `disableAllHooks`**, because its absence is the hardest to notice: a
hook that does not run looks identical to a hook that ran and approved. It is a **veto, not a
merge** — a project file setting `disableAllHooks: false` loses, since a tier the layer below can
switch off is not a tier. It is also checked before `settingSourcesIncludeProject`, which is the
programmer choosing whether to read the project's files at all.

**Unknown keys are reported, never carried.** An organisation writing `forceModel` into the policy
and getting silence would conclude the model is forced; carrying the key through would spread that
belief downstream. The reports go through `diagFailure`, not `diag` — `diag` returns immediately when
no sink is installed, and most consumers never install one, so a policy channel using it would be
silent by default about the one thing this tier exists to make certain.

`readManagedSettings` and `ManagedSettings` cross the barrel so a HOST can read the policy the
runtime enforces instead of guessing at it. This is not the only reader: `@theokit/agents` ships from
a separate repository against a *published* version of this package, so it carries its own reader of
the same file. One FORMAT is the contract; two readers that release independently is a consequence of
the repository boundary.

Platform paths are Claude Code's own (`/etc/claude-code/`, `/Library/Application Support/ClaudeCode/`,
`%PROGRAMDATA%\ClaudeCode\`), so an organisation that already deployed a policy does not have to
deploy a second copy under a different name.

`permissionMode` and `permissions` join `disableAllHooks` and `disableSkillShellExecution` as keys an
operator may impose. `plan` is the one the posture key exists for — an explore-only run where edits
are structurally refused; a plan-mode *tool* already existed and it is something the model may call,
and the difference is who decides. A posture outside the four is reported and ignored: `"readonly"`
is what somebody writes when they mean `plan`, and applying it by shape would enforce a posture
nobody defined while dropping it silently would leave them believing edits are refused.

