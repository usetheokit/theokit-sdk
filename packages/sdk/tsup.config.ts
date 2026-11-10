import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    errors: "src/errors.ts",
    "subagents-loader": "src/subagents-loader.ts",
    cron: "src/cron.ts",
    // M1-5: SDKMessage readers — leaf-type-only deps; DTS via tsc (tsconfig.tools-dts.json).
    messages: "src/messages.ts",
    // M2-1: compaction helpers reach internal/runtime/compression → DTS via tsc (like retry/concurrency).
    compaction: "src/compaction.ts",
    // M2-4: model-capabilities catalog — leaf module; DTS via tsc (tsconfig.tools-dts.json).
    models: "src/models.ts",
    // The provider registry as public API — a sub-entry so the barrel's module graph is untouched
    // (adding it there changed load order and broke an unrelated cron test).
    providers: "src/providers.ts",
    // M4-1: skills discovery + <skills> block — reaches internal/runtime/skills; DTS via tsc.
    skills: "src/skills.ts",
    // M4-2: project-instruction reader/writer — reaches internal/runtime/context; DTS via tsc.
    project: "src/project.ts",
    // M4-6: subagent tool scoping — reaches internal/runtime/skills+concurrency; DTS via tsc.
    subagents: "src/subagents.ts",
    // tools — EXTRACTED to @theokit/sdk-tools (SDK 2.0 split, Phase 5).
    "path-safety": "src/path-safety.ts",
    // M0-2: concurrency reaches into internal/runtime, so its DTS is generated
    // via tsc (tsconfig.tools-dts.json), NOT rollup-plugin-dts (cycle).
    concurrency: "src/concurrency.ts",
    // M0-3: retry reaches into internal/runtime, DTS via tsc (see concurrency).
    retry: "src/retry.ts",
    // V2-3: persistence helpers re-export internal/persistence; DTS via tsc (see concurrency/retry).
    persistence: "src/persistence.ts",
    "task-store": "src/task-store.ts",
    workflow: "src/workflow.ts",
    eval: "src/eval.ts",
    "server/auth/index": "src/server/auth/index.ts",
    "server/errors-envelope": "src/server/errors-envelope.ts",
    "subscription/index": "src/subscription/index.ts",
    // Public tool-input sanitization primitive — leaf module (zod type-only + node:module +
    // lazy jsonrepair); DTS via tsc (tsconfig.tools-dts.json), mirrors the subscription pattern.
    "sanitize/index": "src/sanitize/index.ts",
    // M42 — auth subsystem sub-entry (DTS via tsc; rollup-dts cannot bundle it into `.`).
    "auth/index": "src/auth/index.ts",
    "a2a/index": "src/a2a/index.ts",
    "client/index": "src/client/index.ts",
    "sandbox/index": "src/sandbox/index.ts",
    "filesystem/index": "src/filesystem/index.ts",
    "interactive/index": "src/interactive/index.ts",
    // B-103 — the sanctioned public barrel for context assembly. Its DTS goes through the `tsc`
    // path below, NOT `dts.entry`. The reason recorded here was a `types/agent.ts <-> fork-agent.ts`
    // cycle; that file has never existed and madge reports zero cycles — see the measurement on the
    // `dts:` block below. The real constraint is the double-emit and the bundled-vs-per-module shape
    // difference documented there.
    "context/index": "src/context/index.ts",
    // internal/persistence is a publicly accessible sub-path used by extracted
    // packages (sdk-memory, sdk-cache) for shared persistence primitives.
    // Documented as "internal API — semver-exempt" in README. The plugin
    // contract (definePlugin/Plugin) is exposed from the main `.` entry, NOT a
    // sub-path (see src/index.ts) — the former `internal/plugins` +
    // `internal/observability` sub-paths were removed (dead public surface,
    // 2026-07-09 dead-code review): `internal/plugins/index.ts` stays as an
    // internal relative import; `internal/observability` is reached via the
    // live `tracer-loader.ts` directly, its barrel was dead.
    // T1.3 — MCP OAuth (PKCE + refresh + token storage). A sanctioned public barrel rather than a
    // new `internal/*` sub-path: that convention is being retired (`internal/persistence/index.ts`
    // carries an `@deprecated` pointing at the public barrel), so a new one would extend a shape
    // the package is withdrawing.
    "mcp-auth": "src/mcp-auth.ts",
    "internal/persistence/index": "src/internal/persistence/index.ts",
    "internal/security/index": "src/internal/security/index.ts",
    // theokit#160 — the embedding runtime, shared with @theokit/sdk-memory so the two packages stop
    // carrying divergent copies of it. Same rationale and same semver-exempt status as the two above.
    "internal/memory/adapters/index": "src/internal/memory/adapters/index.ts",
    // #430 — the markdown memory store, shared with @theokit/sdk-memory for the same reason and
    // with the same semver-exempt status: the satellite's copy had drifted to a layout that could
    // not read what this one writes, and the peer's copy is the one that runs.
    "internal/memory/storage/index": "src/internal/memory/storage/index.ts",
  },
  format: ["esm", "cjs"],
  // DTS for 26 of the 34 sub-entries is generated via `tsc` (see onSuccess) rather than
  // rollup-plugin-dts.
  //
  // THE STATED REASON WAS FALSE AND IS NOW MEASURED. This comment said, in the present tense and in
  // three places in this file, that rollup-plugin-dts "trips on the `types/agent.ts ↔
  // fork-agent.ts` import cycle whenever a sub-entry reaches into `internal/runtime`", surfacing as
  // a spurious "ForkOptions not exported". That cycle does not exist: `src/types/fork-agent.ts` has
  // never existed in this repository (`git log --diff-filter=D` finds no deletion), madge reports
  // zero cycles, and `tests/architecture/type-cycles-closed.test.ts` asserts the same.
  //
  // Tested rather than reasoned about, on 2026-09-01: moving `concurrency` — one of the two entries
  // the comments name as blocked — into `dts.entry` and running `tsup` emitted
  // `dist/concurrency.d.cts` (2.96 KB) with no error. The blocker is not there.
  //
  // THE SPLIT NEVERTHELESS STAYS, for a reason the old comment did not give. `concurrency` is also
  // listed in `tsconfig.tools-dts.json`'s include, so putting it on both paths makes two producers
  // write the same `.d.ts` and the later one wins — a silent double-emit. Moving an entry across
  // therefore means removing it from that include as well, and the two producers do not emit the
  // same SHAPE: rollup-plugin-dts bundles, `tsc` emits file-per-module. That is a change to a
  // published artifact and needs its own verification pass against consumer type resolution, not a
  // config edit made in passing.
  //
  // What is settled: the split is a build-shape decision, NOT a workaround for a type cycle. Anyone
  // revisiting it should start from the double-emit and the shape difference above.
  dts: {
    entry: {
      index: "src/index.ts",
      errors: "src/errors.ts",
      "subagents-loader": "src/subagents-loader.ts",
      cron: "src/cron.ts",
      workflow: "src/workflow.ts",
      // Same pipeline as `index`, so `SqliteSessionStore` (private member, nominal) is emitted once
      // into a shared chunk instead of twice (#914).
      persistence: "src/persistence.ts",
      "server/auth/index": "src/server/auth/index.ts",
      "server/errors-envelope": "src/server/errors-envelope.ts",
    },
  },
  // Note: `subscription/index` DTS generated via tsc (onSuccess) — see tsconfig.tools-dts.json.
  // Mirrors tools/ + path-safety pattern to avoid rollup-plugin-dts cycle issues.
  sourcemap: true,
  clean: true,
  treeshake: true,
  // M78 — `splitting: true`, and the reason is CORRECTNESS, not size.
  //
  // With `splitting: false`, esbuild INLINES the shared code into each entry point instead of
  // emit a shared chunk. `TheokitAgentError` ended up duplicated across `errors.js`, `auth/index.js`,
  // `compaction.js`, `subscription/index.js` — distinct classes with the same name. The consequence:
  //
  //     import { TheokitAgentError } from "@theokit/sdk/errors";
  //     import { CredentialError }    from "@theokit/sdk/auth";
  //     new CredentialError("x") instanceof TheokitAgentError  // => FALSE
  //
  // The prototype chain was right; it was the class object that differed. That nullifies the whole
  // premise of a single error hierarchy: a `catch` cannot discriminate a framework error
  // when the error crossed a subpath different from the one used to import the type.
  //
  // M73's parity test predicted exactly this failure mode ("if the build inlines the SDK, the
  // layer exports a COPY and `instanceof` silently becomes false"), but predicted it for the layer;
  // it was already happening here, between the SDK's own subpaths. No unit test caught it — they all
  // import from source, where there is only one class. Only running against the PUBLISHED packages revealed it.
  //
  // Welcome side effect: `dist/index.js` dropped from 207,514 to 20,447 bytes, because what used to be
  // duplicated code became a shared chunk. The 215,000 budget became too loose and deserves to be
  // tightened in a change of its own — lowering it here would mix two decisions.
  // Keep `node:` on builtins (#960): esbuild does not resolve a bare `readline/promises` as a builtin.
  removeNodeProtocol: false,
  splitting: true,
  outDir: "dist",
  target: "node22",
  platform: "node",
  // Native + optional peer deps that must not be inlined — they require
  // runtime resolution against the host's node_modules.
  external: ["@lancedb/lancedb", "better-sqlite3", "node:sqlite", "sqlite-vec", "ws"],
  outExtension({ format }) {
    return { js: format === "esm" ? ".js" : ".cjs" };
  },
  // Generate tools/*.d.ts via tsc (rollup-plugin-dts limitation workaround).
  // Then mirror the resulting `.d.ts` into `.d.cts` so the CJS condition in
  // package.json `exports` resolves to a real `.d.cts` (eliminates attw's
  // "Masquerading as ESM" warning for `@theokit/sdk/tools` + `/path-safety`).
  onSuccess: "tsc --project tsconfig.tools-dts.json && node scripts/mirror-dts-to-cts.mjs",
});
