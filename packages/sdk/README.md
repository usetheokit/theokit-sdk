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

## Diagnostics: `setDiagnosticsSink`, `diag` and `diagFailure`

A host (for example a TUI) calls `setDiagnosticsSink(fn)` to keep library output off its screen or route it to its logs. A library built on the SDK emits through the same sink:

```ts
import { diag, diagFailure, Security, setDiagnosticsSink } from "@theokit/sdk";

setDiagnosticsSink((message) => statusPanel.append(message)); // host side

diag("[my-adapter] reconnecting"); // progress and degraded-mode notes; dropped when no sink is installed
diagFailure(`[my-adapter] handler threw: ${Security.redact(err.message)}`); // sink, or stderr without one
```

The SDK does not redact the message. A caller passing provider or platform text must redact it first, for example with `Security.redact`.

## Masking secrets: `Security.redact` and `Security.createMask`

`Security.redact(text)` masks known credential *shapes* (API keys, `Bearer`, `key=value`).
When the app knows the exact values it loaded, `Security.createMask(values)` masks those values:

```ts
import { Security } from "@theokit/sdk";

const mask = Security.createMask([botToken, apiKey]); // { placeholder = "[redacted]", minLength = 4 }
mask.text("token " + botToken); // longest value first
mask.deep({ args: ["k " + apiKey], n: 1 }); // structural copy, strings masked
const s = mask.stream(); // push(delta) releases what is safe, flush() the rest
const uninstall = mask.wrapStreams([process.stdout, process.stderr]); // write and end(chunk)
```

Values shorter than `minLength` (default 4) are ignored. A value split across stream chunks is held
back until it is known not to match. `wrapStreams` throws `ConfigurationError` for a stream that is
already wrapped; a write held back whole calls its callback before its bytes reach the stream.

## `modelFallback`: rerun a turn on another model

```ts
const agent = await Agent.create({
  model: "openai/gpt-4o",
  modelFallback: { models: ["anthropic/claude-3.5-sonnet"] },
});
```

When the primary model fails before it streams any assistant text or tool call (a provider or
network error), the same turn is rerun on the next model of `models`, in order. The retry runs on
the same agent, so the user message appears once in the transcript. The `Run` you hold stays the
same object; its `stream()`/`events()` carry the answering model's items. `RunResult.modelFallbackAttempts`
lists each failed attempt (`model`, `errorCode`).

It never falls over on `cancelled`, on a `ConfigurationError`, or after output has started.
When every model fails the run ends `error` and `RunResult.error.cause` is a
`ModelFallbackExhaustedError` naming each model and its code; its own `cause` is the primary's error.

This differs from `providers.fallback`, which only picks another provider when a route has none
available. It does not resend a run that failed.

## Budgets: reserving in-flight spend

`Budget.reserve` holds an estimate so concurrent calls cannot all pass a preflight that none has paid for:

```ts
const hold = Budget.reserve("copilot", 0.6); // throws BudgetExceededError in block mode if it would not fit
try {
  const actualUsd = await runCall();
  await hold.settle(actualUsd); // charges the ledger, fires threshold callbacks, drops the hold
} catch (err) {
  hold.release(); // drops the hold without charging; no-op after settle
  throw err;
}
```

Open holds count in `preflightCheck` and show as `heldUsd` in `Budget.snapshot()`.

## Install

```bash
npm install @theokit/sdk
```

## Quick start

```typescript
import { Agent } from "@theokit/sdk";

const agent = await Agent.create({
  apiKey: process.env.THEOKIT_API_KEY!,
  model: { id: "openai/gpt-4o-mini" },
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

## Incognito agents

To leave nothing on disk, keep the transcript in memory, keep the agent out of the persisted registry, and turn memory off:

```ts
import { Agent, InMemorySessionStore } from "@theokit/sdk";

const agent = await Agent.create({
  model: { id: "openai/gpt-4o-mini" },
  memory: { enabled: false },
  local: { sessionStore: new InMemorySessionStore(), registry: false },
});
```

Use a fresh `InMemorySessionStore` per agent; resume works only while you keep the same instance. `registry: false` keeps the agent out of `<cwd>/.theokit/agents/registry.json`, but it stays visible to `Agent.list` in the current process. Tools, plugins and other features you enable can still write files of their own.

## Writing your own SessionStore

A `SessionStore` (Postgres, Redis, a KV store) must follow a few rules: a never-written agent reads as `[]`, a failed read throws instead of returning `[]`, appends keep order, and `SessionBusyError` from `acquire` propagates. `@theokit/sdk/testing` exports the rules as plain named cases that any test runner can loop over:

```ts
import { sessionStoreConformanceCases } from "@theokit/sdk/testing";
import { describe, it } from "vitest";
import { MyPostgresSessionStore } from "./my-store.js";

