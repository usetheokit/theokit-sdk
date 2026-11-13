<p align="center">
  <a href="https://github.com/usetheokit/theokit-sdk">
    <img src="https://raw.githubusercontent.com/usetheodev/theokit-sdk/main/assets/logo.png" alt="TheoKit" height="96" />
  </a>
</p>

<p align="center">
  <h1 align="center">@theokit/sdk</h1>
  <p align="center">
    <strong>TypeScript SDK for the Theo agent harness</strong>
  </p>
  <p align="center">
    Same agent surface, local or cloud. No vendor lock-in.
  </p>
  <p align="center">
    <a href="https://github.com/usetheokit/theokit-sdk/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-DE2329?style=flat-square"></a>
    <img alt="TypeScript" src="https://img.shields.io/badge/typescript-5.8%2B-3178C6?style=flat-square&logo=typescript&logoColor=white">
    <img alt="Node" src="https://img.shields.io/badge/node-22.12%2B-339933?style=flat-square&logo=node.js&logoColor=white">
    <img alt="Status" src="https://img.shields.io/badge/status-public%20beta-orange?style=flat-square">
  </p>
</p>

---

> **Public beta.** APIs may change before general availability.

For the full reference, see the [root README](https://github.com/usetheokit/theokit-sdk#readme). The exported TypeScript types are the canonical contract.

## Capability map

New here? The exported TypeScript types are the discovery front-door and the canonical contract — every harness primitive with its import path, signature and JSDoc example (`compactTranscript`, `buildRepoMap`, `isTransientError`, `@theokit/sdk/persistence`, ...), surfaced by your editor.

Two references ship inside the package — no network, pinned to the version you installed, and both
GENERATED from the built declarations so they cannot drift from what you actually got:

```
node_modules/@theokit/sdk/docs/harness-capability-map.md   # every public symbol + its exact import specifier
node_modules/@theokit/sdk/docs/error-codes.md              # every `code` an error can carry, and where it is raised
```

If you are an agent: read the capability map before writing an import. Several symbols are reachable
from more than one specifier, and a class emitted into a subpath entry is a DISTINCT nominal type
from the one in the root bundle — import a symbol and everything you pass it to from the same
specifier, or the call fails on a private field.

Agents that consume documentation should prefer the machine-readable corpora on the docs site ([llmstxt.org](https://llmstxt.org) convention): [`llms.txt`](https://docs.usetheo.dev/llms.txt) (curated index) and [`llms-full.txt`](https://docs.usetheo.dev/llms-full.txt) (every page inlined).

## Install

```bash
npm install @theokit/sdk
```

## Quick start

```typescript
import { Agent } from "@theokit/sdk";

const agent = await Agent.create({
  apiKey: process.env.THEOKIT_API_KEY!,
  model: { id: "composer-2" },
  local: { cwd: process.cwd() },
});

const run = await agent.send("Summarize what this repository does");

for await (const event of run.stream()) {
  console.log(event);
}
```

## Native Claude Code sessions

A local agent's conversation is a native Claude Code `.jsonl` transcript on disk — there is no proprietary session store. Point `baseDir` at `~/.claude` and the Claude Code CLI can `--continue` a session your agent wrote:

```typescript
const agent = await Agent.create({
  apiKey: process.env.THEOKIT_API_KEY!,
  model: { id: "openai/gpt-4o-mini" },
  local: { cwd: process.cwd(), baseDir: "~/.claude" },
});
// After runs finish, `claude --continue` picks up the same session on disk.
```

Extended-thinking `--continue` is out of scope for now (thinking signatures are written but dropped on read — issue #122). See the exported session-persistence types for the full contract.

## Memory

Durable facts live under `<cwd>/.theokit/memory/`. To keep several users of one agent app apart, give each agent a `userId`; each user then gets their own partition (`.theokit/memory/users/<userId>/`) for facts, index and session summaries:

```ts
const alice = await Agent.create({ memory: { enabled: true, userId: "alice" } });
const bob = await Agent.create({ memory: { enabled: true, userId: "bob" } });
// Facts recorded by alice are never recalled or returned by memory_search for bob.
```

`userId` must match `[a-z0-9][a-z0-9-_]*`; other values (such as `../x`) are rejected.

### List and remove memory facts

```ts
import { listMemoryFacts, removeMemoryFact } from "@theokit/sdk";

const facts = await listMemoryFacts(process.cwd());
// [{ id, text, modified?, root, removable }, ...]
const removed = await removeMemoryFact(process.cwd(), facts[0].id); // true, or false for an unknown id
```

`listMemoryFacts` covers per-memory files and legacy `## Facts` bullets, in the order the agent reads them. `removeMemoryFact` deletes the file and its `MEMORY.md` index line (or one legacy bullet), serialized with the SDK's writes. Entries from another tool's store (for example the Claude Code CLI's) have `removable: false`, and removing one rejects with `MemoryFactNotRemovableError`. Removal does not touch the memory search index; the next index refresh drops the entry.

## Plugins

`listWorkspacePlugins(cwd, { compatSources })` lists the plugins an agent opened on `cwd` would load
(name, folder, manifest path and format), using the same discovery and manifest code as the runtime
and without running plugin code. It reads the project's `.theokit/plugins` plus the plugin roots of
the declared `compatSources`, never `~/.theokit/plugins`.

```ts
import { listWorkspacePlugins } from "@theokit/sdk";

const plugins = await listWorkspacePlugins(process.cwd(), { compatSources: ["claude-code"] });
```

## Schedule with cron

```typescript
import { Cron } from "@theokit/sdk";

await Cron.create({
  cron: "0 9 * * *",
  timezone: "America/Sao_Paulo",
  message: "Summarize yesterday's commits",
  agent: {
    apiKey: process.env.THEOKIT_API_KEY!,
    model: { id: "composer-2" },
    local: { cwd: process.cwd() },
  },
});

await Cron.start();   // required for local jobs to fire
```

Two runtimes: **local** (in-process scheduler — fires while the host process is alive) and **cloud** (Theo PaaS schedules server-side). See the exported `Cron` types for the full contract.

## Bounded subprocesses

```ts
import { runBounded } from "@theokit/sdk/process";

const r = await runBounded({ command: "sh", args: ["-c", "make test"], cwd: process.cwd(), timeoutMs: 60_000 });
if (r.timedOut) console.error("timed out");
if (r.truncated.stdout) console.error("stdout was cut at maxOutputBytes");
```

`runBounded` spawns the child in its own process group (POSIX) and sends `SIGKILL` to the whole group on timeout or when `signal` aborts, so pipelines and background jobs die with it. Each of stdout and stderr is capped at `maxOutputBytes` (default 5 MiB) and `truncated` says which was cut. `timeoutMs <= 0` throws `ConfigurationError`. On Windows process groups do not apply: only the child itself is killed. The `shell` tool and command hooks use this runner; a truncated stream gets a trailing `[output truncated]` note.

## `@theokit/sdk/context`

`runDiscovery` finds context files (`AGENTS.md`, `CLAUDE.md`, ...) and inlines their `@path` imports.

- **List patterns.** A `DiscoverySpec` with `scope: "cwd-only"` or `"git-root-walk"` may set `pattern: ["THEO.md", "AGENTS.md", "CLAUDE.md"]`. Each directory contributes only the first name that exists. A list on a `"globbed"` spec throws `ConfigurationError` naming the spec id.
- **`wrapImport(name, content)`.** Wraps each inlined `@import` at every depth, e.g. `(n, c) => \`--- import: ${n} ---\n${c}\n--- end import ---\``. Refusal and not-found placeholders are never wrapped. Default: content unchanged.
- **Already loaded.** A file discovery emits is not inlined again by an import; the import line becomes `[@import already loaded: <path>]`.

## Status

The full contract is defined by the exported TypeScript types; see [`CHANGELOG.md`](./CHANGELOG.md) for the release history.

## License

MIT — see [LICENSE](./LICENSE).
