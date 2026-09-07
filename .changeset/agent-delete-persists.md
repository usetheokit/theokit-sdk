---
"@theokit/sdk": patch
---

`Agent.delete` removes the entry from the persisted registry (#612)

It did not. The method was a no-op against `registry.json` whenever the agent was not already in the
calling process's memory — which is every agent in a freshly started process, so every CLI
invocation:

```ts
static async delete(agentId: string, _options: AgentOperationOptions = {}): Promise<void> {
  removeRegisteredAgent(agentId);   // Map is empty → returns false → no save scheduled
  await flushRegistrySaves();       // flushes an empty queue
}
```

`Agent.delete` returns `Promise<void>` and throws nothing when it removed nothing, so a caller had no
way to notice. Measured downstream as a `sessions delete` that reported success and exited 0 while
the session stayed in the listing — the transcript really was removed, leaving a registry entry
pointing at a file that no longer existed.

**What makes this an omission rather than a design:** every neighbouring mutator already hydrates.
`Agent.rename` and `Agent.archive` reach `getRegisteredAgentOrThrow`, which loads from disk on a
miss; `delete` was the only one that never did.

`options.cwd` is now read instead of being defaulted away — it is declared on
`AgentOperationOptions` and the parameter was `_options`. Hydrating `process.cwd()` unconditionally
would repeat B-115 (a documented option that compiles and does nothing) on the one path whose job is
to remove data.

**Deliberately unchanged:** deleting an unknown id still resolves rather than throwing. Matching
`rename`'s `UnknownAgentError` is defensible, but it is a breaking change for callers that delete
idempotently, and an entry and its transcript can legitimately outlive one another in both
directions. A persistence fix should not smuggle in an API break.

Consumers that already called `Agent.delete` and observed the entry surviving will now see it
removed. Nothing that behaved correctly before changes.