const cases = sessionStoreConformanceCases({
  // A fresh, empty store per case (use a new schema or key prefix each time).
  create: async () => new MyPostgresSessionStore(await freshSchema()),
  // Optional: a store pointed at a dead backend, to check that reads throw.
  createUnreachable: async () => new MyPostgresSessionStore("postgres://127.0.0.1:1/none"),
  // Set when every create() opens the same backend: enables the "survives a second create()"
  // and lease-contention cases.
  sharesBackend: true,
});

describe("MyPostgresSessionStore", () => {
  for (const c of cases) {
    if (c.skipReason) it.skip(`${c.name} (${c.skipReason})`, () => {});
    else it(c.name, () => c.run());
  }
});
```

Each case throws an `Error` naming the violated rule. Set `exclusiveLeases: false` if your store lets two instances hold one session's lease at once.

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

`listMemoryFacts` covers per-memory files and legacy `## Facts` bullets, in the order the agent reads them. `removeMemoryFact` deletes the file and its `MEMORY.md` index line (or one legacy bullet), serialized with the SDK's writes. Entries from another tool's store (for example the Claude Code CLI's) have `removable: false`, and removing one rejects with `MemoryFactNotRemovableError`. Removal also drops the entry's rows from the sqlite memory search index, so recall does not return it; a Lance index is not part of the built-in store and is not touched. Two identical legacy bullets in one root share an id, and removal takes the first. An id found in more than one root (the same file name in the write root and the Claude Code store) rejects with `MemoryFactAmbiguousError` naming every root, and removes nothing.


### Mirroring facts to a memory adapter

Set `memory.mirror` to link the built-in fact store to the agent's `kind: "memory"` plugins (Mem0, Honcho, Supermemory). Every fact the built-in store saves is also written to each adapter, with the agent's `memoryContext` and `userId` defaulting to `memory.userId`. A failed adapter write is reported on the diagnostics channel with the adapter id and never fails the local save or the run.

```ts
import { mem0Memory } from "@theokit/memory-mem0";

const agent = await Agent.create({
  memory: {
    enabled: true,
    userId: "alice",
    // write: true is the default; "adapters-first" reads the <memory> block from the
    // adapters (list() when available, else recall()) and falls back to local facts on
    // an error or an empty result.
    mirror: { recall: "adapters-first" },
  },
  plugins: [mem0Memory({ apiKey: process.env.MEM0_API_KEY! })],
});
```

### Saving facts from each turn with `memory.review`

Set `memory.review` and a small reviewer reads each finished turn and saves the durable facts in it ("I work in UTC-3"), so the main model spends no tool calls on it:

```ts
const agent = await Agent.create({
  memory: {
    enabled: true,
    userId: "alice",
    // model: the reviewer's model (default: the agent's model); instructions: replace the defaults.
    review: { after: "turn" },
  },
});
await agent.memory.reviewsIdle?.(); // wait for queued reviews, e.g. in tests or at shutdown
```

- A review is queued after each run that ends `finished` with a reply; runs that end `error` or `cancelled` queue none. The turn is passed to the reviewer inside `<turn>` tags, and the default instructions say to treat it as data.
- Reviews of one agent run one at a time; a new review waits for the previous one.
- The reviewer is an internal agent with no plugins and exactly one tool, `save_memory({ fact })`, which writes to the same memory directory and `userId` partition as the reviewed agent. A fact longer than 500 characters is refused with a tool error and nothing is stored.
- A failing review is reported on the diagnostics channel with the agent id. It never rejects the user's `wait()` and never blocks the next turn.
- `agent.dispose()` waits up to 5 seconds for queued reviews, then cancels the active one, drops the rest and reports how many on the diagnostics channel.
- Reviews are not mirrored to `memory.mirror` adapters.

## Builtin tool names

`BUILTIN_TOOL_NAMES` (`"shell"`, `"memory_search"`, `"memory_get"`) lists the tools the SDK declares itself; these are the names `withheldBuiltinTools` accepts and a custom tool may not claim. `isBuiltinToolName(name)` tests one, so an app that takes tool names from configuration can refuse a collision at load time. Withholding a builtin via `withheldBuiltinTools` releases its name, so a custom tool may then use it.

`checkToolName(name, { withheldBuiltins })` applies the SDK's tool-name rules without throwing and returns `{ ok: true }` or `{ ok: false, code, message }`, where `code` is `tool_missing_name`, `tool_invalid_name` or `tool_reserved_name` (`ToolNameProblem`). A framework that compiles tools from configuration can reject a bad name with its own error before it constructs an `Agent`; `Agent.create` throws a `ConfigurationError` with the same code. Duplicate names are only detected across the whole tool list, by `Agent.create`.

## Plugins

`listWorkspacePlugins(cwd, { compatSources })` lists the plugins an agent opened on `cwd` would load
(name, folder, manifest path and format), using the same discovery and manifest code as the runtime
and without running plugin code. It reads the project's `.theokit/plugins` plus the plugin roots of
the declared `compatSources`, never `~/.theokit/plugins`.

```ts
import { listWorkspacePlugins } from "@theokit/sdk";

const plugins = await listWorkspacePlugins(process.cwd(), { compatSources: ["claude-code"] });
```

