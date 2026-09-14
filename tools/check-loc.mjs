#!/usr/bin/env node
// File size budget checker — Quality Gate G8.
//
// Counts STATEMENTS, not lines, and the difference is the whole point.
//
// It counted logical lines until 2026-09-02, and a line count is moved by the
// formatter. `local-agent.ts` carried NINE `biome-ignore format` directives whose
// stated reasons were "one-liner to stay under G8 LoC budget", "multi-line layout
// would push file past G8 LoC cap", "G8 budget — see runUntil comment above" — and
// one of them produced a 332-character method on a single line. Removing all nine
// and letting the formatter run took the file from 381 to 436 logical lines while
// changing nothing about what it does: the same 185 statements, the same
// responsibilities, the same everything the cap was trying to measure.
//
// So the gate was rewarding the one action that cannot help: reformatting. A file
// that games its way under the cap is strictly worse than one over it, because the
// number now says "fine" about a file nobody has split.
//
// Statements come from the TypeScript AST, so they cannot be moved by whitespace.
// One `if`, one `return`, one property declaration is one unit however it is laid
// out. A file cannot pass this gate except by having less in it.
//
// THE LIMIT IS A PINNED MEASUREMENT, not a target: 250, against a measured maximum
// of 239 (`internal/mcp/client.ts`) across 546 files, of which 8 are above 200.
// Re-pin it downward when the maximum drops — the same ratchet
// `tools/check-duplication.mjs` and the complexity/parameter budgets use.
//
// WHAT IT STILL DOES NOT MEASURE, stated because the previous version implied
// otherwise: a statement count is not a responsibility count. A 100-statement file
// doing two unrelated jobs is worse than a 240-statement file doing one, and this
// gate prefers the first. It bounds growth; it does not certify design.

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const STATEMENT_LIMIT = 250;
const SCAN_ROOTS = ["packages/sdk/src"];
const EXCLUDE_BASENAMES = new Set(["node_modules", "dist", "coverage", ".git"]);
const EXCLUDE_FILE_PATTERNS = [/\.test\.ts$/, /\.test-d\.ts$/, /\.spec\.ts$/, /\.d\.ts$/];

function shouldIncludeFile(entry) {
  if (!entry.isFile()) return false;
  if (!/\.ts$/.test(entry.name)) return false;
  return !EXCLUDE_FILE_PATTERNS.some((pattern) => pattern.test(entry.name));
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (EXCLUDE_BASENAMES.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(path)));
      continue;
    }
    if (shouldIncludeFile(entry)) files.push(path);
  }
  return files;
}

/**
 * Executable and declarative units in one file.
 *
 * A `Block` is not counted — it is the container of the statements inside it, and counting both
 * would double every `if` body. Interface members and class properties ARE counted: a 200-field
 * interface is 200 things to maintain even though none of them executes.
 */
function countStatements(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, /* setParentNodes */ true);
  let count = 0;
  const visit = (node) => {
    if (ts.isStatement(node) && !ts.isBlock(node)) count += 1;
    else if (
      ts.isPropertyDeclaration(node) ||
      ts.isPropertySignature(node) ||
      ts.isMethodSignature(node) ||
      ts.isEnumMember(node)
    ) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return count;
}

async function main() {
  const violations = [];
  let scanned = 0;

  for (const scanRoot of SCAN_ROOTS) {
    const absoluteRoot = resolve(ROOT, scanRoot);
    const files = await walk(absoluteRoot);
    for (const file of files) {
      scanned++;
      const text = await readFile(file, "utf8");
      const statements = countStatements(file, text);
      if (statements > STATEMENT_LIMIT) {
        violations.push({ file: relative(ROOT, file), statements });
      }
    }
  }

  if (violations.length > 0) {
    console.error(
      `✗ G8 violated: ${violations.length} file(s) exceed ${STATEMENT_LIMIT} statements`,
    );
    for (const { file, statements } of violations.sort((a, b) => b.statements - a.statements)) {
      console.error(
        `  ${file}: ${statements} statements (over by ${statements - STATEMENT_LIMIT})`,
      );
    }
    console.error("");
    console.error(
      "Fix: split the file into focused modules. Reformatting will NOT help — that is why this " +
        "gate counts statements. See .claude/quality-gates.md G8.",
    );
    process.exit(1);
  }

  console.log(`✓ G8 passed: ${scanned} file(s) scanned, all ≤ ${STATEMENT_LIMIT} statements`);
}

main().catch((error) => {
  console.error("check-loc.mjs crashed:", error);
  process.exit(2);
});
