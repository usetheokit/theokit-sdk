# @theokit/sdk-memory

Memory subsystem for [`@theokit/sdk`](https://www.npmjs.com/package/@theokit/sdk).
Implements the kernel-facing `MemoryProvider` port (SDK 2.0 Phase 1 / T1.1 —
Hexagonal Architecture / SOLID Dependency Inversion).

## Install

```bash
pnpm add @theokit/sdk-memory
```

`@theokit/sdk` (>=4.0.0) is a peer dependency. Three more are OPTIONAL, and which you need depends
on the backend you ask for — the in-memory markdown provider needs none of them:

```bash
pnpm add better-sqlite3      # only when your Node has no built-in `node:sqlite`
pnpm add sqlite-vec          # vector recall; without it, search is text-only
pnpm add @lancedb/lancedb    # `backend: "lance"`, for large corpora
```

The three behave differently when absent, and the difference is worth knowing before you debug a
thin answer:

- **`better-sqlite3`** — the driver is chosen at runtime. `node:sqlite` is used where the running
  Node exposes it (22.5+), and this package is the fallback. Opening fails only on a Node without
  the built-in AND without this installed.
- **`sqlite-vec`** — the index opens without it and reports `backend: "fts-only"`. Search still
  works, by TEXT only; no vector table is created. This is a silent degradation by design, so check
  `index.status().backend` when recall seems shallow.
- **`@lancedb/lancedb`** — asking for `backend: "lance"` without it raises
  `ConfigurationError({ code: "lance_backend_unavailable" })` at open time, naming the install
  command. No silent fallback, because a large-corpus backend quietly becoming a small one is worse
  than a refusal.

```ts
import { Agent } from "@theokit/sdk";
import { createInMemoryMarkdownProvider } from "@theokit/sdk-memory";

const agent = await Agent.create({
  agentId: "support-bot",
  model: { id: "anthropic/claude-3-5-haiku-latest" },
  memoryProvider: createInMemoryMarkdownProvider(),
  // ...other options
});
```

## What ships today (Unreleased, post v0.1.0)

`createInMemoryMarkdownProvider()` is now a real cross-session recall
provider with the full canonical memory surface:

| Method | What it does |
|---|---|
| `init(opts)` | Captures `cwd` for disk paths; sets up per-agent in-process Map. |
| `buildTools()` | Surfaces **2 LLM-facing tools**: `memory_remember(content)` + `memory_search(query)`. |
| `runActivePass()` | Combines in-process facts (this session's Map) AND disk-recalled session summaries (previous sessions, substring-matched against user message). Up to 5 hits. |
| `recordSessionSummary()` | Real filesystem write to `${cwd}/.theokit/memory/sessions/${runId}.md`. Atomic via sdk-core's `replaceFileAtomic`. Same semantics as sdk-core's legacy `writeSessionSummary`. |
| `sync()` | No-op (in-process Map writes are synchronous). |
| `dispose()` | Clears in-process Map. Disk artefacts persist by design (cross-session recall). |

LLM-facing tools surfaced via `buildTools`:

- **`memory_remember(content)`** — the LLM writes a fact to the
  per-session Map. Useful for "remember this for the rest of this
  conversation" use cases.
- **`memory_search(query)`** — the LLM queries previously-written
  session summaries on disk. Returns up to 5 short snippets as JSON.
  Useful when the user asks about something from a past conversation.

## What's coming (future versions)

- `createLanceMemoryProvider(...)` — persistent LanceDB-backed store
  with **embedding-based ANN recall** (replaces the current substring
  matcher) via OpenAI / Ollama / Voyage embedding adapters.
- Circuit-breaker + active-memory cache for hot-path resilience.
- Multi-adapter fan-out (write to multiple stores; merge-dedup recall).
- Dreaming sweep + memory revisions.

## Cross-package coupling: `@theokit/sdk/internal/persistence`

sdk-memory's `recordSessionSummary` consumes
`replaceFileAtomic` from sdk-core via the
`@theokit/sdk/internal/persistence` sub-path (per ADR-008). The sub-path
is internal API — semver-exempt; may break in patch releases. Pin both
packages to the same SemVer minor when upgrading sdk-core.

The cross-package import keeps the **single-process mutex Map invariant**
intact (one module instance shared across packages — both writers
serialize against the same registry).

## Architecture

This package is a **port consumer**, not a kernel mod. The contract
lives in `@theokit/sdk/internal/runtime/memory-provider.ts` and is
exposed to consumers via:

```ts
import type {
  MemoryProvider,
  MemoryProviderHandle,
  MemoryProviderInitOptions,
  ActiveMemoryPassArgs,
  ActiveMemoryPassResult,
} from "@theokit/sdk";
```

The agent loop calls the port's four lifecycle methods at well-defined
hook points (init / buildTools / runActivePass / dispose). Your impl
fulfills the contract; sdk-core never imports this package directly —
that's the seam that makes the split possible.

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

Apache-2.0 © useTheo

## Choosing a backend from the environment

`memoryBackendFromEnv(env, { variable?, importer? })` reads `THEOKIT_MEMORY_BACKEND` (override with
`variable`) and returns `undefined` for unset, empty or `builtin`, otherwise a choice with `name`,
`mirrored` and `agentOptions()`.

| Name | Key variable | Install |
| --- | --- | --- |
| `mem0` | `MEM0_API_KEY` | `@theokit/memory-mem0` + `mem0ai` |
| `honcho` | `HONCHO_API_KEY` | `@theokit/memory-honcho` + `@honcho-ai/sdk` |
| `supermemory` | `SUPERMEMORY_API_KEY` | `@theokit/memory-supermemory` + `supermemory` |
| `sdk-memory` | none | this package (in-process, not persisted across restarts) |

```ts
const choice = memoryBackendFromEnv(process.env);
const agent = await Agent.create({ model, ...(await choice?.agentOptions()) });
```

An unknown name or a missing key throws a `ConfigurationError` when called; a missing adapter package
or peer rejects `agentOptions()` with an error naming both. Hosted choices are `mirrored: true`.