A `"general"` plugin registers hooks through `ctx.on`. The handler is typed by hook name, so the
context needs no cast and a `pre_tool_call` veto is checked (`block` is the literal `true`):

```ts
import { Plugin } from "@theokit/sdk";

const guard = Plugin.create({
  kind: "general",
  name: "guard",
  version: "1.0.0",
  register(ctx) {
    // `c` is inferred as `PreToolCallContext`.
    ctx.on("pre_tool_call", (c) =>
      c.name === "Bash" ? { block: true, message: "Bash is disabled here." } : undefined,
    );
    // Transform hooks get the chained value first, then their context.
    ctx.on("transform_llm_output", (text, c) => `${String(text)} [${c.runId}]`);
  },
});
```

`HookContextMap`, `HookResultMap`, `TypedHookHandler` and `GeneralPlugin` are exported for plugin
authors; handlers typed as `HookHandler` keep compiling.

A `pre_tool_call` plugin sees which conversation the run belongs to in `ctx.conversation`, a
`ConversationRef` (`platform`, `channelId`, `sessionKey`) the caller declares with
`Agent.create({ conversation })` or `agent.send(prompt, { conversation })`; the send value wins. The
key is absent when none was declared. It is threaded on the local runtime.

## Guarding tools that run outside the agent loop

A tool called from a code-mode script, an MCP endpoint or a relay skips the agent's `pre_tool_call`
plugins. `guardTools` wraps each tool so its handler runs the plugin chain first; a veto rejects
with `ToolCallBlockedError` (`toolName`, `pluginMessage`) and the handler is not called.
`runPreToolCall(plugins, ctx)` runs the same chain for one call and returns the first
`{ block: true, message }` decision, or `undefined`.

```ts
import { guardTools, runPreToolCall } from "@theokit/sdk";

const safe = guardTools(tools, plugins, { agentId: "my-agent", permissionMode: "default" });
const decision = await runPreToolCall(plugins, { name, args, agentId, runId });
```

A plugin handler that throws is not turned into a veto: the exception propagates, as it does in the
agent loop. `guardTools` passes no `conversation`; use `runPreToolCall` to supply one.

## Tool-result guard and `sendDefaults`

`SendOptions.toolResultGuard` (`{ delimit, redactPii }`) wraps or redacts tool output before the model sees it, and `SendOptions.pruneToolResults` stubs results older than `olderThanRounds` rounds. Both are read per send, so a missed call site runs unguarded. Set them once on the agent instead:

```ts
const agent = await Agent.create({
  model: "anthropic/claude-sonnet-4-6",
  local: { cwd: process.cwd() },
  sendDefaults: {
    toolResultGuard: { delimit: true }, // tool output arrives inside <untrusted-tool-output>
    pruneToolResults: { olderThanRounds: 3 },
  },
});

await agent.send("summarise the page"); // guarded
await agent.send("raw", { toolResultGuard: { redactPii: true } }); // this call's guard replaces the default
```

`sendDefaults` accepts `toolResultGuard`, `pruneToolResults` and `perToolTimeoutMs`, applies to local agents, and also covers `fork()`, `generate()`, `runUntil()` and the `*ToCompletion` helpers. It merges per key: a key the send passes wins. Passing a key as `undefined` explicitly does **not** remove the default. An invalid `pruneToolResults` fails at `Agent.create` (and `Agent.resume`) with `ConfigurationError` code `invalid_prune_tool_results`. The defaults are persisted, so a disk-backed `Agent.resume` keeps them.

## Pinned `AgentFactory` options

`AgentFactory.create({ defaults, pinned })` builds every agent from `defaults`, then the per-session overrides, then `pinned`. An override cannot change a pinned key. `local`, `memory`, `cloud` and `sendDefaults` merge key by key with pinned keys winning; `withheldBuiltinTools` is a union, so an override can withhold more tools, never fewer. A config that mixes `defaults`/`pinned` with other top-level `AgentOptions` keys throws `ConfigurationError`. Per-send options can still override `sendDefaults` at send time.

```ts
const factory = AgentFactory.create({
  defaults: { model: { id: "anthropic/claude-sonnet-4-6" } },
  pinned: {
    withheldBuiltinTools: ["shell"],
    memory: { enabled: false },
    local: { hooks: approvalGate },
    sendDefaults: { toolResultGuard: guard },
  },
});
// cwd is kept; hooks, memory and shell stay pinned.
const agent = await factory.forSession("s1", { local: { cwd }, memory: { enabled: true } });
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
    model: { id: "openai/gpt-4o-mini" },
    local: { cwd: process.cwd() },
  },
});

await Cron.start();   // required for local jobs to fire
```

To reject a bad schedule when you read config, call the synchronous validators from `@theokit/sdk/cron`. They apply the same rules as `Cron.create`:

