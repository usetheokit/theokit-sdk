/**
 * Lint gate (T5.3, ADR D85 mirror): no `ctx.messages.push` outside the
 * agent-loop. Cache-discipline invariant — history is append-only and
 * mutation belongs strictly to `internal/agent-loop/`.
 *
 * EC-8 fix: regex bounded by contextual prefix `(ctx|loopCtx|context)`
 * avoids false-positives for unrelated `*Messages.push` variables.
 */

import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";
import { expectScopeCovered } from "./_scope-sentinel.js";

const SRC_ROOT = join(__dirname, "..", "..", "src");

const ALLOWLIST = new Set<string>(["internal/agent-loop/loop.ts"]);

const BAD_PATTERN = /\b(ctx|loopCtx|context)\.messages\.push\b/;

interface Offender {
  file: string;
  line: number;
  excerpt: string;
}

async function walkTs(dir: string, out: string[] = []): Promise<string[]> {
  for (const name of await readdir(dir)) {
    const full = join(dir, name);
    const s = await stat(full);
    if (s.isDirectory()) await walkTs(full, out);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

function scanFile(rel: string, content: string): Offender[] {
  const out: Offender[] = [];
  for (const [idx, raw] of content.split("\n").entries()) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    if (BAD_PATTERN.test(raw)) {
      out.push({ file: rel, line: idx + 1, excerpt: trimmed });
    }
  }
  return out;
}

describe("lint: no history mutation outside agent-loop (T5.3, ADR D85)", () => {
  it("allowlist entries exist on disk", () => {
    for (const rel of ALLOWLIST) {
      const abs = join(SRC_ROOT, rel);
      expect(existsSync(abs), `stale allowlist entry: ${rel}`).toBe(true);
    }
  });

  it("BAD_PATTERN catches ctx.messages.push (EC-8 positive)", () => {
    const sample = "  ctx.messages.push({ role: 'user', content: '...' });";
    expect(BAD_PATTERN.test(sample)).toBe(true);
  });

  it("BAD_PATTERN does NOT flag unrelated *Messages.push (EC-8 negative)", () => {
    const sample = "const otherMessages = []; otherMessages.push(x);";
    expect(BAD_PATTERN.test(sample)).toBe(false);
  });

  it("scans src/ for unguarded history mutation", async () => {
    const files = await walkTs(SRC_ROOT);
    expectScopeCovered(files, "index.ts", SRC_ROOT);
    const offenders: Offender[] = [];
    for (const file of files) {
      const rel = relative(SRC_ROOT, file).replace(/\\/g, "/");
      if (ALLOWLIST.has(rel)) continue;
      const content = await readFile(file, "utf8");
      offenders.push(...scanFile(rel, content));
    }
    if (offenders.length > 0) {
      process.stderr.write(
        `History mutation outside loop:\n${offenders.map((o) => `  ${o.file}:${o.line} — ${o.excerpt}`).join("\n")}\n`,
      );
    }
    expect(offenders).toEqual([]);
  });
});
