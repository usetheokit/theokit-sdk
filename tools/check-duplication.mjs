#!/usr/bin/env node
// Cross-package duplication ratchet — #295.
//
// The previous gate ran `jscpd packages/sdk/src`: one package out of fifteen. It
// reported 0 clones while 3,647 duplicated lines sat across the workspace, because
// every one of them is a copy that spans TWO packages and the scan only ever saw
// one side.
//
// What it was blind to, measured the day this was written:
//
//     283  sdk-memory/internal/index/index-manager.ts  ↔  sdk/internal/memory/index-manager.ts
//     262  sdk-memory/internal/index/lance-index.ts    ↔  sdk/internal/memory/lance-index.ts
//     242  sdk-memory/internal/active-memory/…         ↔  sdk/internal/memory/active-memory.ts
//     233  sdk-memory/internal/index/migrate-…         ↔  sdk/internal/memory/migrate-…
//     135  sdk-budget/internal/enforcement.ts          ↔  sdk/internal/budget/enforcement.ts
//
// This is not copy-paste, and it is not debt awaiting a cleanup. It is what the
// optional-peer architecture costs, decided deliberately (#306).
//
// `@theokit/sdk-budget` and `@theokit/sdk-memory` are OPTIONAL peers. sdk-core has
// to run budgets and memory with neither installed, so it needs its own working
// implementation — that is the fallback which makes the peer optional in the first
// place. The satellite needs its own to be independently richer and replaceable
// through the `BudgetTracker` / `MemoryProvider` ports.
//
// They are not collapsible by re-export, and this was tried rather than assumed:
// deleting sdk-budget's copies and re-exporting the same symbols from `@theokit/sdk`
// failed two tests immediately. The copies read identically and bind to DIFFERENT
// module-level state — each imports its own package's `./ledger.js` and
// `./registry.js`. Two ledgers, not one implementation written twice.
//
// So the number here is a CEILING, not a target. It stops a genuinely accidental
// copy from landing, which is the failure this gate exists to catch, while the
// structural overlap sits below it untouched.
//
// Raising BUDGET needs a reason in the commit message: the architecture explains
// the figure that is here, not any figure. Lower it if a real consolidation ever
// lands — the gate prints the new number when it drops.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Duplicated lines across `packages/*​/src`, as measured on 2026-08-26.
 *
 * 2886 across 102 clones, as measured on 2026-09-01. Pinned exactly: the point is that it
 * cannot grow, and a budget with slack in it is slack someone will spend.
 *
 * Was 3237 on 2026-08-26, 3333 on 2026-08-22, and 3647 on 2026-08-17. Extracting the
 * agent-name slug rule out of its two copies (`sdk-handoff`) dropped it by 314; the #400
 * session-path work dropped another 96 by routing three call sites through one resolver.
 * The 351 that came off between 2026-08-26 and 2026-09-01 were already gone when this was
 * re-pinned — the gate had been passing with that much slack, which is exactly the state
 * its own message warns about. The gate asks for the new figure to be pinned each time;
 * a budget that keeps the old slack lets the duplication come back unnoticed.
 *
 * 2886 -> 2683 on 2026-09-02: the #524 opt-in threaded one `compatSources` parameter through the
 * four config-reading subsystems, and the paths that had each resolved their own roots now share
 * `projectConfigRoots`. Pinned in the same commit that earned it.
 *
 * 2683 -> 2689 on 2026-10-16: B-380 (the memory ceiling) had to change the dreaming sweep in both
 * of its copies, `sdk/src/internal/memory/dreaming/` and `sdk-memory/src/internal/dreaming/`, which
 * still live side by side under the SDK 2.0 split (#306). Raised by decision rather than earned;
 * B-444 consolidates the two copies and brings the budget back down.
 */
const BUDGET_LINES = Number(process.env.MAX_DUPLICATED_LINES ?? 2689);

const out = mkdtempSync(join(tmpdir(), "jscpd-gate-"));
try {
  const run = spawnSync(
    "npx",
    ["jscpd", "packages/*/src", "--reporters", "json", "--output", out, "--silent"],
    { cwd: ROOT, encoding: "utf8", shell: true, timeout: 300_000 },
  );

  let report;
  try {
    report = JSON.parse(readFileSync(join(out, "jscpd-report.json"), "utf8"));
  } catch {
    console.error("✗ Duplication gate could not read the jscpd report.");
    console.error((run.stderr || run.stdout || "").slice(0, 800));
    process.exit(2);
  }

  const { clones, duplicatedLines, percentage } = report.statistics.total;

  console.log(
    `jscpd across packages/*/src: ${clones} clone(s), ${duplicatedLines} duplicated line(s) (${percentage}%)`,
  );
  console.log(`gate budget: ≤ ${BUDGET_LINES} duplicated lines`);

  if (duplicatedLines > BUDGET_LINES) {
    console.error(
      `\n✗ Duplication gate FAILED: ${duplicatedLines} exceeds the budget of ${BUDGET_LINES} by ${
        duplicatedLines - BUDGET_LINES
      }.`,
    );
    // Name the worst pairs — a percentage tells nobody which file to open.
    const pairs = new Map();
    for (const d of report.duplicates ?? []) {
      const a = d.firstFile.name.split("packages/").pop();
      const b = d.secondFile.name.split("packages/").pop();
      const key = `${a}\n        ↔ ${b}`;
      pairs.set(key, (pairs.get(key) ?? 0) + d.lines);
    }
    console.error("\nLargest duplicated pairs:");
    for (const [pair, lines] of [...pairs].sort((x, y) => y[1] - x[1]).slice(0, 6)) {
      console.error(`  ${String(lines).padStart(4)}  ${pair}`);
    }
    console.error(
      "\nExtract the shared logic into one module both sides import.\n\n" +
        "If you believe the overlap is structural rather than accidental — the way\n" +
        "sdk-core and its optional peers each need a working implementation (#306) —\n" +
        "say so in the commit message and raise BUDGET deliberately. The current\n" +
        "figure is explained by that architecture; a larger one needs its own reason.\n",
    );
    process.exit(1);
  }

  if (duplicatedLines < BUDGET_LINES) {
    console.log(
      `\n✓ Duplication gate passed, and the figure dropped by ${
        BUDGET_LINES - duplicatedLines
      } line(s).\n  Lower MAX_DUPLICATED_LINES in tools/check-duplication.mjs to ${duplicatedLines} so it cannot come back.`,
    );
    process.exit(0);
  }

  console.log("✓ Duplication gate passed (at budget).");
  process.exit(0);
} finally {
  rmSync(out, { recursive: true, force: true });
}