```typescript
import { validateCron, validateCronTimezone } from "@theokit/sdk/cron";

validateCron("0 9 * * 1-5");             // ok
validateCron("61 * * * *");              // throws ConfigurationError (code "invalid_cron")
validateCronTimezone("America/Sao_Paulo"); // ok; "Mars/Base" throws "invalid_timezone"
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

### Keeping and cleaning containers

By default every container is removed on exit (`--rm`). With `keepLast: { key }` the sandbox runs without `--rm`, labels the container `theokit.sandbox.keep=<key>`, and after each command removes earlier exited containers with the same key, so the last one stays for `docker inspect`. A failed cleanup is written to the diagnostics channel (`setDiagnosticsSink`); the command's result is unchanged. The label name is reserved and cannot be set in `labels`.

```ts
import { listSandboxContainers, removeSandboxContainers } from "@theokit/sdk/sandbox";

const sandbox = new DockerSandbox({ labels: { app: "x" }, keepLast: { key: "s1" } });
const found = await listSandboxContainers({ app: "x" }); // [{ id, name, state, image, labels }]
const { removed, skippedRunning } = await removeSandboxContainers({ app: "x" });
// a running container is skipped unless `includeRunning: true` (then `docker rm -f`)
```

Both helpers require at least one label (an empty set would match every container on the host) and take `{ runner }` and default to `defaultDockerRunner()`. A docker command that fails or times out rejects with `SandboxDockerError` (`subcommand`, `exitCode`, `stderr`). Docker renders labels as `k=v,k=v`, so a label value that itself contains a comma followed by `word=` is parsed ambiguously.

## `@theokit/sdk/sandbox`: network allowlist for `LinuxSandbox`

`network` on `LinuxSandbox` and `createSandboxBackend` is `false` (no network), `true` (the host network) or `{ allow }`: only the listed destinations.

```ts
import { createSandboxBackend } from "@theokit/sdk/sandbox";

const sandbox = createSandboxBackend({
  mode: "workspace-write",
  network: { allow: [{ host: "registry.npmjs.org" }, { host: "*.github.com", ports: [443] }] },
});
sandbox.networkPolicy; // { mode: "allowlist", allow: ["registry.npmjs.org", "*.github.com"] }
await sandbox.dispose(); // closes the proxy
```

How it works: the command keeps an empty network namespace (loopback only). A forwarder, run with the Node binary the host already runs, listens on `127.0.0.1:3128` inside the namespace and pipes to a host-side proxy over a Unix socket (bound read-only into the sandbox). `HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy`, `https_proxy` and an empty `NO_PROXY` are set. The proxy handles `CONNECT host:port` and absolute-URI `http://` requests; a host matching no rule, or a port not in `ports` (default `[80, 443]`), gets `403`. `*.example.com` matches subdomains, not `example.com`; IP literals must be listed exactly. The proxy resolves names itself after the rule check, connects to the address it validated, and refuses a name that resolves to a loopback, private, link-local or otherwise non-public address unless that address is also listed.

What it blocks: a process that ignores the proxy variables and opens its own socket has no route out, and raw TCP, SSH git remotes and other non-HTTP protocols stay blocked. What it does not do: HTTPS is tunnelled without inspection, so the proxy sees the host and port but not the traffic, and an allowed host can receive anything the command sends it. Under an allowlist the seccomp network-syscall filter is not installed (the command must open a socket to the forwarder); the namespace is what blocks egress.

Bubblewrap is required. Without it, or under `danger-full-access`, `network: { allow }` throws `SandboxNotAvailableError` rather than falling back to an unconfined `LocalSandbox`. `startEgressProxy({ allow })` is exported for use on its own and returns `{ socketPath, denied, close() }`. `DockerSandbox`, `E2BSandbox` and macOS are not covered.

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

## Defer a tool call for approval

A permission gate can hand a call to a person instead of waiting on a live Promise. Return `defer` from `canUseTool` (or `{ defer: true, reason }` from a `pre_tool_call` handler, which also receives `toolUseId`):

```ts
const plugin = createPermissionPlugin(engine, {
  canUseTool: () => ({ behavior: "defer", reason: "needs a person" }),
});
const result = await (await agent.send("deploy")).wait();
if (result.status === "deferred") {
  for (const call of result.deferredToolCalls ?? []) {
    // { toolUseId, toolName, input, deferredAt, reason, schemaVersion: 1 }
  }
}
```

The deferred call is not dispatched, the other calls of the step finish, and the transcript ends on the unanswered `tool_use`. The run releases the session, so the process can exit.

### Resume after a restart

Restore the agent (`Agent.resume(agentId, options)`, passing the plugins and tools again) and answer every pending call with `toolDecisions`, exactly one per `toolUseId`. The pending calls are read from the stored transcript; the `message` is ignored.

```ts
const agent = await Agent.resume(agentId, { plugins: [plugin], tools });
const run = await agent.send("", {
  toolDecisions: [{ toolUseId: "call_1", behavior: "allow" }], // or { behavior: "deny", message }
});
await run.wait(); // the model continues with the results
```

