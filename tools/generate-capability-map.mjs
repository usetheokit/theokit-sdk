#!/usr/bin/env node
// Generates `packages/sdk/docs/harness-capability-map.md` — every public symbol and the exact
// specifier to import it from.
//
// WHY THIS EXISTS. `packages/sdk/README.md` told readers, in bold, that the capability map "ships
// inside this package" and pointed at `node_modules/@theokit/sdk/docs/harness-capability-map.md`.
// That directory did not exist in the repository, and `docs` was not in the manifest's `files`, so
// the path was empty after install twice over. The audience most harmed is the one the claim was
// written for: an agent that looks for the canonical import map, finds nothing, and guesses — which
// is how `import { Workflow } from "@theokit/sdk"` gets written when `Workflow` also lives at
// `@theokit/sdk/workflow` under a DIFFERENT declaration.
//
// GENERATED, never hand-written. The map's whole value is that it agrees with the package; a
// hand-written one is a second copy of the export list, and the copy is the one that goes stale.
// `--check` fails when the committed file has drifted, so the gate can say so.
//
// The oracle is the TypeScript compiler over each declared `types` entry — the same question a
// consumer's editor asks — not a regex over the source.
//
// Usage: node tools/generate-capability-map.mjs [--check]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { declaredEntries, PACKAGES, ROOT } from "./lib/published-entries.mjs";

const require = createRequire(import.meta.url);
const ts = require(join(ROOT, "node_modules/typescript"));
const CHECK = process.argv.includes("--check");

const OUT = join(PACKAGES, "sdk", "docs", "harness-capability-map.md");

// UNBUILT ENTRIES ABORT — they are not filtered out. Dropping them wrote a map missing a whole
// published package and `--check` then agreed with it, while the two sibling gates built on the
// same `declaredEntries()` refuse the identical tree. `packages/README.md` tells readers these
// files "cannot drift silently"; a generator that quietly narrows its own input is how that
// sentence stops being true.
// The ESM half only: the two conditions publish the same symbols under the same specifier, so
// counting both doubles every number without adding a fact. Artifact-verifying gates take both.
const declared = declaredEntries({ condition: "import" });
const unbuilt = declared.filter((entry) => !existsSync(entry.typesAbs));
if (unbuilt.length > 0) {
  console.error(`[capability-map] ✗ ${unbuilt.length} declared entr(ies) are not built:`);
  for (const entry of unbuilt.slice(0, 12)) console.error(`      ${entry.specifier}`);
  console.error("  Run `pnpm build` first — a map generated over a partial tree omits a package");
  console.error("  and reads exactly like a complete one.");
  process.exit(2);
}
const all = declared.map((entry) => ({
  pkg: entry.pkg,
  specifier: entry.specifier,
  file: entry.typesAbs,
}));
if (all.length === 0) {
  console.error("[capability-map] no built entry points found — run `pnpm build` first.");
  process.exit(2);
}

const program = ts.createProgram(
  all.map((e) => e.file),
  {
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: [],
  },
);
const checker = program.getTypeChecker();

/** What a reader needs to tell a value from a type: you can call one and only annotate the other. */
function kindOf(symbol) {
  const f = symbol.flags;
  if (f & ts.SymbolFlags.Class) return "class";
  if (f & ts.SymbolFlags.Function) return "function";
  if (f & ts.SymbolFlags.Enum) return "enum";
  if (f & ts.SymbolFlags.Interface) return "interface";
  if (f & ts.SymbolFlags.TypeAlias) return "type";
  if (f & ts.SymbolFlags.Variable) return "const";
  if (f & ts.SymbolFlags.Module) return "namespace";
  return "value";
}

/** First sentence of the docblock, for a one-line summary. Empty when undocumented. */
function summary(symbol) {
  const parts = symbol.getDocumentationComment(checker);
  const text = parts
    .map((p) => p.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length === 0) return "";
  const stop = /(?<=[.!?])\s/.exec(text);
  const first = stop === null ? text : text.slice(0, stop.index + 1);
  return first.length > 200 ? `${first.slice(0, 197)}...` : first;
}

const bySpecifier = new Map();
let undocumented = 0;
let total = 0;

for (const entry of all) {
  const source = program.getSourceFile(entry.file);
  if (source === undefined) continue;
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (moduleSymbol === undefined) continue;

  const rows = [];
  for (const sym of checker.getExportsOfModule(moduleSymbol)) {
    const target = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
    const doc = summary(target);
    total += 1;
    if (doc === "") undocumented += 1;
    rows.push({ name: sym.getName(), kind: kindOf(target), doc });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  if (rows.length > 0) bySpecifier.set(entry.specifier, { pkg: entry.pkg, rows });
}

const lines = [];
lines.push("# Harness capability map");
lines.push("");
lines.push(
  "Every public symbol the TheoKit workspace publishes, and the exact specifier to import it from " +
    "— every package, not only the one this file ships inside. **Generated from the built type " +
    "declarations** by `tools/generate-capability-map.mjs` — do not edit by hand, and do not trust " +
    "a copy of it that lives anywhere else.",
);
lines.push("");
lines.push(
  "A symbol listed under two specifiers is reachable from both, but that does NOT make the two " +
    "interchangeable: a class emitted separately into a subpath entry is a distinct nominal type " +
    "from the one in the root bundle, so passing one where the other is expected fails on a private " +
    "field. When a symbol appears twice, import it and everything it is passed to from the SAME " +
    "specifier.",
);
lines.push("");
lines.push(`${total} export(s) across ${bySpecifier.size} entry point(s).`);
lines.push("");

for (const [specifier, { rows }] of [...bySpecifier].sort()) {
  lines.push(`## \`${specifier}\``);
  lines.push("");
  lines.push("| Symbol | Kind | Summary |");
  lines.push("|---|---|---|");
  for (const r of rows) {
    const doc = r.doc.replace(/\|/g, "\\|");
    lines.push(`| \`${r.name}\` | ${r.kind} | ${doc} |`);
  }
  lines.push("");
}

const rendered = `${lines.join("\n")}\n`;

if (CHECK) {
  if (!existsSync(OUT)) {
    console.error(`[capability-map] ${OUT} is missing — run \`pnpm run docs:capability-map\`.`);
    process.exit(1);
  }
  if (readFileSync(OUT, "utf8") !== rendered) {
    console.error(
      "[capability-map] the committed map has drifted from the built declarations — run " +
        "`pnpm run docs:capability-map` and commit the result.",
    );
    process.exit(1);
  }
  console.log(
    `[capability-map] up to date — ${total} export(s) across ${bySpecifier.size} entry point(s), ` +
      `${undocumented} without a summary.`,
  );
  process.exit(0);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, rendered);
console.log(
  `[capability-map] wrote ${OUT.replace(`${ROOT}/`, "")} — ${total} export(s) across ` +
    `${bySpecifier.size} entry point(s), ${undocumented} without a summary.`,
);
