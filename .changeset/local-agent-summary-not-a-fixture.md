---
"@theokit/sdk": patch
---

A local agent's public `summary` is a runtime label, not a fixture name (#611)

`SDKAgentInfo.summary` is `@public` and required, returned by `Agent.list()` and `Agent.get()`.
`registerLocalAgent` assigned it unconditionally:

```ts
summary: "Local contract fixture",
```

So that string was the **only** value the field could hold for a local agent, and `AgentOptions`
exposes no `summary` for a consumer to override it. It was found on a real user's session record on
disk, written through a consumer by a real turn — nothing about the run was a fixture.

The cloud sibling faces the same requirement and guards it, which is what makes this an omission
rather than a decision:

```ts
summary: this.isFixtureMode() ? "Cloud contract fixture" : "Cloud agent",
```

`isFixtureMode()` keys off a `theo_test_*` key with no configured base URL — it describes whether
the *remote* is stubbed, so there is no local equivalent to port. The local branch therefore takes
the cloud branch's non-fixture value: **`"Local agent"`**.

The `toLocalAgentInfo` / `toCloudAgentInfo` **fallbacks** carried the same two literals and move
with it. That pair is the reason this was worth fixing carefully rather than quickly: while the
registration wrote a fixture name unconditionally, the fallback could never be observed, so fixing
only the reachable site would have left the string ready to reappear for any record that arrives
without a summary.

Consumers rendering `summary` will see `Local agent` where they previously saw
`Local contract fixture`. Nothing reads the value programmatically in this package; a consumer that
matched on the old string was matching on a placeholder.