`allow` dispatches the stored call after the permission rules, floors and hooks run again on its input: an approval answers an `ask` and never overrides a current `deny`, a permission floor or another plugin's veto (the call then gets an error result). `deny` writes an error result with your `message` and runs nothing. An unknown or repeated `toolUseId`, a missing decision, nothing pending, or a stored call with an unsupported `schemaVersion` rejects with `ConfigurationError` (`tool_decision_unknown`, `tool_decision_duplicate`, `tool_decision_missing`, `no_deferred_tool_calls`, `deferred_schema_unsupported`) and leaves the session unchanged. A normal send while calls are pending abandons them; the unanswered calls are left out of the history so the session is not blocked. Local runtime only.

## `@theokit/sdk/server/auth`: sign-in with Web `Request` / `Response`

`Auth.create({ session, providers, onSignIn })` also drives a sign-in for apps that handle Web requests. The SDK writes, reads and clears the encrypted OAuth transaction cookie (`__Host-theo_oauth_tx`, HttpOnly, Secure, SameSite=Lax, Max-Age 600); the app writes no cookie code.

```ts
// GET /auth/google: 302 to the provider, with the transaction cookie set
export const start = (request: Request) =>
  auth.startSignInWeb("google", request, { returnTo: "/dashboard" });

// GET /auth/google/callback
export async function callback(request: Request) {
  const headers = new Headers();
  const { returnTo } = await auth.finishSignInWeb("google", request, headers);
  headers.set("Location", returnTo ?? "/");
  return new Response(null, { status: 302, headers });
}
```

`finishSignInWeb` checks the provider error and `state` (constant time), calls the provider with the `Request`, runs `onSignIn`, then appends the session cookie and a clearing transaction cookie to `headers`. It rejects with `AuthCancelledError` (`access_denied`) or `AuthCallbackError` (`oauth_provider_error`, `oauth_transaction_expired`, `oauth_state_mismatch`). The provider's `handleCallback` must accept a `Request`. The session manager needs `createSessionWeb(headers, data)`, which must issue a fresh session; without it `finishSignInWeb` rejects with `AuthConfigError` (`session_web_unsupported`). The Node methods (`startSignIn`, `finishSignIn`) are unchanged. `writeTransactionCookie`, `readTransactionCookie` (`null` when absent, expired or not decryptable) and `clearTransactionCookie` are exported for custom flows.

## `@theokit/sdk/auth`: choosing a provider credential

`resolveProviderCredential({ env, model?, store?, providers?, pinnedEnvVar? })` returns
`{ provider, apiKey, origin, baseUrl }`. Rules, in order:

1. `pinnedEnvVar` set: that variable is used; empty or missing throws `pinned_credential_missing`.
2. The model names a provider (`openai/gpt-4o-mini`): that provider's credential (env, then `store`) is used. None throws `model_provider_without_credential` and never falls back to another provider.
3. A bare model id or no model: the first candidate by `priority` with a credential. None throws `no_provider_credential`, listing the variables checked.
4. A key whose prefix names a different vendor than the provider it was found for throws `credential_provider_mismatch`.

`DEFAULT_PROVIDER_CANDIDATES` is the one default order: `openrouter` (`OPENROUTER_API_KEY`), `anthropic` (`ANTHROPIC_API_KEY`), `openai` (`OPENAI_API_KEY`). It matches the chain `@theokit/agents` already uses. Errors are `ProviderCredentialError`; messages name variables, never values.

## `@theokit/sdk/persistence`: named profiles

`resolveProfile(name, { profilesRoot?, appDirectories? })` maps a profile name to `<profilesRoot>/<name>` (default `getProfilesRoot()`, `~/.theokit/profiles`) and returns `directory`, `directories` and `env` (`THEOKIT_HOME` and `THEOKIT_AUTH_HOME` set to the profile directory, plus one entry per `appDirectories` item, joined under the profile). Names must match `^[a-z0-9][a-z0-9-]{0,15}$`, otherwise `ConfigurationError` code `profile_name_invalid` (the name is not echoed). App directory values must be relative and free of `..`. It touches no disk.

`applyProfile(profile, env)` throws `ProfileConflictError` (`variables`: names only, never values) when any variable the profile owns is already set to a non-blank value in `env`. It then creates each directory at 0700, tightens an existing one to 0700 without reading or removing its contents, and only then writes the overrides into `env`. A filesystem failure throws `ConfigurationError` code `profile_directory_failed` naming the path and errno code and leaves `env` unchanged (directories made before the failure remain).

```ts
import { applyProfile, resolveProfile } from "@theokit/sdk/persistence";

const profile = resolveProfile("work", { appDirectories: { APP_WORKSPACE: "workspace" } });
await applyProfile(profile, process.env);
```

## `@theokit/sdk/context`

`runDiscovery` finds context files (`AGENTS.md`, `CLAUDE.md`, ...) and inlines their `@path` imports.

