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

## Status

The full contract is defined by the exported TypeScript types; see [`CHANGELOG.md`](./CHANGELOG.md) for the release history.

## License

MIT — see [LICENSE](./LICENSE).
