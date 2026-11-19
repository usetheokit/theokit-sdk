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

## Squad cancellation and disposal

`Squad.run(input, options?)` takes `SquadRunOptions`:

- `signal` — aborting cancels the member run in flight; the run resolves with `status: "cancelled"`.
- `timeoutMs` — shorthand for a timer signal; on expiry the run resolves with `status: "cancelled"` and `timedOut: true`.

Members built from an `AgentDefinition` are always disposed after the run. Pass `ownsMembers: true` to `Squad.create` to also dispose the `SDKAgent` members you passed in (default `false`). A disposal failure never fails the run; it goes to `onDisposeError(error, memberIndex)` (default: a redacted diagnostic).

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

## Builtin tool names

`BUILTIN_TOOL_NAMES` (`"shell"`, `"memory_search"`, `"memory_get"`) lists the tools the SDK declares itself; these are the names `withheldBuiltinTools` accepts and a custom tool may not claim. `isBuiltinToolName(name)` tests one, so an app that takes tool names from configuration can refuse a collision at load time. Withholding a builtin via `withheldBuiltinTools` releases its name, so a custom tool may then use it.

## Plugins

`listWorkspacePlugins(cwd, { compatSources })` lists the plugins an agent opened on `cwd` would load
(name, folder, manifest path and format), using the same discovery and manifest code as the runtime
and without running plugin code. It reads the project's `.theokit/plugins` plus the plugin roots of
the declared `compatSources`, never `~/.theokit/plugins`.

```ts
import { listWorkspacePlugins } from "@theokit/sdk";

const plugins = await listWorkspacePlugins(process.cwd(), { compatSources: ["claude-code"] });
```

## Explain skills

`explainSkills` from `@theokit/sdk/skills` reports what an agent would see, from the same walk the
agent runs:

```ts
import { explainSkills } from "@theokit/sdk/skills";

const report = await explainSkills({
  cwd: process.cwd(),
  settingSources: ["project"],
  compatSources: ["claude-code"],
  skills: { enabled: ["a", "ghost"] },
});
// report.roots, report.loaded, report.invalid, report.shadowed,
// report.enabledButMissing, report.disabled
```

`settingSources` defaults as in `Agent.create`: without `"project"` (or `"all"`) only `bundledDirs`
and inline skills are read. A `SkillsResolver` function is not accepted.

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

## Hook allowlists

Command hooks run shell commands, so an owner may want to approve each one. `listProjectHooks` returns every hook the agent would load for a directory (the same files, grouped by event, and 30 s timeout default as the runtime), `hookFingerprint` is the stable hex sha256 of `sourceEvent\ncommand\ntimeoutMs`, and `fingerprintHookGate` approves only listed fingerprints (an empty list refuses every hook; a malformed item throws `hook_fingerprint_invalid`).

```ts
import { fingerprintHookGate, listProjectHooks } from "@theokit/sdk";

const hooks = await listProjectHooks(cwd, { compatSources });
for (const h of hooks) console.log(h.event, h.sourcePath, h.fingerprint);

const gate = fingerprintHookGate(hooks.filter(isApprovedByOwner).map((h) => h.fingerprint));
// pass `gate` as the agent's hook approval gate
```

## Bounded subprocesses

```ts
import { runBounded } from "@theokit/sdk/process";

const r = await runBounded({ command: "sh", args: ["-c", "make test"], cwd: process.cwd(), timeoutMs: 60_000 });
if (r.timedOut) console.error("timed out");
if (r.truncated.stdout) console.error("stdout was cut at maxOutputBytes");
```

`runBounded` spawns the child in its own process group (POSIX) and sends `SIGKILL` to the whole group on timeout or when `signal` aborts, so pipelines and background jobs die with it. Each of stdout and stderr is capped at `maxOutputBytes` (default 5 MiB) and `truncated` says which was cut. `timeoutMs <= 0` throws `ConfigurationError`. On Windows process groups do not apply: only the child itself is killed. The `shell` tool and command hooks use this runner; a truncated stream gets a trailing `[output truncated]` note.

## `@theokit/sdk/sandbox`: DockerSandbox options

```ts
import { DockerSandbox, defaultDockerRunner } from "@theokit/sdk/sandbox";

const sandbox = new DockerSandbox({
  workDir: "/srv/ws",
  readOnlyWorkspace: true, // mounts the workspace `:ro` (default false, `:rw`)
  labels: { "theoclaw.session": "s1" }, // `--label k=v` on every container
  runner: defaultDockerRunner("docker"), // the default runner, to wrap in a custom one
});
```

`readOnlyWorkspace: true` changes only the workspace mount; the root filesystem is already read-only with a `/tmp` tmpfs. Because the workspace is then not writable, `uploadFile` fails. Label keys must match `[a-z0-9]([a-z0-9._-]*[a-z0-9])?` and values must not contain newlines; otherwise the constructor throws `ConfigurationError` with code `invalid_docker_label`.

## `@theokit/sdk/persistence`: single instance lock