- **List patterns.** A `DiscoverySpec` with `scope: "cwd-only"` or `"git-root-walk"` may set `pattern: ["THEO.md", "AGENTS.md", "CLAUDE.md"]`. Each directory contributes only the first name that exists. A list on a `"globbed"` spec throws `ConfigurationError` naming the spec id.
- **`wrapImport(name, content)`.** Wraps each inlined `@import` at every depth, e.g. `(n, c) => \`--- import: ${n} ---\n${c}\n--- end import ---\``. Refusal and not-found placeholders are never wrapped. Default: content unchanged.
- **Already loaded.** A file discovery emits is not inlined again by an import; the import line becomes `[@import already loaded: <path>]`.

## `@theokit/sdk/a2a`: reaching agents in other processes

`MessageBus` routes in-process. Pass an `A2ATransport` to let `send` reach peers elsewhere:

```ts
import { MessageBus, inMemoryTransport } from "@theokit/sdk/a2a";

const transport = inMemoryTransport(); // shared object, for tests and same-process use
const a = new MessageBus({ transport });
const b = new MessageBus({ transport });
b.register("worker", (m) => console.log(m.payload));
await a.send("boss", "worker", { type: "job", payload: 1 }); // no local handler: goes to transport.send
await b.pump(); // polls for every locally registered agent, delivers in order, returns 1
```

- A local handler always wins; the transport is used only when there is none. Without a transport an unknown peer still rejects with `A2APeerNotRegisteredError`.
- `request` stays local only. With a transport and no local handler it rejects with `A2ARemoteRequestUnsupportedError` (`a2a_remote_request_unsupported`).
- `pump()` is not automatic: call it when you want waiting messages delivered. A handler failure is reported on diagnostics and does not stop the others.
- `from` is self-asserted. The transport does not authenticate it; that is the job of a sealed transport.

### HTTP store-and-forward mailbox

For peers that are offline or behind NAT, serve a mailbox from any fetch-style server and point `httpMailboxTransport` at it:

```ts
import { MessageBus, createHttpMailboxHandler, httpMailboxTransport } from "@theokit/sdk/a2a";

// server: handles POST <prefix>/put and POST <prefix>/take
const handler = createHttpMailboxHandler({ token: process.env.MAILBOX_TOKEN!, persistPath: "./mailbox.json" });

// client
const bus = new MessageBus({
  transport: httpMailboxTransport({ baseUrl: "https://host.example/mailbox", token: process.env.MAILBOX_TOKEN! }),
});
```

- Defaults: 100 messages per recipient (a full queue answers 507), 256 KiB body cap (413). Non-POST answers 405 with `allow: POST`; a wrong token answers 401 before the body is read. The token is compared in constant time.
- `persistPath` writes atomically with mode 0600. A file that fails its shape check is refused at start with `A2AMailboxError` and never overwritten. Handlers sharing one file are not coordinated.
- `baseUrl` must be `https:`, or `http:` on `localhost`, `127.0.0.1` or `[::1]`; otherwise `ConfigurationError` (`a2a_mailbox_insecure_url`). A non-2xx answer rejects with `A2AMailboxError` carrying `status`.
- **Shared-token limit:** one token guards the whole mailbox. Any holder can `take` any recipient's queue, draining other peers' messages, and `from` is self-asserted. Share the token only between peers that trust each other.

### Sealed transport: encrypted, sender-authenticated messages

`sealedTransport(inner, { identity, trustedPeers, sequences? })` wraps any `A2ATransport` (in-memory, HTTP mailbox) so a relay or mailbox sees only public keys, a sequence number and ciphertext.

```ts
import { generateA2AIdentity, jsonSequenceStore, MessageBus, sealedTransport } from "@theokit/sdk/a2a";

const me = generateA2AIdentity(); // base64url raw X25519 keys; share only publicKey
const transport = sealedTransport(inner, {
  identity: me,
  trustedPeers: new Map([["bob", bobPublicKey]]), // name -> public key, distributed out of band
  sequences: jsonSequenceStore("./a2a-seq.json"), // atomic write, mode 0600
});
const bus = new MessageBus({ transport });
await bus.send("me", "bob", { type: "note", payload: "hi" }); // `to` is the trusted NAME
```

- Envelope: ephemeral and static X25519, HKDF-SHA256 (info binds version `theokit-a2a-v1`, sender, recipient and ephemeral keys), AES-256-GCM with a random 12-byte nonce; the AAD binds the same values and the sequence number.
- Trust model: only peers in `trustedPeers` can be sent to or received from. On receipt `from` is the trusted name for the verified sender key, not a claim. Sending to an unknown name rejects with `A2AUntrustedPeerError` (`a2a_untrusted_peer`).
- Dropped messages (malformed, `wrong_recipient`, `untrusted_peer`, `authentication_failed`, `replay`) never reach a handler; the reason is reported on diagnostics, never the plaintext.
- Sequence numbers must rise: a replay, or an older message arriving after a newer one, is dropped. Keep the store across restarts (`jsonSequenceStore`); the default `memorySequenceStore` forgets them. Processes sharing one JSON file are not coordinated.
- One identity is one agent: every poll reads the queue addressed to the identity's public key. Key distribution is yours. There is no forward secrecy: a leaked recipient private key exposes the messages sealed to it.

