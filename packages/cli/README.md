# @theokit/cli — `theokit`

Developer CLI for `@theokit/sdk`. Four subcommands at v1: `init`, `dev`,
`inspect`, `eval`. Adoption Roadmap #1.

## Install

```bash
# One-shot scaffold via npx (recommended for first use):
npx @theokit/cli init my-bot

# Or install globally:
pnpm add -g @theokit/cli
theokit --help
```

## `theokit init <project-name>`

Scaffold a new agent project from a bundled template.

```bash
theokit init my-bot --template minimal
theokit init local-rag --template ollama-local
theokit init my-bot-tg --template telegram-bot
```

**Templates:**

- `minimal` — smallest possible Agent.create + send + stream.
- `ollama-local` — 100% local via Ollama (no remote API key).
- `telegram-bot` — Telegram bot via `@theokit/gateway` + grammy.

**Flags:**

- `-t, --template <name>` — template to use (prompts if omitted).
- `-f, --force` — overwrite non-empty destination.
- `-y, --yes` — skip prompts (CI mode).

## `theokit dev`

Run your agent's entry point under `tsx --watch`.

```bash
theokit dev                      # auto-detects src/index.ts or package.main
theokit dev --entry src/bot.ts   # explicit entry
theokit dev --env .env.local     # custom env file (default: .env)
```

## `theokit inspect`

List what the SDK sees: builtin providers, embedding adapters, gateway
adapters, and the plugins an agent started in the current directory would load
(`./.theokit/plugins/`; `~/.theokit` is never read).

```bash
theokit inspect
theokit inspect --json                 # machine-readable
theokit inspect --filter providers     # narrow to one kind
```

## `theokit eval`

Run a `eval.config.{ts,mjs}` against a real LLM and emit a markdown
report.

```bash
theokit eval                              # ./eval.config.ts → ./eval-report.md
theokit eval --config my-eval.ts --output reports/run1.md
```

**Example `eval.config.ts`:**

```ts
import type { EvalConfig } from "@theokit/cli";

export default {
  dataset: [
    { input: "Say hello in one word.", expected: "hello" },
    { input: "What is 2+2?", expected: "4" },
  ],
  scorers: [
    {
      name: "contains-expected",
      score: (output, expected) =>
        typeof expected === "string" && output.toLowerCase().includes(expected.toLowerCase())
          ? { score: 1 }
          : { score: 0, reason: `expected "${expected}"` },
    },
  ],
  agent: {
    apiKey: process.env.THEOKIT_API_KEY ?? "local",
    model: { id: "ollama/llama3.2:3b" },
    local: { cwd: process.cwd() },
  },
} satisfies EvalConfig;
```

The eval runner v1 wraps `Agent.batch` (ADR D134); when Roadmap #2
ships, internals swap to `Eval.run` — your config keeps working.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Unknown error |
| 2 | User error (bad flags, validation failure, etc.) |

## Architecture

See ADRs D193-D201 in `.claude/knowledge-base/adrs/`:

- D193: separate workspace package
- D194: commander routing
- D195: bin name `theokit`
- D196: bundled templates (offline-friendly)
- D197: `dev` via `tsx --watch`
- D198: `inspect` is read-only
- D199: `eval` v1 wraps `Agent.batch`
- D200: 3 initial templates
- D201: `Theokit.inspect.*` public API

## Requirements

- Node 22.12+.
- pnpm (recommended) or npm. Templates use pnpm scripts; npm/yarn
  users can manually translate.

## API reference

Every symbol this package exports, with the exact specifier to import it from, is in the generated
capability map that ships inside `@theokit/sdk`:

```
node_modules/@theokit/sdk/docs/harness-capability-map.md   # symbol -> import specifier
node_modules/@theokit/sdk/docs/error-codes.md              # every `code` an error can carry
```

Both are generated from the built type declarations, so they describe the version you installed
rather than the version someone wrote a page about.
