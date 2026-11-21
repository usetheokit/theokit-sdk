/**
 * Lint gate (theokit#147) — the library does not write to the terminal directly.
 *
 * A TUI host installs `setDiagnosticsSink` to keep the SDK's diagnostics out of its alternate
 * screen. That contract is only worth as much as its coverage: ONE `process.stderr.write` left in a
 * hot path still corrupts the frame, and the host has no way to reach it. The original sweep
 * migrated 92 sites under `internal/` and left the ones in `src/`'s own modules — `event-bus.ts`,
 * `batch.ts`, `compaction.ts` — so a host could install a sink and still be broken by a batch run.
 *
 * "Mostly interceptable" is not interceptable. This gate is what makes the guarantee whole, and
 * what stops the next hot path from reintroducing a direct write.
 *
 * Scope: `process.stderr.write`, `process.stdout.write`, and bare `console.*`. Not banned:
 * - `internal/diagnostics.ts` — it IS the channel, and owns the one real `stderr` write.
 * - Injectable warn seams (`opts.warn ?? console.warn`), where the CALLER already chooses the sink.
 *   Those are listed explicitly, so adding one is a decision rather than a drift.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { expectScopeCovered } from "./_scope-sentinel.js";

const SRC_ROOT = join(__dirname, "..", "..", "src");

/**
 * Files allowed a direct terminal write, each for a stated reason.
 *
 * An entry here is a claim that the CALLER controls the destination, or that the file is the
 * channel itself. It is not a place to park debt.
 */
const ALLOWLIST = new Map<string, string>([
  ["internal/diagnostics.ts", "the channel itself — owns the single fallback stderr write"],
  [
    "sandbox/linux-sandbox.ts",
    "injectable `opts.warn` seam; console.warn is only the documented default",
  ],
  ["internal/workflow/ctx.ts", "the Workflow DSL's own logger seam, injectable per run"],
  [
    "internal/memory/migrate-sqlite-to-lance.ts",
    "injectable `opts.logger`; console.log is default",
  ],
]);

/** `console.log(...)` inside a docblock example is documentation, not a call. */
const COMMENT_LINE = /^\s*(\*|\/\/|\/\*)/;

const BANNED = [
  { pattern: /\bprocess\.(stderr|stdout)\.write\s*\(/, name: "process.std*.write" },
  { pattern: /(?<![.\w])console\.(log|warn|error|info|debug)\s*\(/, name: "console.*" },
];

interface Offender {
  file: string;
  line: number;
  text: string;
  rule: string;
}

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const name of await readdir(dir)) {
    const full = join(dir, name);
    const s = await stat(full);
    if (s.isDirectory()) await walk(full, out);
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

async function findOffenders(): Promise<Offender[]> {
  const offenders: Offender[] = [];
  const scanned = await walk(SRC_ROOT);
  expectScopeCovered(scanned, "index.ts", SRC_ROOT);
  for (const file of scanned) {
    const rel = relative(SRC_ROOT, file);
    if (ALLOWLIST.has(rel)) continue;
    const lines = (await readFile(file, "utf8")).split("\n");
    lines.forEach((text, i) => {
      if (COMMENT_LINE.test(text)) return;
      for (const { pattern, name } of BANNED) {
        if (pattern.test(text))
          offenders.push({ file: rel, line: i + 1, text: text.trim(), rule: name });
      }
    });
  }
  return offenders;
}

describe("theokit#147 — no direct terminal writes in src/", () => {
  it("test_every_diagnostic_goes_through_the_interceptable_channel", async () => {
    const offenders = await findOffenders();

    const rendered = offenders.map((o) => `${o.file}:${o.line} [${o.rule}] ${o.text}`).join("\n");
    expect(rendered, "route these through `diag()` so a TUI host can intercept them").toBe("");
  });

  it("test_the_allowlist_names_files_that_still_exist", async () => {
    // An allowlist entry for a deleted or renamed file silently widens the gate.
    for (const rel of ALLOWLIST.keys()) {
      await expect(
        stat(join(SRC_ROOT, rel)),
        `stale allowlist entry: ${rel}`,
      ).resolves.toBeTruthy();
    }
  });
});
