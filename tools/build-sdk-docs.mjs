#!/usr/bin/env node
// Runs at the end of `@theokit/sdk`'s build: writes the two generated references that ship in the
// package (`docs/harness-capability-map.md`, `docs/error-codes.md`). Neither is committed.
//
// The capability map covers every published workspace package, and those build AFTER the SDK
// (they import it). A standalone SDK build therefore builds any sibling whose declarations are
// missing first; under turbo they are rebuilt (or restored from cache) later, which is harmless.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { declaredEntries, ROOT } from "./lib/published-entries.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const missing = new Set(
  declaredEntries({ condition: "import" })
    .filter((e) => !existsSync(e.typesAbs))
    .map((e) => e.pkg),
);
missing.delete("@theokit/sdk");
if (missing.size > 0) {
  run("pnpm", [
    "--workspace-concurrency=1",
    ...[...missing].flatMap((n) => ["--filter", n]),
    "run",
    "build",
  ]);
}
run("node", [join(here, "generate-error-codes.mjs")]);
run("node", [join(here, "generate-capability-map.mjs")]);
