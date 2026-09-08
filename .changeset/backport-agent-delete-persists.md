---
"@theokit/sdk": patch
---

`Agent.delete` removes the entry from the persisted registry (backport of #612)

Fixed on the 5.x line in `5.3.1`; this is the same fix for the 4.x maintenance line, where every stable consumer in the ecosystem still lives.

It was a no-op against `registry.json` whenever the agent was not already in the calling process's memory — which is every agent in a freshly started process, so every CLI invocation:

```ts
static async delete(agentId: string, _options: AgentOperationOptions = {}): Promise<void> {
  removeRegisteredAgent(agentId);   // Map is empty → returns false → no save scheduled
  await flushRegistrySaves();       // flushes an empty queue
}
```

The method returns `Promise<void>` and throws nothing when it removed nothing, so a caller had no way to notice. `usetheokit/theokit` had a docblock promising a completed registry removal on the strength of it.

**Why this is an omission rather than a design:** every neighbouring mutator already hydrates. `Agent.rename` and `Agent.archive` reach `getRegisteredAgentOrThrow`, which loads from disk on a miss; `delete` was the only one that never did.

`options.cwd` is now read instead of being defaulted away — it is declared on `AgentOperationOptions` and the parameter was `_options`. Hydrating `process.cwd()` unconditionally would leave the delete broken for exactly the caller that names a project other than the one it is running in.

**Deliberately unchanged, matching 5.x:** deleting an unknown id still resolves rather than throwing. That would be a breaking change for callers that delete idempotently, and an entry and its transcript can legitimately outlive one another in both directions.

Four regression tests ship with it, including the `Agent.rename` control — without a control known to pass, a red bar there is indistinguishable from a broken harness.
