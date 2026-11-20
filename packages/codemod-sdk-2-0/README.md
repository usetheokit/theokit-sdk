# @theokit/codemod-sdk-2-0

> ## ⚠️ DEPRECATED — DO NOT USE (archived 2026-07-09)
>
> This codemod migrates imports for a **`@theokit/sdk` → `@theokit/sdk-core`
> rename that was ABANDONED.** SDK 2.0 shipped keeping the name `@theokit/sdk`
> (currently `@theokit/sdk@2.20.0`), and **`@theokit/sdk-core` does not exist on
> npm** (returns 404). Running this codemod would rewrite your imports to a
> non-existent package and **break your build**. It has zero real consumers and
> is kept only as a historical artifact. Do not run it.

Migration codemod for the `@theokit/sdk` → `@theokit/sdk-core`
rename (SDK 2.0 cohort cutover).

## What it does

Walks your project + rewrites:

- **package.json**: renames `@theokit/sdk` key in
  `dependencies` / `devDependencies` / `peerDependencies` /
  `optionalDependencies` (preserves the version constraint).
  Also renames `peerDependenciesMeta` key when present.
  If the package.json's own `name` field is `@theokit/sdk`,
  renames that too.

- **Source imports**: rewrites `@theokit/sdk` → `@theokit/sdk-core`
  in `*.ts`, `*.tsx`, `*.mts`, `*.cts`, `*.js`, `*.mjs`, `*.cjs`
  files. Uses negative-lookahead so sub-packages
  (`@theokit/sdk-memory`, `-budget`, `-cache`, `-handoff`, `-tools`)
  are **NEVER** touched.

- **Documentation**: rewrites `@theokit/sdk` in `*.md` files with
  the same negative-lookahead invariant.

Skips: `node_modules`, `dist`, `build`, `.next`, `.git`, `coverage`,
`.turbo`, `.vitest-cache`, `.pnpm-store`. Files > 1 MB skipped.

## Usage

```bash
# Dry-run (default) — reports what would change without modifying
npx @theokit/codemod-sdk-2-0

# Apply changes
npx @theokit/codemod-sdk-2-0 --write

# Apply + preserve .bak per modified file
npx @theokit/codemod-sdk-2-0 --write --backup

# Target a different directory
npx @theokit/codemod-sdk-2-0 --root path/to/project
```

## Recommended flow

1. Commit any uncommitted work.
2. Run dry-run + inspect the report:
   ```bash
   npx @theokit/codemod-sdk-2-0
   ```
3. Apply with backup:
   ```bash
   npx @theokit/codemod-sdk-2-0 --write --backup
   ```
4. Update your peerDep version constraint manually if you pinned
   `@theokit/sdk` to a `1.x` version:
   ```diff
   - "@theokit/sdk-core": ">=1.7.0"
   + "@theokit/sdk-core": "^2.0.0"
   ```
5. Reinstall:
   ```bash
   pnpm install   # or npm install / yarn install
   ```
6. Run your test suite. If everything passes, commit + drop the
   `.bak` files:
   ```bash
   find . -name "*.bak" -delete
   git add -A
   git commit -m "migrate to @theokit/sdk-core (SDK 2.0)"
   ```

## What changed in SDK 2.0

- Package renamed `@theokit/sdk` → `@theokit/sdk-core`.
- Major bumped to 2.0.0.
- Memory subsystem extracted to `@theokit/sdk-memory` (Stage 3
  source-move). sdk-core's public `Memory` class + `migrateSqliteToLance`
  wrapper routes through it when installed; falls back to legacy
  internal copy when absent (Stage 4 optional-peer routing).
- Budget / cache / handoff / tools subsystems were extracted earlier
  (Phases 2-5) — no code change needed in this rename.

## Behavioral invariants the codemod preserves

The codemod does **not**:

- Touch sub-package specifiers (`@theokit/sdk-memory`, etc.).
- Modify lockfiles (run your package manager's install command
  after migration).
- Bump the version constraint (operator step — needed only if
  you previously pinned `@theokit/sdk@^1.x.x`).
- Run tests (you run them after).

## License

Apache-2.0.