## Evals: scoring tool calls

A scorer is `(output, expected?, context?)`. The runner passes a `ScoreContext` as the third argument:
`{ input, metadata?, toolCalls }`, where `toolCalls` is every tool call the run made, in call order, as
`{ name, input, output?, isError }`. Two-argument scorers keep working unchanged.

```ts
import { Eval, Scorers } from "@theokit/sdk/eval";

Eval.create({
  name: "tools",
  dataset: [
    {
      input: "Find the file and read it",
      expected: {
        toolCalls: [{ name: "search", input: { q: "readme" } }, { name: "read" }],
        trajectory: ["search", "read"],
      },
    },
  ],
  scorers: [Scorers.toolCallAccuracy(), Scorers.trajectory()],
  agent: { /* AgentOptions */ },
});
```

- `Scorers.toolCallAccuracy({ matchInput?, allowExtra? })` scores the fraction of expected calls that
  happened. `expected` is `{ toolCalls: [{ name, input? }] }`, or `metadata.expectedToolCalls`.
  `matchInput` is `"subset"` (default), `"exact"` or `"ignore"`. With `allowExtra: false`, an unexpected
  call scores 0 with reason `unexpected_tool_call:<name>`.
- `Scorers.trajectory({ order? })` scores 1 or 0 on `expected.trajectory` (tool names). `order` is
  `"subsequence"` (default), `"strict"` or `"any"`; the reason names the first divergent position.
- A missing or malformed expected value scores 0 with reason `expected_tool_calls_missing` or
  `expected_trajectory_missing`. Both scorers are deterministic and make no network calls.

### Judge scorers

Three judge scorers take the same `model`, `apiKey` and `providers` as `Scorers.llmJudge`. Use a key
other than the evaluated agent's, so a model does not judge its own output. Each row costs judge calls
that `aggregate.tokensInTotal` does not count.

- `Scorers.faithfulness({ contextKey? })` scores supported claims over total claims. The context comes
  from `metadata[contextKey ?? "context"]` (string or string[]). The reason lists unsupported claims.
  **2 judge calls per row** (extract claims, judge claims). Missing context scores 0 with
  `context_missing` and makes no call; an answer with no claims scores 1 with `no_claims` after 1 call.
- `Scorers.rubric({ items: [{ id, description, weight? }] })` scores the weighted pass ratio; the reason
  names the failed item ids. **1 judge call per row.**
- `Scorers.judgedTrajectory({ goal? })` shows the judge the input, the ordered tool calls
  (`name`, `input`, `isError`) and the output, and returns a score in [0, 1]. **1 judge call per row.**
- A judge reply that is not the expected JSON scores 0 with reason `judge_unparseable`.

## `AgentLike` and `RunLike`: narrow types for wrappers and test doubles

`AgentLike` (`agentId`, `send`, optional `dispose`) and `RunLike` (`status`, `stream`, `wait`, `cancel`) are the small ports `SDKAgent` and `Run` satisfy with no cast. Type a wrapper, failover decorator or test double against them instead of the full `SDKAgent`, or re-declaring a port that drifts. `RunLike.wait()` resolves the real `RunResult`, so `status` is `RunStatus` and a misspelled status such as `"completed"` fails to compile.

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

## Workflow compensation (saga rollback)

A top-level `fn` step can declare `compensate(input, output, error)`. When a later top-level step fails (after its retries), the executor calls `compensate` on every earlier completed step that declares one, in reverse completion order. Each call gets that step's own input and output and the error that failed the run.

```ts
Workflow.create({ name: "checkout" })
  .then(fn("book", bookRoom, { compensate: (_in, booking) => cancelBooking(booking) }))
  .then(fn("charge", chargeCard, { compensate: (_in, receipt) => refund(receipt) }))
  .then(fn("notify", sendEmail)) // if this throws, `charge` then `book` are compensated
  .commit();
```

- A `compensate` that throws is recorded as `"failed"` and the pass continues. The run stays `status: "failed"` with the original step error.
- `run.compensation` lists `{ stepId, status: "compensated" | "failed", error? }` in call order; it is absent when nothing was compensated.
- `Workflow.stream()` emits `step_compensated` or `step_compensation_failed` for each call.
- The failing step does not compensate itself, and a cancelled run (abort signal) does not compensate.
- Limits: `compensate` on a step nested in `parallel`, `branch`, `foreach` or `dowhile` fails with `WorkflowCompensateNotImplementedError`; `agent` steps cannot compensate; after `resume()` only steps completed since the resume are compensated; a compensation pass is not persisted across a crash.

## Crash recovery: `durability: "step"` and `listRuns()`

