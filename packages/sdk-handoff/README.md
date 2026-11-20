# @theokit/sdk-handoff

Inter-agent dispatch for `@theokit/sdk`. Typed `Handoff` descriptors with loop protection (self-reference, A↔B pair, multi-hop, receiver-disposed).

Extracted from `@theokit/sdk@1.7.0` as part of the SDK 2.0 package split (ADRs D214-D229).

## Install

```bash
pnpm add @theokit/sdk @theokit/sdk-handoff
```

## Quick start

```typescript
import { Agent } from "@theokit/sdk";
import { Handoff } from "@theokit/sdk-handoff";

const billing = await Agent.create({
  name: "billing",
  model: { id: "openai/gpt-4o-mini" },
});

const support = await Agent.create({
  name: "support",
  model: { id: "openai/gpt-4o-mini" },
  // Preferred (new in 2.x): handoffs wire via Plugin protocol.
  plugins: [Handoff.asPlugin({ targets: [billing] })],
});

await support.send("I need help with my invoice");   // → support delegates to billing
```

The previous `Agent.create({ handoffs: [...] })` option is **deprecated** in 2.x. It still works while `@theokit/sdk-handoff` is installed (the framework lazy-imports the tool-injector at runtime), but the codemod marks every call site with a `CODEMOD` comment recommending the `plugins: [Handoff.asPlugin({...})]` pattern. Plan removes the option entirely in 2.0.0 cohort.

## API

### `Handoff.asPlugin({ targets, maxHandoffDepth? }): Plugin`

Returns a `Plugin` consumed by `Agent.create({ plugins: [...] })`. The plugin runs at agent initialization and appends one `CustomTool` per target agent into the host's tool registry. Each invocation of the tool dispatches the conversation to the target agent (loop-protected).

| Option | Type | Default | Notes |
|---|---|---|---|
| `targets` | `Array<SDKAgent \| HandoffDescriptor>` | (required) | Agents the host can hand off to. |
| `maxHandoffDepth` | `number` | `5` | Hop count cap. `0` disables handoff entirely. |

### Errors

All errors extend `Error` and live in `@theokit/sdk-handoff`:

- `HandoffLoopError` — multi-hop loop detected at runtime (A→B→C→A).
- `HandoffPairLoopError` — A→B and B→A registered simultaneously.
- `HandoffSelfReferenceError` — agent handoffs to itself.
- `HandoffReceiverDisposedError` — target was disposed before dispatch.
- `HandoffNameCollisionError` — two targets share the same agent name.

### `handoffTo(agent, opts?): HandoffDescriptor`

Helper for one-off descriptor construction without going through `Handoff.create`.

## How it fits with `@theokit/sdk`

- **Foundation:** `definePlugin`, `Plugin`, `CustomTool`, and `SDKAgent` types come from `@theokit/sdk`.
- **Optional peer model:** `@theokit/sdk@1.7.0` lazy-imports `@theokit/sdk-handoff/internal/tool-injector` only when `Agent.create({ handoffs: [...] })` is called. Without the package installed, the option throws an actionable error.
- **No kernel coupling beyond types:** sdk-handoff never imports from `@theokit/sdk/internal/runtime` or the agent loop.

## What `internal` means here

`@theokit/sdk-handoff/internal/*` subpaths are internal: they carry no compatibility promise and may change or disappear in any release. They exist for `@theokit/sdk`, not for application code.

| Subpath | Caller |
| --- | --- |
| `tool-injector` | `@theokit/sdk` (`packages/sdk/src/internal/agent/helpers.ts`) |

`@theokit/sdk` loads `@theokit/sdk-handoff/internal/tool-injector` as an optional peer by dynamic import, so renaming the subpath breaks `Agent.create({ handoffs })` at runtime, not at build time. The SDK declares no peer range for sdk-handoff; the subpath and the functions the SDK expects from it have existed since `@theokit/sdk-handoff@0.1.0`.

## Migration from `@theokit/sdk@1.x`

Before (1.x):

```typescript
import { Agent, Handoff, handoffTo } from "@theokit/sdk";

const support = await Agent.create({
  name: "support",
  handoffs: [billing],
});
```

After (2.x):

```typescript
import { Agent } from "@theokit/sdk";
import { Handoff } from "@theokit/sdk-handoff";

const support = await Agent.create({
  name: "support",
  plugins: [Handoff.asPlugin({ targets: [billing] })],
});
```

See the monorepo `CHANGELOG.md` for the 1.x → 2.0 package-split migration notes.

## API reference

Every symbol this package exports, with the exact specifier to import it from, is in the generated
capability map that ships inside `@theokit/sdk`:

```
node_modules/@theokit/sdk/docs/harness-capability-map.md   # symbol -> import specifier
node_modules/@theokit/sdk/docs/error-codes.md              # every `code` an error can carry
```

Both are generated from the built type declarations, so they describe the version you installed
rather than the version someone wrote a page about.

## License

Apache-2.0.
