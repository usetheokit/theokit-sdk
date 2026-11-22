# @theokit/acp

Agent Client Protocol (ACP) server adapter for [`@theokit/sdk`](https://www.npmjs.com/package/@theokit/sdk).

Exposes an agent over stdio JSON-RPC so any [ACP-compatible host](https://agentclientprotocol.com) can drive it as a coding agent — without writing any glue code.

`serveAcp` takes any `AgentLike` (from `@theokit/sdk`) or a `(sessionId) => AgentLike` factory, so a wrapper around an `SDKAgent` needs no cast; an `SDKAgent` still works. `dispose` is optional. With `permissionDefault: "ask"` or `"deny"` the agent must also expose a `pluginManager()`; otherwise `session/new` fails closed with `permission_enforcement_unavailable`.

```bash
npm i @theokit/acp @theokit/sdk @agentclientprotocol/sdk
```

## Quick start

```ts
// my-agent.ts (the file your ACP host will spawn)
import { Agent } from "@theokit/sdk";

export default async (sessionId: string) => {
  return Agent.create({
    apiKey: process.env.OPENROUTER_API_KEY,
    model: { id: "openai/gpt-4o-mini" },
    local: { cwd: process.cwd() },
    name: `acp-${sessionId}`,
  });
};
```

```bash
# Launch the server (an ACP host will do this for you)
npx theokit-acp --entry ./my-agent.ts
```

## Permission modes

- `--permission ask` (default) — every tool call prompts the host UI.
- `--permission auto` — pass-through; no UI.
- `--permission deny` — reject every tool call (headless CI).
- `--trusted-tools read_file,list_dir` — names bypassed in `ask` mode.
- `--permission-timeout-ms 60000` — auto-deny after timeout (EC-2 / D355).

## Use in code

```ts
import { Agent } from "@theokit/sdk";
import { serveAcp } from "@theokit/acp";

await serveAcp({
  agent: async (sessionId) => Agent.create({ /* ... */ }),
  info: { name: "my-agent", version: "1.0.0" },
  permissionDefault: "ask",
  trustedTools: ["read_file", "list_dir"],
});
```

## Architecture

| ACP concept       | SDK mapping                                                    |
| ----------------- | -------------------------------------------------------------- |
| `new_session`     | `Agent.create({ local: { cwd } })`                            |
| `load_session`    | `Agent.resume(sessionId)` (D352)                              |
| `cancel`          | session `AbortController.abort()` (D354)                       |
| `prompt`          | `agent.send(text, { signal }).stream()` (D353)                |
| `tool permission` | `pre_tool_call` veto hook (D355)                              |
| `session/fork`    | deferred to v0.2 (D350)                                       |

## Versioning

Pre-1.0 (`0.x`). Breaking changes are allowed within `0.x` (D181 pattern) until upstream ACP stabilizes.

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

Apache-2.0

## Client: drive another ACP agent

`@theokit/acp/client` is a separate entry (server-only consumers never load it). It spawns an ACP agent as a child process and drives it through the ACP SDK's `ClientSideConnection`.

```ts
import { connectAcpAgent, AcpAgentSpawnError } from "@theokit/acp/client";

const agent = await connectAcpAgent({
  command: "my-agent",              // absolute path, or a bare name found on absolute PATH entries of `env`
  args: ["--stdio"],
  cwd: "/work/project",
  env: { PATH: "/usr/local/bin:/usr/bin" }, // passed as is; nothing is inherited from process.env
  onPermission: async (request) => ({ outcome: { outcome: "selected", optionId: "deny" } }),
});

const controller = new AbortController();
for await (const { update } of agent.prompt("hi", controller.signal)) {
  console.log(update);
}
await agent.close();
```

- **Command resolution.** A relative `command` with a path separator is refused. A bare name is resolved only against `env.PATH`, and a relative or empty `PATH` entry (`.`, `::`) refuses it before anything is spawned.
- **Environment.** `env` is the child's whole environment; `process.env` is never merged in.
- **Permissions.** The agent's `session/request_permission` reaches `onPermission`; its answer is sent back unchanged.
- **Cancellation.** Aborting the `signal` passed to `prompt` sends `session/cancel`. One prompt may be in flight per connection.
- **Failures.** `AcpAgentSpawnError` is raised when the command is refused or not found, or when the child exits (or stalls past `initializeTimeoutMs`, default 10 s) during `initialize`. A child that exits mid-prompt ends the iterator with the same error, naming the exit code and the last (bounded) stderr lines.
- **Cleanup.** `close()` kills the child, and its whole process group on POSIX. It is idempotent.