By default a workflow writes a snapshot only when a step calls `suspend()`. Set `persistence: { backend: "json", dir, durability: "step" }` and the run is also checkpointed after every completed top-level step (not the children of `parallel`, `branch` or `foreach`). A completed run deletes its checkpoint; a failed or cancelled run keeps it. After a crash, `Workflow.resume({ workflow, runId })` continues from the step after the last checkpoint, and `workflow.listRuns()` returns `{ runId, status: "suspended" | "running", currentStepId, updatedAt }` for the snapshots the store holds for that workflow name. `durability: "step"` with `backend: "memory"` is allowed (useful in tests) but does not survive a restart. A crash between a step's side effect and its checkpoint can repeat that step. The run lock is still per process: it does not stop a second process from resuming the same run.


### Re-run from a step: `keepHistory`, `history()` and `rerunFrom()`

With `durability: "step"`, set `keepHistory: true` to keep every checkpoint of a run instead of only the latest (the json backend writes `{dir}/{runId}/{index}-{stepId}.json`; a completed run keeps its history). `keepHistory` without `durability: "step"` makes `Workflow.create()` throw `ConfigurationError`.

```ts
const checkpoints = await workflow.history(runId); // [{ runId, stepId, output, state?, at }], oldest first
const retry = await workflow.rerunFrom({ runId, stepId: "s3" }); // optional: input, signal
retry.rerunOf; // { runId, stepId: "s3" }
```

`rerunFrom` forks the run: it mints a new run id and executes `stepId` and every top-level step after it, with the output and shared `state` the run had just before `stepId` (or `input` when given; for the first step, the original run's input). Steps before `stepId` do not run again, and the original run's history is not modified. An unknown `runId` (or one without history) throws `WorkflowSnapshotNotFoundError`; a `stepId` that is not a top-level step throws `WorkflowResumeStepNotFoundError`. Steps nested in `parallel`, `branch` or `foreach` cannot be a starting point.

## Resuming a workflow run by id: `WorkflowSet`

When an app runs several workflows that suspend, the run id is the only token you hand out. `WorkflowSet.of([...]).resume(runId, payload)` finds the workflow that owns it:

```ts
import { WorkflowSet } from "@theokit/sdk/workflow";

const set = WorkflowSet.of([refunds, invoices]);
const { name, run } = await set.resume(runId, { approved: true });
```

A member with no snapshot for the id, or whose snapshot belongs to another workflow, is skipped. Any other error (a payload that fails validation, an I/O error) is rethrown at once and the remaining members are not tried. If no member owns the run, it throws `WorkflowSnapshotNotFoundError`. `WorkflowSet.of` throws `ConfigurationError` when two members share a name.

## `@theokit/sdk/testing`: a fake model server

`startFakeModelServer` starts a server on a free loopback port that speaks a provider's chat wire and answers with scripted text, so an agent runs end to end with no real model. It imports no test runner.

```ts
import { Agent } from "@theokit/sdk";
import { startFakeModelServer } from "@theokit/sdk/testing";

const server = await startFakeModelServer({ reply: "pong" }); // wire: "openai" (default) | "ollama"
const agent = await Agent.create({
  apiKey: "local", // any non-empty placeholder: it selects the real runtime and is never checked
  model: server.model, // { id: "lmstudio/fake-model", url } (or "ollama/..." for wire "ollama")
  local: { cwd: process.cwd() },
});
await (await agent.send("hi")).wait();
console.log(server.requests); // every request body received
await server.close();
```

`reply` may also be `(request) => string`. A body that is not JSON gets HTTP 400 and is recorded with `messages: []` and an `error` string. `host` accepts loopback addresses only. Scripted tool calls are not supported yet.

## Experimental exports

Every export is stable unless its declaration carries `@experimental`; experimental names may change in any release. The list below is checked against the committed surface baseline (`tools/api-surface/sdk.json`).

### `@theokit/sdk/a2a`

- `A2AIdentity`
- `A2AUntrustedPeerError`
- `SealedDropReason`
- `SequenceStore`
- `TrustedPeers`
- `generateA2AIdentity`
- `jsonSequenceStore`
- `memorySequenceStore`
- `sealedTransport`

## Status

The full contract is defined by the exported TypeScript types; see [`CHANGELOG.md`](./CHANGELOG.md) for the release history.

## License

Apache-2.0 — see [LICENSE](./LICENSE).

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
  model: { id: "anthropic/claude-sonnet-4-6" },
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

## Doom-loop guard: sliding-window repeat limit

The built-in doom-loop guard counts consecutive identical tool calls, so an alternating loop (read A, read B, read A, read B) never trips it. Opt in to a sliding window with `SendOptions.doomLoop`:

```ts
await agent.send("...", { doomLoop: { window: 20, windowRepeatLimit: 3 } });
```

Once a call (same tool, same arguments; key order does not matter) already occurs `windowRepeatLimit` times in the last `window` calls, the next identical call is not executed. The model receives a blocked tool result naming the tool so it can change course. Blocked attempts count toward the window. `window` and `windowRepeatLimit` must be positive integers set together, otherwise `send` rejects with `ConfigurationError` code `invalid_doom_loop`. The consecutive `softThreshold`/`hardThreshold` keep working.
