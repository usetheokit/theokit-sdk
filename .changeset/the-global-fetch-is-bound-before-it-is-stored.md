---
'@theokit/sdk': patch
---

`fetch` is bound to its receiver before it is stored or passed, so a provider transport works on
Cloudflare Workers.

Thirteen call sites across eleven files wrote `options.fetch ?? fetch`, which detaches the global
from its receiver. Node's undici tolerates that. workerd does not — calling the detached reference
as a property of another object, or as a bare function in a module where `this` is `undefined`,
throws `Illegal invocation: function called with incorrect this reference`.

Measured on a deployed worker while driving a real turn (theokit#705), and reached only after two
filesystem defects in this package were cleared, so it was the fourth layer of one deploy:

    agent turn failed (AGENT_ERROR): openrouter transport failure on /v1/chat/completions:
    Illegal invocation: function called with incorrect `this` reference.

The turn that failed went through `internal/llm/openai.ts`. Fixing only that one would have left
twelve identical landmines — every other provider, the memory adapter, the credential resolver, the
cloud-run client — each of them a deploy that fails on its first request. `internal/runtime-fetch.ts`
is now the one place that knows the rule: `boundFetch(override?)` returns an injected fetch
untouched, so a test double still reaches the transport as itself, and otherwise returns
`globalThis.fetch.bind(globalThis)`.

Binding where the reference is taken, rather than a `(0, f)(…)` at each invocation, fixes every call
that reference will ever receive and gives the sweep in `tests/runtime/fetch-is-bound.test.ts`
something it can assert: no source file under `src/` takes a detached reference to the global.
