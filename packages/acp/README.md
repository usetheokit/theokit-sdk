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

## Client: drive another ACP agent

`@theokit/acp/client` is the other direction: spawn an ACP agent and use it as a tool or sub-agent. It is a separate subpath, so server-only consumers never load it.

```ts
import { connectAcpAgent } from "@theokit/acp/client";

const agent = await connectAcpAgent({
  command: "/usr/local/bin/some-acp-agent", // absolute, or a bare name found on env.PATH
  args: ["--stdio"],
  cwd: process.cwd(),
  env: { PATH: "/usr/bin:/bin" }, // passed as is; nothing comes from process.env
  onPermission: async (request) => ({
    outcome: { outcome: "selected", optionId: request.options[0]?.optionId ?? "" },
  }),
});

const ac = new AbortController();
for await (const n of agent.prompt("hi", ac.signal)) console.log(n.update);
await agent.close();
```

- **Environment.** The child receives exactly `env`. Add `HOME`, provider keys and the like yourself.
- **Command resolution.** An absolute `command` is used as is. A bare name is looked up on the entries of `env.PATH`; if any entry is empty or relative, the connection is refused with `AcpAgentSpawnError` before anything is spawned. A relative path such as `./agent` is refused too.
- **Prompts.** One prompt at a time per connection; a second concurrent `prompt()` throws. Aborting `signal` sends `session/cancel`; the iterator then ends with the agent's cancelled turn.
- **Failures.** A command that is missing, refused, or exits during `initialize` rejects `connectAcpAgent` with `AcpAgentSpawnError` (`exitCode`, and the last stderr lines in the message). A child that exits mid-prompt ends the iterator with the same error.
- **Cleanup.** `close()` cancels a running turn and kills the child's process group (the child itself on Windows).

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