`acquireInstanceLock(dir, { path? })` takes `<dir>.instance.lock` for the life of the process, so two processes never run against the same state directory. A second holder rejects with `InstanceLockedError` (`lockPath`, `holderPid`); the message names the lock and the pid, and says to stop that process or remove the lock if the pid is not running. A lock left by a pid that is no longer running is taken over, and only one of several contenders wins a given stale lock. `release()` removes the lock only while this holder still owns it, and is idempotent.

```ts
import { acquireInstanceLock } from "@theokit/sdk/persistence";

const lock = await acquireInstanceLock(stateDir);

// on application shutdown, await the release before the process exits
process.once("SIGTERM", async () => {
  await lock.release();
  process.exit(0);
});
```

Limit: liveness is `kill(pid, 0)`, so every process contending for the lock must share one pid namespace (not containers or hosts sharing a volume). The lock needs a filesystem with hard links; without one the call rejects with `InstanceLockedError`.

## `@theokit/sdk/context`

`runDiscovery` finds context files (`AGENTS.md`, `CLAUDE.md`, ...) and inlines their `@path` imports.

- **List patterns.** A `DiscoverySpec` with `scope: "cwd-only"` or `"git-root-walk"` may set `pattern: ["THEO.md", "AGENTS.md", "CLAUDE.md"]`. Each directory contributes only the first name that exists. A list on a `"globbed"` spec throws `ConfigurationError` naming the spec id.
- **`wrapImport(name, content)`.** Wraps each inlined `@import` at every depth, e.g. `(n, c) => \`--- import: ${n} ---\n${c}\n--- end import ---\``. Refusal and not-found placeholders are never wrapped. Default: content unchanged.
- **Already loaded.** A file discovery emits is not inlined again by an import; the import line becomes `[@import already loaded: <path>]`.

## Live-agent registry: `Agent.lease`

`Agent.getOrCreate` caches agents in `Agent.registry`, which disposes them on LRU, idle or explicit eviction, even mid-turn. Use `Agent.lease` for work in flight: the registry never disposes a held agent.

```ts
const lease = await Agent.lease(conversationId, options);
try {
  await lease.agent.send("hello");
} finally {
  lease.release(); // idempotent
}
```

LRU and the idle sweep skip held entries (the cache may exceed `maxAgents` until a release, which re-checks the bound). `evict(id)` and `evictAll()` drop a held entry from the cache at once and dispose it after the last release. A failed build rejects and holds nothing. `Agent.registry.leaseCount(id)` reports the holds for diagnostics.

## Status

The full contract is defined by the exported TypeScript types; see [`CHANGELOG.md`](./CHANGELOG.md) for the release history.

## License

MIT — see [LICENSE](./LICENSE).

## Loading a project `.env` safely

`loadProjectEnv()` reads the project's `.env` into `process.env`, then restores every sovereign key
(`SOVEREIGN_ENV_KEYS`: `THEOKIT_HOME`, `THEOKIT_AUTH_HOME`, `THEOKIT_TRUSTED_PROVIDERS`,
`THEOKIT_REDACT_SECRETS`, `THEOKIT_OAUTH_TX_SALT`) to its earlier value, so a cloned repository
cannot move the credential store or switch off a trust decision.

```ts
import { loadProjectEnv } from "@theokit/sdk";

const report = loadProjectEnv(process.env, undefined, { extraSovereignKeys: ["APP_HOME"] });
// report.set     — keys the load added or changed and that were kept, sorted
// report.refused — sovereign keys the load tried to change and that were restored, sorted
```

`extraSovereignKeys` protects your own variables in addition to the built-in list. A variable
already set in the shell is never listed in `set`. If there is no `.env` (or the load throws), `env`
is left unchanged and the report is `{ set: [], refused: [] }`.

## MCP servers: filtering tools

Many MCP servers list a risky tool next to the useful ones. Set `tools` on a server to choose what the model is offered. Names are the server's own. `include` keeps only the listed names, and `exclude` drops names after that.

```ts
const agent = await Agent.create({
  model: { id: "claude-sonnet-5-5" },
  mcpServers: {
    playwright: {
      command: "npx",
      args: ["@playwright/mcp@latest"],
      tools: { exclude: ["browser_run_code_unsafe"] },
    },
  },
});
```

A call to a filtered-out tool is refused in the client with a tool error naming the tool and the server; nothing is sent to the server. An `include` name the server does not list produces one diagnostics warning. A malformed filter makes `Agent.create` throw a `ConfigurationError` with code `invalid_mcp_tool_filter`.

## Reading the managed settings document

`readManagedSettings()` returns only the four keys the SDK enforces. An app with its own keys (model, sandbox mode, approval policy) that an operator imposes through `managed-settings.json` can read the whole file with `readManagedSettingsDocument()` from `@theokit/sdk`:

```ts
import { readManagedSettingsDocument } from "@theokit/sdk";

const doc = readManagedSettingsDocument(undefined, { onWarn: (m) => console.warn(m) });
// null when there is no file; otherwise { path, raw } with every top-level key as written
```

- An absent file returns `null` and warns nothing. An unreadable, invalid or non-object file returns `null` and warns through `onWarn` (default: the SDK failure diagnostic).
- Nothing is validated: the caller owns the schema for its keys.
- `managedSettingsPathFor(root?)` is the one path resolver. It picks a single path by `process.platform`; it does not consult all three platform paths.
