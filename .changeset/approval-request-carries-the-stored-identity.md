---
"@theokit/sdk": minor
---

A hook approval request carries the identity a consumer stored ([#637](https://github.com/usetheokit/theokit-sdk/issues/637))

`local.hooks.approve` let a consumer refuse a hook. It did not let one **approve** a particular
hook, because the two sides could not compute the same fingerprint — so the only workable policy
was to refuse everything, and a hook a user deliberately wrote could not be run.

`HookApprovalRequest` now carries two more fields:

```ts
local: {
  hooks: {
    approve: ({ command, sourceEvent, matcher, timeoutMs }) =>
      myStore.has(hash({ command, event: sourceEvent, matcher, timeoutMs })),
  },
}
```

- **`timeoutMs`** — the timeout the runtime **will apply**, default already resolved. A config
  that omits `timeout` still runs under one (30s); reporting `undefined` there would make every
  consumer reimplement this package's default to reproduce a stored hash, and a default duplicated
  across a boundary is a default that drifts.
- **`sourceEvent`** — the event key exactly as the config file spelled it (`PreToolUse`), which is
  not `event` (`preToolUse`). An approval is taken against the file shown to the user, so the
  stored fingerprint is over the file's vocabulary. The literal key rather than a published
  mapping table, because a mapping is a second thing to keep in step with the first.

Both are **required**, not optional: `parseClaudeCodeCommand` is this package's only producer of a
hook command, so every hook reaching the gate has both. An optional field would hand every
consumer a fallback branch for a case that cannot occur, and in a security gate each extra branch
is a second answer to one question.

Matching on the subset that survived was the tempting fix and is the wrong one — it would be a
second identity answering the same question, which is how one ends up approving what the other
refuses.

Reading a request is unaffected; nothing that compiled before stops compiling.
