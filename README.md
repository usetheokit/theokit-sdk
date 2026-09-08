<div align="center">

<img src="./assets/banner.svg" alt="TheoKit SDK — the open-source agent runtime for TypeScript" width="840" />

**`@theokit/sdk` is the modern TypeScript SDK for AI-powered apps and agents — on an open, Apache-2.0 runtime you own end to end.**

`Agent.create` · `prompt` · `stream` · `resume` — one TypeScript SDK, 43 LLM providers, your keys.
Local-first. Opt-in cloud. Zero walk-away cost.

[![npm version](https://img.shields.io/npm/v/@theokit/sdk?style=flat-square&color=CB3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/@theokit/sdk)
[![npm downloads](https://img.shields.io/npm/dm/@theokit/sdk?style=flat-square&color=CB3837)](https://www.npmjs.com/package/@theokit/sdk)
[![CI](https://img.shields.io/github/actions/workflow/status/usetheokit/theokit-sdk/ci.yml?branch=main&style=flat-square&label=CI&logo=githubactions&logoColor=white)](https://github.com/usetheokit/theokit-sdk/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://img.shields.io/ossf-scorecard/github.com/usetheokit/theokit-sdk?style=flat-square&label=scorecard)](https://scorecard.dev/viewer/?uri=github.com/usetheokit/theokit-sdk)
[![License](https://img.shields.io/badge/license-Apache--2.0-DE2329?style=flat-square)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8%2B-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.12-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Providers](https://img.shields.io/badge/LLM%20providers-43-DE2329?style=flat-square)](#configuration-reference)
[![Discord](https://img.shields.io/badge/Discord-join-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.usetheo.dev/)

[**theokit.dev**](https://theokit.dev) · [Discord](https://discord.usetheo.dev/) · [npm](https://www.npmjs.com/package/@theokit/sdk)

**Part of [Theo](https://usetheo.dev) — the open platform for AI agents.** `@theokit/sdk` is its **Harness** pillar.

</div>

---

## Quick start

```bash
npm install @theokit/sdk
```

A local agent against your current working tree, streaming events as they arrive. Set
`THEOKIT_API_KEY` first (see [Authentication](#authentication)):

```typescript
import { Agent } from "@theokit/sdk";
import { assistantText } from "@theokit/sdk/messages";

const agent = await Agent.create({
  apiKey: process.env.THEOKIT_API_KEY!,
  // "<provider>/<model>". There is no separate `provider` option — the provider
  // is the prefix. A bare "gemini-2.0-flash-001" will not resolve.
  model: { id: "google/gemini-2.0-flash-001" },
  // The PRESENCE of this key selects the local runtime. There is no `runtime`
  // option — pass `cloud` instead to run hosted. See Overview above.
  local: { cwd: process.cwd() },
});

const run = await agent.send("Summarize what this repository does");

for await (const event of run.stream()) {
  // Returns "" for every non-assistant event, so no `if` is needed.
  process.stdout.write(assistantText(event));
}
```

Three things that trip up almost everyone on the first edit:

- **The provider lives in the model id.** `"openai/gpt-4o"`, not `provider: "openai"` plus `model: "gpt-4o"`. `AgentOptions` has no `provider`.
- **The runtime is chosen by which key you pass**, `local` or `cloud`. There is no `runtime: "local"` field.
- **`assistantText(event)` is the shortcut for "just give me the text."** Every event is a discriminated `SDKMessage`; the helper pulls the `TextBlock`s out of an assistant message and returns `""` for anything else. Walking `event.message.content` by hand — shown under [Stream events](#stream-events) — is the escape hatch for when you need the tool-use blocks too.

For a one-shot prompt (create, run, dispose), use the static `Agent.prompt()`. Note it is **static**: `agent.prompt()` does not exist, because sending to an agent you already hold is `agent.send()` and does not dispose it.

```typescript
const result = await Agent.prompt("What does the auth middleware do?", {
  apiKey: process.env.THEOKIT_API_KEY!,
  model: { id: "google/gemini-2.0-flash-001" },
  local: { cwd: process.cwd() },
});
```

## What you get

An agent runtime, not a wrapper around a chat completion. Everything below is in the package or a
sibling package in this repository — none of it is a roadmap item.

| | |
| --- | --- |
| **43 LLM providers** | Counted in `packages/sdk/src/internal/providers/provider-catalog.json`. The provider is the model id's prefix, so `openai/…` → `anthropic/…` → a local `ollama/…` is a string change |
| **A coding agent's toolkit** | `@theokit/sdk-tools`: read · edit · apply-patch · glob · search · git status/diff · shell · interactive PTY · run-vitest · plan · todolist · think · web fetch and search · images |
| **A kernel sandbox** | bubblewrap + a seccomp filter around every shell command — see below |
| **Orchestration** | `Workflow` with branch, parallel and foreach · `createSquad` · subagents · `@theokit/sdk-handoff` · `defineCron` · job queue · `runUntil` with a judge and a token budget |
| **Evaluation** | `Eval` + `Scorers` over a dataset, with `meanScore` per run |
| **Memory and context** | Local markdown, or Mem0, Honcho and Supermemory adapters · transcript compaction · skills discovered from `SKILL.md` |
| **Cost control** | `@theokit/sdk-budget` tracks spend in USD · `@theokit/sdk-cache` is a semantic response cache (vector + full-text hybrid) |
| **Interop** | MCP with OAuth 2.1 + PKCE · [ACP](https://agentclientprotocol.com) so your agent runs inside an editor · A2A mailbox and message bus |
| **Two runtime dependencies** | `croner` and `jsonrepair`. That is the whole tree |

### Four gates before any tool runs

<div align="center">

<img src="./assets/security-gates.png" alt="Four gates before a tool runs: trust posture, permission engine, approval policy, kernel sandbox." width="900" />

</div>

The kernel gate is the one that is hard to fake, so here is the evidence rather than the adjective:
`packages/sdk/tests/linux-sandbox-integration.test.ts` holds 10 `itLive` cases that run against a
real kernel in CI — `execute_blocks_write_outside_workspace`,
`execute_blocks_network_and_signals_child`, `seccomp_blocks_ptrace`,
`seccomp_blocks_socket_af_inet_but_allows_af_unix`, and six more. A mutation run proved the tests
themselves: swap the seccomp filter for one that denies nothing and they go red.

Permissions are fail-closed — a tool with no matching rule resolves to `ask`, never a silent
`allow` — and an untrusted project directory switches off every declared capability at once, hooks
and MCP servers included.

---

## Contents

**Start here** — [Why](#why-theokitsdk) · [Overview](#overview) · [Installation](#installation) · [Quick start](#quick-start) · [Core concepts](#core-concepts)

**Build with it** — [Creating an agent](#creating-a-local-agent) · [Sending messages](#sending-messages) · [Stream events](#stream-events) · [Resuming](#resuming-agents) · [MCP servers](#mcp-servers) · [Three kinds of plugin](#three-things-are-called-plugin) · [Subagents](#subagents) · [Memory & skills](#memory-context-and-skills) · [Hooks](#hooks) · [Cron](#cron-jobs) · [Artifacts](#artifacts)

**Operate it** — [Authentication](#authentication) · [Resource management](#resource-management) · [Errors](#errors) · [Cloud runtime](#cloud-runtime--pre-release) · [Configuration](#configuration-reference)

**Decide** — [The open stack](#the-open-stack-layer-by-layer) · [Known limitations](#known-limitations) · [Status](#status) · [Where this fits](#where-this-fits) · [License](#license)

**Project** — [`CONTRIBUTING.md`](./CONTRIBUTING.md) · [`SECURITY.md`](./SECURITY.md) · [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) · [Report a bug](https://github.com/usetheokit/theokit-sdk/issues/new/choose)

---

## Why @theokit/sdk

- **Apache-2.0 local runtime** — run agents end-to-end, no vendor in the loop.
- **43 built-in LLM providers** — Anthropic, OpenAI, Google, and 40 more, on your own keys.
- **Reads a Claude Code project as it stands** — point `local.sessionDir` at `~/.claude` and `--continue` a session your agent wrote, right in the Claude Code CLI. A repository already set up for that CLI needs no conversion either: its `.claude/agents`, `.claude/skills`, `.claude/rules`, plugin bundles, the hooks in its `settings.json` and the memories it recorded all load here. See [Claude Code compatibility](#claude-code-compatibility).
- **Opt-in cloud, walk-away cost zero** — fork the local runtime and keep running.

Most agent SDKs ship open; most agent *runtimes* don't. This one does — end to end.

### Claude Code compatibility

A project laid out for the Claude Code CLI works here without being converted. `.theokit` is still
read first and nothing about it changes — `.claude` is read beside it.

| Surface | Where it is read from | Notes |
|---|---|---|
| Sessions | `<sessionDir>/projects/<encoded-cwd>/<uuid>.jsonl` | The CLI can `--continue` a session this SDK wrote |
| `CLAUDE.md` | repository root | Including its `@file` imports |
| Agents | `.claude/agents/*.md` | The CLI's `color` field is accepted and ignored; a `README.md` beside them is skipped rather than failing the directory |
| Skills | `.claude/skills/**/SKILL.md` | Same `name` + `description` frontmatter |
| Rules | `.claude/rules/*.md` | Plain markdown, no frontmatter required |
| Hooks | `.claude/hooks.json`, `settings.json`, `settings.local.json` | Merged, not one-wins — two files' hooks both run |
| Plugins | `.claude/plugins/*/` | A bundle's `skills/` and `agents/` are contributed |
| Memories | `<claudeHome>/projects/<encoded-cwd>/memory/` | Read unconditionally; set `memory.directory` to that path to write there too |

Two limits worth stating rather than discovering:

- **Hooks for `SessionStart` and `PreCompact` are skipped with a warning.** This runtime has no
  firing point for them, and accepting a hook that would never run is worse than saying so. Four CLI
  events map: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`.
- **Plugins are project-scoped.** The CLI also installs plugins under `~/.claude/plugins`, behind its
  own installer and enable/disable state. Reading those would mean guessing at someone's enablement
  and running code they had turned off.

Where a name is declared in both directories — an agent, a skill — `.theokit` wins. Hooks are the
exception and accumulate, because they are unnamed lists and dropping one operator's set in silence
is worse than running both.

## Overview

| Runtime | What it does | When to use |
| --- | --- | --- |
| **Local** | Runs the agent inline in your Node process. Files come from disk. | Dev scripts and CI checks against a working tree. |
| **Cloud (Theo-hosted)** | Runs in an isolated VM with your repo cloned in. | When the caller doesn't have the repo, you want many agents in parallel, or runs need to survive the caller disconnecting. |
| **Cloud (self-hosted)** | Same shape, but you run the VMs via a self-hosted pool. | Same reasons as Theo-hosted, plus code, secrets, and build artifacts must stay in your environment. |

Runtime is picked by which key you pass to `Agent.create()` (`local` or `cloud`). Same `THEOKIT_API_KEY` for either.

## The open stack, layer by layer

The SDK shape — `Agent` / `Run` / streaming events — is converging across the ecosystem by design. The difference is what runs *underneath*:

| Layer | `@theokit/sdk` | Closed-runtime alternatives |
| --- | --- | --- |
| SDK source | Apache-2.0, this repo | Often OSS — table stakes |
| Local agent harness | **Apache-2.0** — runs end-to-end without a vendor | Proprietary or source-available; tied to one vendor |
| LLM provider | Multi-provider — Anthropic, OpenAI, Google, and more, through your own keys | Usually single-vendor |
| Session format | **Native Claude Code `.jsonl`** — point `local.sessionDir` at `~/.claude` and the Claude Code CLI can `--continue` a session your agent wrote | Proprietary session store you can't open anywhere else |
| Cloud runtime | Opt-in Theo PaaS or self-host the pool | Vendor cloud only |
| Walk-away cost | Zero — fork the local runtime, keep running with your own provider keys | High — runtime is the vendor's |

The "open stack underneath" line is load-bearing: you can run an agent fully locally against your own provider keys and never call our backend. The managed cloud runtime (Theo PaaS) is a deploy convenience, not a dependency — and it's currently pre-release (see [Status](#status)).

## What you'd ship

There is a version of your agent that does not sit in a chat window. You don't open a panel or type a prompt — you commit code, and it runs, the same way every other piece of your stack runs:

- **PR description writer.** Triggered on push, scans the diff, drafts the description with code refs.
- **Nightly code reviewer.** Runs at 2 AM, opens issues for code smells it found.
- **Internal codebase Q&A.** A Slack bot that knows your repo. Answers grounded in real files, not generic text.
- **Customer support copilot.** Embedded in your dashboard. Cancels subscriptions, refunds payments, opens tickets — through MCP tools you wire in.
- **CI gate.** Reject PRs that fail a quality check expressed as an agent prompt.
- **Sandbox runner.** One agent per user request, isolated by repo, with bounded permissions.

---

## How it works

Below this line, full technical vocabulary is in play. Installation, authentication, the full API surface — `Agent`, `Run`, MCP servers, subagents, hooks, cron jobs, cloud runtime, errors.

## Installation

```bash
npm install @theokit/sdk
```

### Bundling

If you bundle your application (esbuild, rollup, webpack, tsup), mark the SDK's optional peer dependencies `external`. The SDK loads each of them lazily at runtime — `await import(...)` or `createRequire` — so a bundler inlines them by default, and two things break once they are inside the bundle: a CommonJS package that calls `require()` at load time hits the bundler's ESM `require` shim and throws (`Dynamic require of "path" is not supported`), and a native module cannot be inlined at all.

```js
external: ["proper-lockfile", "better-sqlite3", "sqlite-vec", "@lancedb/lancedb", "ws"]
```

| Package | What is lost when it is inlined |
| --- | --- |
| `proper-lockfile` | The cross-process file lock. Concurrent processes over the same session file are no longer serialized — the SDK falls back to an in-process mutex and warns. |
| `better-sqlite3` | The driver. Persistence falls back to Node 22.5+ built-in `node:sqlite`. |
| `sqlite-vec` | Vector search on the SQLite memory backend (`ConfigurationError`, code `sqlite_vec_unavailable`). |
| `@lancedb/lancedb` | The Lance memory backend (`ConfigurationError`, code `lance_backend_unavailable`). |
| `ws` | The Node WebSocket subscription adapter (`SubscriptionError`, code `ws_peer_missing`). |

The `proper-lockfile` row is the one that fails quietly: the SDK degrades and keeps running, so the only signal is a diagnostic line. Install a sink (`setDiagnosticsSink`) to see it — otherwise a disabled cross-process lock is invisible until two processes write together.

## AI coding assistant setup (optional)

Install the TheoKit agent skills so your AI coding tool writes correct SDK code out of the box.

```bash
npx @theokit/skills
```

It detects the tools your project already uses and writes 31 skills where each one reads them — `.agents/skills/` covers OpenAI Codex, Gemini CLI, GitHub Copilot, Zed and Devin Desktop; `.claude/skills/` covers Claude Code. Each skill carries a glob, so the one matching what you are editing loads on its own and the rest cost nothing. Then describe what you want:

```
Create an agent that monitors GitHub PRs and posts review comments
Add a cron job that summarizes incidents every morning at 9 AM
```

`npx @theokit/skills --check` fails in CI when what is installed drifts from the package, which is what keeps a skill from teaching last year's API.

<details>
<summary>Bundled skill list</summary>

| Skill | Activates on |
| --- | --- |
| `theokit-agent-core` | Files with `agent` or `Agent` in the name |
| `theokit-tools` | Files with `tool` or `Tool` |
| `theokit-memory` | Files with `memory`, `Memory`, or `embed` |
| `theokit-di` | Files with `container`, `inject`, `provider`, `module` |
| `theokit-di-agent` | Files with `decorator` or `di-agent` |
| `theokit-gateways` | Files with `gateway`, `telegram`, `slack`, `discord` |
| `theokit-rag` | Files with `retriev`, `rerank`, `splitter`, `rag` |
| `theokit-workflows` | Files with `workflow` or `step` |
| `theokit-eval` | Files with `eval` or `scorer` |
| `theokit-cron` | Files with `cron`, `job`, or `schedule` |
| `theokit-subscriptions` | Files with `subscri`, `sse`, or `websocket` |
| `theokit-errors` | Files with `error` or `exception` |
| `theokit-config` | `.theokit/` files, `config.*`, `theo.config.*` |
| `theokit-streaming` | Files with `stream` or `SDKMessage` |
| `theokit-budget` | Files with `budget`, `cost`, or `token` |

</details>

## Authentication

Set `THEOKIT_API_KEY` (or pass `apiKey` explicitly) before creating an agent.

```bash
export THEOKIT_API_KEY="your-key"
```

User API keys and service account API keys are both supported. Team Admin API keys are not yet supported.

## Core concepts

| Concept | Description |
| --- | --- |
| **Agent** | Durable container that holds conversation state, workspace config, and settings. Survives across multiple prompts. |
| **Run** | One prompt submission. Owns its own stream, status, result, and cancellation. |
| **SDKMessage** | Normalized stream events emitted during a run. Same shape across all runtimes. |
| **Context** | File-based or inline project context selected before each run and bounded by a token budget. |
| **Memory** | Durable facts persisted across agent instances by namespace, user, and scope. |
| **Skills** | File-based capability packs loaded from `.theokit/skills/*/SKILL.md` and exposed to the agent by name and description. |

## Creating a local agent

`Agent.create()` validates options and returns a handle immediately. `agent.agentId` is populated as `agent-<uuid>`.

```typescript
const agent = await Agent.create({
  apiKey: process.env.THEOKIT_API_KEY!,
  model: { id: "google/gemini-2.0-flash-001" },
  local: { cwd: "/path/to/repo" },
});
```

### Model parameters

Use `model.params` to pass per-model options (such as reasoning effort). Discover supported parameters with `Theokit.models.list()`.

```typescript
const agent = await Agent.create({
  apiKey: process.env.THEOKIT_API_KEY!,
  model: {
    id: "google/gemini-2.0-flash-001",
    params: [{ id: "thinking", value: "high" }],
  },
  local: { cwd: process.cwd() },
});
```

## Sending messages

Each `agent.send()` returns a `Run`. The agent retains conversation context across runs; the run is the unit of work for one prompt.

### Streaming

If all you want is the model's text, `assistantText` from `@theokit/sdk/messages` is the whole loop — it returns `""` for every event that is not an assistant message:

```typescript
import { assistantText } from "@theokit/sdk/messages";

for await (const event of run.stream()) {
  process.stdout.write(assistantText(event));
}
```

Switch on `event.type` when you need the other channels — reasoning, tool lifecycle, status:

```typescript
const run = await agent.send("Find the bug in src/auth.ts");

for await (const event of run.stream()) {
  switch (event.type) {
    case "assistant":
      // Equivalent to assistantText(event); written out here to show the shape.
      for (const block of event.message.content) {
        if (block.type === "text") process.stdout.write(block.text);
      }
      break;
    case "thinking":
      process.stdout.write(event.text);
      break;
    case "tool_call":
      console.log(`[tool] ${event.name}: ${event.status}`);
      break;
    case "status":
      console.log(`[status] ${event.status}`);
      break;
  }
}

// Follow-up. Full context is retained.
const run2 = await agent.send("Fix it and add a regression test");
await run2.wait();
```

### Sending images

```typescript
const run = await agent.send({
  text: "What's in this screenshot?",
  images: [{ data: base64Png, mimeType: "image/png" }],
});
```

### Waiting without streaming

```typescript
const result = await run.wait();
console.log(result.status);      // "finished" | "error" | "cancelled"
console.log(result.result);      // final assistant text, if any
console.log(result.model);       // resolved ModelSelection used for this run
console.log(result.durationMs);
console.log(result.git);         // { branches: [{ repoUrl, branch?, prUrl? }] } on cloud
```

### Cancelling a run

```typescript
await run.cancel();
```

The status moves to `"cancelled"`, the live stream aborts, in-flight tool calls stop, and `run.wait()` resolves with `status: "cancelled"`. Partial assistant text stays on the `Run` object. Cancel is a no-op if the run already finished.

### Reading run state

```typescript
console.log(run.status);  // "running" | "finished" | "error" | "cancelled"

const stop = run.onDidChangeStatus((status) => {
  console.log(`status changed to ${status}`);
});
// Call `stop()` to remove the listener.

// Structured per-turn view of the conversation accumulated in this run.
const turns = await run.conversation();
```

### Per-run model override

The model passed to `agent.send()` overrides the agent's selection for that run, then becomes sticky: subsequent sends without an override continue to use the new model.

```typescript
const run = await agent.send("Plan the refactor", {
  model: { id: "google/gemini-2.0-flash-001", params: [{ id: "thinking", value: "high" }] },
});
console.log(agent.model); // updated to the override after the send succeeds
```

`run.model` and `result.model` reflect the selection that this specific run actually used and are immutable once the run starts.

### Raw deltas

`run.stream()` yields normalized `SDKMessage` events. For lower-level updates (per-token text, tool-call args streaming in, thinking deltas), pass `onDelta` and `onStep` callbacks:

```typescript
const run = await agent.send("Refactor the utils module", {
  onDelta: ({ update }) => {
    if (update.type === "text-delta") process.stdout.write(update.text);
    if (update.type === "thinking-delta") process.stdout.write(update.text);
  },
  onStep: ({ step }) => {
    console.log(`[step] ${step.type}`);
  },
});
```

The callbacks are awaited before the next update is processed, so you can apply backpressure.

### Per-send options

| Property | Type | Description |
| --- | --- | --- |
| `model` | `ModelSelection` | Per-send model override. Sticky on success. |
| `mcpServers` | `Record<string, McpServerConfig>` | Inline MCP server definitions. Fully replaces creation-time servers for this run. |
| `onStep` | `(args: { step }) => void \| Promise<void>` | Callback after each completed conversation step. |
| `onDelta` | `(args: { update }) => void \| Promise<void>` | Callback per raw `InteractionUpdate`. |
| `local.force` | `boolean` | Local only. Expire a stuck active run before starting this message. |

## Stream events

Events from `run.stream()`. Discriminate on `type`. All events include `agent_id` and `run_id`.

For the common case — you only want the model's text — skip the discrimination entirely: `assistantText(event)` from [`@theokit/sdk/messages`](#streaming) returns the concatenated `TextBlock`s of an assistant message and `""` for everything else.

```typescript
type SDKMessage =
  | SDKSystemMessage
  | SDKUserMessageEvent
  | SDKAssistantMessage
  | SDKThinkingMessage
  | SDKToolUseMessage
  | SDKStatusMessage
  | SDKTaskMessage
  | SDKRequestMessage;
```

| `type` | Description | Key fields |
| --- | --- | --- |
| `"system"` | Init metadata. Emitted once at the start of a run. | `subtype?`, `model?`, `tools?` |
| `"user"` | Echo of the user prompt for this run. | `message.content: TextBlock[]` |
| `"assistant"` | Model text output. | `message.content: (TextBlock \| ToolUseBlock)[]` |
| `"thinking"` | Reasoning content. | `text`, `thinking_duration_ms?` |
| `"tool_call"` | Tool invocation lifecycle. Emitted at start with `args`, then again on completion with `result`. | `call_id`, `name`, `status`, `args?`, `result?` |
| `"status"` | Cloud run lifecycle transitions. | `status`, `message?` |
| `"task"` | Task-level milestones and summaries. | `status?`, `text?` |
| `"request"` | Awaiting user input or approval. | `request_id` |

Result data (final text, model, duration, git metadata) lives on the `Run` object after the stream completes. Use `run.wait()` to read it.

> **Tool call schema is not stable.** The `args` and `result` payloads on `tool_call` events reflect each tool's internal shape and can change as tools evolve. Tool names can also be renamed or replaced. Treat `args` and `result` as `unknown` and parse defensively. The event envelope (`type`, `call_id`, `name`, `status`) is stable.

For the full type reference (`SDKMessage`, `InteractionUpdate`, `ConversationTurn`), read the exported types — they are the canonical contract.

## Resuming agents

Reattach to an existing agent by ID. Runtime is auto-detected from the ID prefix (`bc-` is cloud, anything else is local).

```typescript
await using agent = await Agent.resume("agent-abc123", {
  apiKey: process.env.THEOKIT_API_KEY!,
});

const run = await agent.send("Also update the changelog");
await run.wait();
```

`agent.model` is `undefined` on resume unless you pass `model` again. Inline `mcpServers` are not persisted across resume — they often carry secrets and live in memory only. Pass them again on resume, or commit them to `.theokit/mcp.json`.

The conversation is persisted as a native Claude Code `.jsonl` transcript at `<sessionDir>/projects/<encoded-cwd>/<agentId>.jsonl` — resume reconstructs it from disk. `local.sessionDir` defaults to `~/.theokit`; set `local.sessionDir: "~/.claude"` and the Claude Code CLI can `--continue` the exact session your agent wrote (the SDK emits the format Claude Code reads). Extended-thinking `--continue` is out of scope for now — thinking signatures are written but dropped on read (see issue #122).

## Inspecting agents and runs

List, fetch, and reload past agents. List endpoints return `{ items, nextCursor? }` for cursor-based pagination.

```typescript
const { items, nextCursor } = await Agent.list({
  runtime: "local",
  cwd: process.cwd(),
});

const info = await Agent.get(agentId);
const runs = await Agent.listRuns(agentId);
const run = await Agent.getRun(runId, { runtime: "local" });
```

Runtime is auto-detected from the agent ID prefix when possible. For `getRun` on cloud, pass `agentId` explicitly.

## MCP servers

Agents can pick up MCP servers from several sources. Inline definitions in `Agent.create()` or `agent.send()` are the most common.

```typescript
const agent = await Agent.create({
  apiKey: process.env.THEOKIT_API_KEY!,
  model: { id: "google/gemini-2.0-flash-001" },
  local: { cwd: process.cwd() },
  mcpServers: {
    docs: {
      type: "http",
      url: "https://example.com/mcp",
      auth: { CLIENT_ID: "client-id", scopes: ["read", "write"] },
    },
    filesystem: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", process.cwd()],
    },
  },
});
```

Local agents load servers from these sources (first-match wins on conflicting names):

1. `mcpServers` on `agent.send()` — replaces creation-time servers for that run.
2. `mcpServers` on `Agent.create()`.
3. Plugin servers, if `local.settingSources` includes `"plugins"`.
4. Project servers from `.theokit/mcp.json`, if `local.settingSources` includes `"project"`.
5. User servers from `~/.theokit/mcp.json`, if `local.settingSources` includes `"user"`.

Without `local.settingSources`, only inline servers are loaded. Local OAuth-protected servers require you to have signed in previously through the Theo app — the SDK can't prompt for sign-in.

## Three things are called "plugin"

They share a word and almost nothing else. Two of the three share **the same option**, which is
where the confusion becomes a bug.

| | Registered by | Extends |
|---|---|---|
| **Framework plugin** — `@theokit/plugin-canvas`, `@theokit/auth-github`, … | installed into a `theokit` app and declared in its config | the application: routes, UI, devtools, CLI verbs |
| **SDK code plugin** — `PermissionPlugin.create(…)`, `Handoff.asPlugin(…)` | `Agent.create({ plugins: [ … ] })` — an array | the agent |
| **SDK file-discovered plugin** | `Agent.create({ plugins: { enabled: ["name"] } })`, read from `.theokit/plugins/` | the agent |

The last two are **mutually exclusive forms of one option**: pass an array or pass
`{ enabled: [...] }`, never both. An array is registered directly by the runtime and needs no
`local.settingSources` entry; `{ enabled: [...] }` selects plugins discovered on disk and does.

**A consequence worth knowing before you debug it:** `agent.pluginsManager` only ever holds the
file-discovered form. Passing `plugins: [PermissionPlugin.create(new PermissionEngine([]))]` leaves
it reporting `plugins: []` while the plugin is registered and working — an empty manager beside a
populated `options.plugins` is the normal shape, not a symptom.

## Subagents

Define named subagents that the main agent spawns via the Agent tool.

```typescript
const agent = await Agent.create({
  apiKey: process.env.THEOKIT_API_KEY!,
  model: { id: "google/gemini-2.0-flash-001" },
  local: { cwd: process.cwd() },
  agents: {
    "code-reviewer": {
      description: "Expert code reviewer for quality and security.",
      prompt: "Review code for bugs, security issues, and proven approaches.",
      model: "inherit",
    },
    "test-writer": {
      description: "Writes tests for code changes.",
      prompt: "Write comprehensive tests for the given code.",
    },
  },
});
```

Subagents committed to the repo at `.theokit/agents/*.md` (with `name`, `description`, optional `model` frontmatter) are also picked up. Inline definitions override file-based ones with the same name.

## Memory, context, and skills

Durable memory, project context, and named capability packs (Skills) are part of the public contract — exposed through `AgentOptions.memory`, `AgentOptions.context`, and `AgentOptions.skills`.

```typescript
const agent = await Agent.create({
  apiKey: process.env.THEOKIT_API_KEY!,
  model: { id: "google/gemini-2.0-flash-001" },
  local: { cwd: process.cwd(), settingSources: ["project"] },
  context: { manager: "file", maxTokens: 1200 },
  memory: { enabled: true, namespace: "my-app", userId: "user-123", scope: "user" },
  skills: { enabled: ["code-review", "test-architect"] },
});
```

- **Context** — file-based (`.theokit/context.json`) or inline; bounded by `maxTokens`; surfaced via `agent.context.snapshot()`. Snapshots never expose secrets.
- **Memory** — durable facts persisted across agent instances, keyed by `{ namespace, userId, scope }`. Must not store credentials. Local `storePath` must stay inside the workspace. `memory.directory` (absolute, or `~/`-prefixed) moves the whole store — index, sessions and notes included; a relative value is refused rather than resolved against a base you did not pick.
- **Skills** — capability packs at `.theokit/skills/<name>/SKILL.md`. Listed via `agent.skills.list()` (metadata only — full skill bodies never appear in public streams).

`agent.reload()` re-reads file-based context and skills without disposing. The runtime implementation lands with the contract — see [Status](#status) below.

## Hooks

Hooks are file-based only. There is no programmatic hook callback — hooks are a project policy boundary, not a per-run knob.

- **Local.** Add `.theokit/hooks.json` to the repo passed as `local.cwd`, or `~/.theokit/hooks.json` for user-level hooks.
- **Cloud.** Commit `.theokit/hooks.json` and its scripts to the repo passed in `cloud.repos`.

Three files are read from each config root, and **merged** — `hooks.json`, `settings.json` and
`settings.local.json`. The last two are read from `.theokit/` too, not only from `.claude/`.

That matters if another product keeps its own configuration in `.theokit/`: this is the SDK's
filebase, so a `hooks` key in a `.theokit/settings.json` is read and validated **here**, against the
shape above, whatever else wrote the file. A shape this loader cannot parse fails the run. Measured
on a consumer in 2026-09, which had documented a `hooks` array of its own and hit a refusal on every
turn — the file parsed perfectly for the product that wrote it, and the collision was one of shape,
not of location.

## Cron jobs

Schedule agent runs on a cron expression. Two runtimes:

- **Local.** The in-process scheduler activated via `Cron.start()` fires the job while the host process is alive. Persisted to `.theokit/cron/jobs.json`.
- **Cloud.** Theo PaaS schedules the job server-side. Fires regardless of any SDK process.

```typescript
import { Cron } from "@theokit/sdk";

const job = await Cron.create({
  cron: "0 9 * * *",                 // every day at 09:00
  timezone: "America/Sao_Paulo",
  message: "Summarize yesterday's commits and post to #engineering",
  agent: {
    apiKey: process.env.THEOKIT_API_KEY!,
    model: { id: "google/gemini-2.0-flash-001" },
    local: { cwd: process.cwd() },
  },
});

await Cron.start();                  // required for local jobs to fire
```

Supported expressions: 5-field POSIX cron, plus shorthand `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`. `timezone` accepts any IANA identifier; defaults to UTC.

### Managing jobs

```typescript
const { items } = await Cron.list({ runtime: "local", cwd: process.cwd() });
const job = await Cron.get(jobId);
await Cron.disable(jobId);           // pause without deleting
await Cron.enable(jobId);            // resume
await Cron.delete(jobId);            // permanent

const run = await Cron.run(jobId);   // off-schedule manual fire — returns the Run
```

### Local scheduler control

The local scheduler must be explicitly started for local jobs to fire. For 24/7 scheduling without a long-running SDK process, use the cloud runtime.

```typescript
await Cron.start({ cwd: process.cwd() });
const status = await Cron.status();
// { running: true, jobCount: 3, nextFireAt: 1747... }
await Cron.stop();
```

Cloud jobs do not need `Cron.start()` — Theo PaaS fires them server-side.

Job-to-agent binding: pass `agent` (ephemeral agent created on each fire) OR `agentId` (bound to an existing agent for context continuity). Setting both is a `ConfigurationError`.

## Artifacts

List and download files from the agent's workspace.

```typescript
const artifacts = await agent.listArtifacts();
for (const artifact of artifacts) {
  console.log(artifact.path, artifact.sizeBytes);
}
const buffer = await agent.downloadArtifact(artifacts[0].path);
```

Artifact support is runtime-dependent. **Local agents currently return no artifacts and throw for `downloadArtifact`.**

## Resource management

Always dispose agents when done. The cleanest pattern is `await using`:

```typescript
await using agent = await Agent.create({ /* ... */ });
// disposed automatically when the block exits
```

To dispose explicitly:

```typescript
await agent[Symbol.asyncDispose]();
```

`agent.close()` starts disposal without awaiting (fire-and-forget). `agent.reload()` picks up filesystem config changes (hooks, project MCP, subagents) without disposing.

## Errors

All SDK errors extend `TheokitAgentError`. Use `isRetryable` to drive retry logic.

```typescript
class TheokitAgentError extends Error {
  readonly isRetryable: boolean;
  readonly code?: string;
  readonly cause?: unknown;
  readonly protoErrorCode?: string;
}
```

| Error | When |
| --- | --- |
| `AuthenticationError` | Invalid API key, not logged in, insufficient permissions. |
| `RateLimitError` | Too many requests or usage limits exceeded. |
| `ConfigurationError` | Invalid model, bad request parameters. |
| `IntegrationNotConnectedError` | Creating a cloud agent for a repo whose SCM provider is not connected. Includes `provider` and `helpUrl`. |
| `NetworkError` | Service unavailable, timeout. |
| `UnknownAgentError` | Catch-all for unclassified server or runtime errors. |
| `UnsupportedRunOperationError` | A `Run` operation is not available on the current runtime. Check first with `run.supports(operation)`. |

## Cloud runtime — pre-release

> The cloud runtime depends on **Theo PaaS**, currently pre-release. The local runtime works without it. Cloud APIs below describe the contract for when PaaS reaches general availability.

Cloud agents are created with the same `Agent.create()` call but with the `cloud` key:

```typescript
const agent = await Agent.create({
  apiKey: process.env.THEOKIT_API_KEY!,
  model: { id: "google/gemini-2.0-flash-001" },
  cloud: {
    repos: [{ url: "https://github.com/your-org/your-repo", startingRef: "main" }],
    autoCreatePR: true,
  },
});
```

Cloud agents get a `bc-<uuid>` ID. Key differences from local:

- Repository is cloned into an isolated VM, not read from your disk.
- `listArtifacts()` / `downloadArtifact()` work (local returns empty / throws).
- `autoCreatePR`, `workOnCurrentBranch`, `skipReviewerRequest` control PR lifecycle.
- `cloud.envVars` injects short-lived credentials scoped to the agent. Encrypted at rest, deleted with the agent. Names can't start with `THEOKIT_`.
- Status events (`CREATING`, `RUNNING`, ...) reflect VM provisioning.
- MCP `headers` / `auth` for HTTP servers are handled by the backend; sensitive fields are redacted before the VM sees them.

Cloud agents started by the SDK are filtered out of the default agent list. View them by passing `runtime: "cloud"` to `Agent.list()`.

Lifecycle:

```typescript
await Agent.archive(agentId);     // soft-delete; transcript stays readable
await Agent.unarchive(agentId);   // restore an archived agent
await Agent.delete(agentId);      // permanent
```

Full cloud reference, including `CloudOptions`, `SDKAgentInfo`, and `Theokit.repositories.list()`: read the exported types.

## Configuration reference

The high-level shape:

```typescript
interface AgentOptions {
  model?: ModelSelection;       // required for local
  apiKey?: string;              // falls back to THEOKIT_API_KEY
  name?: string;
  local?: {
    cwd?: string | string[];
    settingSources?: SettingSource[];
    sandboxOptions?: { enabled: boolean };
  };
  cloud?: CloudOptions;
  mcpServers?: Record<string, McpServerConfig>;
  agents?: Record<string, AgentDefinition>;
  agentId?: string;
}
```

For the full reference (`CloudOptions`, `ModelSelection`, `McpServerConfig`, `AgentDefinition`, `SDKImage`, `SettingSource`, `ListResult`), read the exported types.

## Known limitations

- Inline `mcpServers` are not persisted across `Agent.resume()`. Pass them again on resume if needed.
- Artifact download is not implemented for local agents (`agent.listArtifacts()` returns an empty list and `agent.downloadArtifact()` throws).
- `local.settingSources` (and the file-based MCP / subagent paths it gates) does not apply to cloud agents. Cloud always loads project / team / plugins.
- Hooks are file-based only (`.theokit/hooks.json`). No programmatic callbacks.
- Cloud runtime requires Theo PaaS, currently pre-release.
- Local cron jobs only fire while the host process is alive. Run the SDK as a systemd / launchd / pm2 service, or use the cloud runtime, for 24/7 scheduling.
- Local cron jobs in flight are NOT resumed if the host process crashes mid-fire.

## Status

Honest claims only. Production-ready is not the same as "every feature shipped".

- **Local runtime** — production. The tested path.
- **Cloud runtime** — pre-release with Theo PaaS. Public contract locked in the exported types; APIs may evolve until PaaS reaches general availability.
- **Memory & Skills** — public contract locked in the exported types. Runtime implementation arrives with the contract; today the surface area is the type contract plus file conventions.
- **Cron (local)** — fires only while the host process is alive. Run as a `systemd` / `launchd` / `pm2` service, or use the cloud runtime, for 24/7 scheduling.

## Where this fits

`@theokit/sdk` is the **Harness** pillar of the Theo stack — four pillars that compose into one **open stack**:

| Pillar | Project | What it does | Status |
| --- | --- | --- | --- |
| UI | `@theokit/ui` (`theo-ui`) | AI-native primitives for agent surfaces (coding-agent + chat) + the `useAgentStream` hook that renders a live agent stream. | shipped |
| **Harness** | **`@theokit/sdk`** (this) | **Agent runtime — local (fully tested) and cloud.** | shipped |
| Skills | `@theokit/*` plugins + `theokit` | Auth providers, capability plugins, and the framework for shipping agent surfaces. | shipped (10 plugins on npm) |
| Runtime | Theo PaaS | Managed cloud deploy target. | **pre-release** |

**How they compose (the open stack).** A developer creates an agent on the SDK's
**local runtime** (Harness) with their own provider key, wires in **tools/plugins**
(Skills), and renders the streamed result through **`useAgentStream`** (UI) — a real
agent, end-to-end, against their own LLM, with **zero dependency on Theo's backend**.
The managed **cloud runtime** (Runtime / Theo PaaS) is an opt-in deploy convenience,
currently **pre-release** (its APIs describe the contract for when PaaS reaches GA —
see [Cloud runtime — pre-release](#cloud-runtime--pre-release)). This open-stack path
is the project's load-bearing promise; the dogfood anchor `open-stack-agent` exercises
it on real infrastructure (Harness + Skills tool-use + UI render, real LLM).

Cross-pillar wiring status: Skills↔Harness and UI↔Harness are validated against the
current Harness (plugins build + test green; the `useAgentStream` mapper renders a real
`Run.stream()`); Runtime↔Harness is contract-only until PaaS ships.

The SDK is a standalone TypeScript implementation with no runtime dependency on any third-party agent framework.

## Documentation

The code is the documentation: the exported TypeScript types are the canonical contract, and your editor's autocomplete is the fastest reference. Start with:

- The exported TypeScript types — every public primitive, its import path and its contract
- The JSDoc on each export — signatures and examples, surfaced by your editor

The agent skills live in [`@theokit/skills`](https://www.npmjs.com/package/@theokit/skills) — one authored home for the whole ecosystem, installed with `npx @theokit/skills`.

**Building an agent that reads documentation?** The docs site publishes machine-readable corpora following the [llmstxt.org](https://llmstxt.org) convention — [`llms.txt`](https://docs.usetheo.dev/llms.txt) (curated index) and [`llms-full.txt`](https://docs.usetheo.dev/llms-full.txt) (every page inlined, code samples verbatim). Point your agent at those instead of crawling the site.

## Development

New contributor? Start with [`CONTRIBUTING.md`](./CONTRIBUTING.md) — branch model, commit rules, and the PR checklist.

This monorepo uses **pnpm workspaces**, **Biome 2.4**, **tsup 8**, **Vitest 4**, **TypeScript 5.8+**, and **Changesets**. Node 22.12+ required (use `nvm use` to pick it up from `.nvmrc`).

```bash
nvm use                       # Node 22+ per .nvmrc
corepack enable               # makes the pinned pnpm available
corepack prepare pnpm@9.15.0 --activate

pnpm install                  # install workspace deps
pnpm typecheck                # tsc --noEmit across packages
pnpm test                     # vitest
pnpm build                    # tsup → dist/{index,errors}.{js,cjs,d.ts}
pnpm check                    # biome lint + format
pnpm validate                 # everything above plus publint + attw
```

## License

Apache-2.0 — see [LICENSE](LICENSE).

## Community

- Discord: https://discord.usetheo.dev/
- X: https://x.com/usetheodev
- LinkedIn: https://linkedin.com/company/usetheodev
