# @theokit/sdk-tools

Built-in tools for `@theokit/sdk` agents. File system, git, subprocess, search-text, vitest runner. Each tool is a factory that returns a `CustomTool` ready to drop into `Agent.create({ tools: [...] })`.

Extracted from `@theokit/sdk@1.7.0` as part of the SDK 2.0 package split.

The exported TypeScript types cover every tool + guard primitive (`buildRepoMap`, `isBlockedIp`, `screenedFetch`, `catastrophicShellReason`, ...) with import paths and examples.

## Install

```bash
pnpm add @theokit/sdk @theokit/sdk-tools

# Optional peers if you use the corresponding tool:
pnpm add simple-git    # for createGitDiffTool
pnpm add vitest        # for createRunVitestTool
```

## Quick start

```typescript
import { Agent } from "@theokit/sdk";
import {
  createListDirTool,
  createReadFileTool,
  createSearchTextTool,
  createTodolistTool,
} from "@theokit/sdk-tools";

const agent = await Agent.create({
  model: { id: "openai/gpt-4o-mini" },
  tools: [
    createReadFileTool({ cwd: process.cwd() }),
    createListDirTool({ cwd: process.cwd() }),
    createSearchTextTool({ cwd: process.cwd() }),
    createTodolistTool(), // every factory result is a `CustomTool`: no cast needed
  ],
});

await agent.send("List the TypeScript files in src/ and read the largest one");
```

## Available tools

| Factory | What it does | Optional peer |
|---|---|---|
| `createReadFileTool` | Read a file under `cwd`, with sensitive-file blocklist (`.env`, lock files, `node_modules`, `.git`). | — |
| `createListDirTool` | List directory contents under `cwd`. Skips forbidden paths. | — |
| `createSearchTextTool` | grep-style search across files under `cwd`. | — |
| `createGitDiffTool` | Show git diff (staged / working tree / range). | `simple-git` |
| `createRunVitestTool` | Run vitest with JSON reporter; return structured results. | `vitest` |
| `createSubprocessTool` | Spawn a child process with timeout + abort + cleanup. | — |

### `projectRoot` and `baseDir`

`createWriteFileTool`, `createEditFileTool` and `createApplyPatchTool` take `projectRoot`, the boundary every resolved path is checked against. They also take an optional `baseDir`: the base for *relative* paths in the model's input (default `projectRoot`). It must be `projectRoot` or a directory inside it, otherwise construction throws a `BaseDirOutsideProjectRootError` naming both paths. Absolute paths are unchanged, and the `.env` / `.git` refusals still apply to a relative path resolved against `baseDir`. Use it when `projectRoot` is widened (a monorepo root, `/`) but `hello.txt` should land in the working directory:

```ts
createWriteFileTool({ projectRoot: "/", baseDir: "/home/me/app" }); // "hello.txt" -> /home/me/app/hello.txt
```

## Security guard rails

All tools validate paths against the universal forbidden-path blocklist:

- `.env`, `.env.<anything>` (except `.env.example`)
- `.git/`, `node_modules/`, `.theo/`
- Lock files (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lockb`)

Sub-shell tools (`subprocess`, `git-diff`, `run-vitest`) use timeout + AbortController + spawned-process cleanup to avoid zombies.

## How it fits with `@theokit/sdk`

- **Foundation:** `Tool.create` and the `CustomTool` type come from `@theokit/sdk`.
- **No kernel coupling:** sdk-tools never imports from `@theokit/sdk/internal/runtime` or the agent loop.
- **Path-guard inline:** the small `isForbiddenPath` helper is inlined here (rather than importing from `@theokit/sdk/internal/security`) so sdk-tools is self-contained for the security-critical check.

## Migration from `@theokit/sdk@1.x`

Before (1.x):

```typescript
import { createReadFileTool } from "@theokit/sdk/tools";
```

After (2.x):

```typescript
import { createReadFileTool } from "@theokit/sdk-tools";
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
