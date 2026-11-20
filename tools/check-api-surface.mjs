#!/usr/bin/env node

// The public surface of `@theokit/sdk`, compared with the previous release's.
//
// `check-public-surface`, `check-dts-export-parity` and `check-dts-exports` ask whether the CURRENT
// `.d.ts` is consistent with itself. None asks whether it still matches what consumers installed
// last time, so a PR deleting a stable export passed them all. This gate keeps a committed
// baseline (`tools/api-surface/sdk.json`) and fails when:
//
//   1. the baseline differs from the freshly generated surface (the diff names the names);
//   2. against the baseline on the PR base, a stable name is removed, renamed, demoted to
//      experimental, or its declaration changes other than by an added optional property, and no
//      changeset added in the PR range declares `"@theokit/sdk": major`;
//   3. a stable name is removed less than DEPRECATION_WINDOW_DAYS after `deprecatedSince`, major
//      or not.
//
// THE ORACLE IS THE COMPILER (see `check-public-surface.mjs`): names, tiers and declarations come
// from the TypeScript checker and printer, never from matching `.d.ts` text.
//
// When the PR base cannot be resolved (a shallow checkout) the breaking-change comparison is
// skipped with a warning, unless API_SURFACE_STRICT=1, which fails closed. API_SURFACE_BASE names
// the base ref explicitly.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { declaredEntries, ROOT } from "./lib/published-entries.mjs";

/** ADR `api-stability-policy.md`, "CI gate": proposed, awaiting confirmation. One constant. */
export const DEPRECATION_WINDOW_DAYS = 90;
export const PACKAGE = "@theokit/sdk";
export const BASELINE_PATH = join(ROOT, "tools/api-surface/sdk.json");
const DAY_MS = 86_400_000;

const printer = ts.createPrinter({ removeComments: true });

const entryKey = (e) => `${e.subpath}#${e.condition}`;
const isInternal = (subpath) => subpath === "./internal" || subpath.startsWith("./internal/");

function declarationText(symbol) {
  const texts = (symbol.declarations ?? []).map((d) =>
    printer
      .printNode(ts.EmitHint.Unspecified, d, d.getSourceFile())
      .replace(/import\("\.\/[^"]*"\)/g, 'import("./chunk")'),
  );
  return texts.join("\n");
}

function surfaceOfEntry(entry) {
  const program = ts.createProgram([entry.typesAbs], {
    noEmit: true,
    skipLibCheck: true,
    types: [],
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry.typesAbs);
  const moduleSymbol = source && checker.getSymbolAtLocation(source);
  const names = {};
  for (const exported of moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : []) {
    const target =
      exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    const tags = target.getJsDocTags(checker).map((t) => t.name);
    names[exported.getName()] = {
      tier: tags.includes("experimental") ? "experimental" : "stable",
      declaration: declarationText(target),
      ...(tags.includes("deprecated") ? { deprecated: true } : {}),
    };
  }
  return names;
}

/**
 * The surface of the given entries (`{subpath, condition, typesAbs}`), `./internal/*` skipped.
 * `previous` is the committed baseline: `deprecatedSince` is the date a name was first seen
 * `@deprecated`, so an existing date is carried and only a new deprecation gets `today`.
 */
export function buildSurface(
  entries,
  { previous, today = new Date().toISOString().slice(0, 10) } = {},
) {
  const out = {};
  const sorted = entries
    .filter((e) => !isInternal(e.subpath))
    .sort((a, b) => entryKey(a).localeCompare(entryKey(b)));
  for (const entry of sorted) {
    const names = surfaceOfEntry(entry);
    const sortedNames = {};
    for (const name of Object.keys(names).sort()) {
      const { deprecated, ...rest } = names[name];
      const since = previous?.entries?.[entryKey(entry)]?.[name]?.deprecatedSince;
      sortedNames[name] = { ...rest, ...(deprecated ? { deprecatedSince: since ?? today } : {}) };
    }
    out[entryKey(entry)] = sortedNames;
  }
  return { package: PACKAGE, entries: out };
}

function membersOf(text) {
  const file = ts.createSourceFile("x.d.ts", text, ts.ScriptTarget.Latest, true);
  const [node, ...rest] = file.statements;
  if (rest.length > 0 || !node) return undefined;
  const body = ts.isInterfaceDeclaration(node)
    ? node
    : ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)
      ? node.type
      : undefined;
  if (!body) return undefined;
  return {
    header: text.slice(0, body.members.pos),
    members: body.members.map((m) => ({
      text: m.getText(file),
      optional: ts.isPropertySignature(m) && !!m.questionToken,
    })),
  };
}

/** True when `next` is `prev` plus new optional properties and nothing else. */
export function onlyAddsOptionalProperties(prev, next) {
  if (prev === next) return true;
  const a = membersOf(prev);
  const b = membersOf(next);
  if (!a || !b || a.header !== b.header) return false;
  const nextTexts = new Set(b.members.map((m) => m.text));
  const prevTexts = new Set(a.members.map((m) => m.text));
  return (
    a.members.every((m) => nextTexts.has(m.text)) &&
    b.members.every((m) => prevTexts.has(m.text) || m.optional)
  );
}

function breakingReason(prev, next) {
  if (!next) return "removed";
  if (prev.tier === "stable" && next.tier === "experimental") return "demoted to experimental";
  if (!onlyAddsOptionalProperties(prev.declaration, next.declaration)) return "declaration changed";
  return undefined;
}

/**
 * Breaking changes from `base` to `current`, as `{ where, name, reason, removed }`. Only names that
 * were stable in `base` count; a whole removed entry removes each of its names.
 */
export function breakingChanges(base, current) {
  const out = [];
  for (const [key, names] of Object.entries(base.entries)) {
    for (const [name, prev] of Object.entries(names)) {
      if (prev.tier !== "stable") continue;
      const reason = breakingReason(prev, current.entries[key]?.[name]);
      if (reason) out.push({ where: key, name, reason, removed: reason === "removed", prev });
    }
  }
  return out;
}

/** Removals inside the deprecation window, as strings. A removal with no `deprecatedSince` is not one. */
export function windowViolations(breaking, today) {
  const out = [];
  for (const b of breaking.filter((x) => x.removed && x.prev.deprecatedSince)) {
    const age = Math.floor((Date.parse(today) - Date.parse(b.prev.deprecatedSince)) / DAY_MS);
    if (age < DEPRECATION_WINDOW_DAYS) {
      out.push(
        `${b.where} ${b.name}: removed ${age} days after deprecation (minimum ${DEPRECATION_WINDOW_DAYS})`,
      );
    }
  }
  return out;
}

/** The names that differ between two surfaces, as `entry name` strings. */
export function differingNames(a, b) {
  const out = [];
  for (const key of new Set([...Object.keys(a.entries), ...Object.keys(b.entries)])) {
    const left = a.entries[key] ?? {};
    const right = b.entries[key] ?? {};
    for (const name of new Set([...Object.keys(left), ...Object.keys(right)])) {
      if (JSON.stringify(left[name]) !== JSON.stringify(right[name])) out.push(`${key} ${name}`);
    }
  }
  return out.sort();
}

/** True when some changeset text declares `"@theokit/sdk": major` in its frontmatter. */
export function declaresMajor(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return false;
  return match[1].split(/\r?\n/).some((line) => {
    const m = /^\s*["']?([^"':]+)["']?\s*:\s*["']?(\w+)["']?\s*$/.exec(line);
    return m?.[1] === PACKAGE && m[2] === "major";
  });
}

function git(args) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function resolveBase() {
  for (const ref of [process.env.API_SURFACE_BASE, "origin/workspace", "origin/main"].filter(
    Boolean,
  )) {
    try {
      return git(["merge-base", "HEAD", ref]).trim();
    } catch {}
  }
  return undefined;
}

function addedChangesets(base) {
  const files = git([
    "diff",
    "--name-only",
    "--diff-filter=A",
    `${base}...HEAD`,
    "--",
    ".changeset",
  ])
    .split("\n")
    .filter((f) => /^\.changeset\/[^/]+\.md$/.test(f) && !f.endsWith("README.md"));
  return files.map((f) => readFileSync(join(ROOT, f), "utf8"));
}

function baseBaseline(base) {
  try {
    return JSON.parse(git(["show", `${base}:tools/api-surface/sdk.json`]));
  } catch {
    return undefined;
  }
}

const readBaseline = () =>
  existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : undefined;
const sdkEntries = () => declaredEntries().filter((e) => e.pkg === PACKAGE);

function compareToBase(current, today, log) {
  const strict = process.env.API_SURFACE_STRICT === "1";
  const base = resolveBase();
  if (!base) {
    log(`PR base not resolvable: breaking-change comparison ${strict ? "cannot run" : "skipped"}`);
    return strict ? ["cannot resolve the PR base (API_SURFACE_STRICT=1)"] : [];
  }
  const before = baseBaseline(base);
  if (!before) return [];
  const breaking = breakingChanges(before, current);
  const problems = windowViolations(breaking, today);
  if (breaking.length > 0 && !addedChangesets(base).some(declaresMajor)) {
    problems.push(
      ...breaking.map(
        (b) => `${b.where} ${b.name}: ${b.reason}, no added changeset declares "${PACKAGE}": major`,
      ),
    );
  }
  return problems;
}

export function main(
  argv,
  { today = new Date().toISOString().slice(0, 10), log = console.error } = {},
) {
  const previous = readBaseline();
  const current = buildSurface(sdkEntries(), { previous, today });
  if (argv.includes("--write")) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
    log(`wrote ${BASELINE_PATH}`);
    return 0;
  }
  const problems = previous
    ? differingNames(previous, current).map((n) => `baseline differs: ${n}`)
    : ["no committed baseline: run node tools/check-api-surface.mjs --write"];
  if (previous) problems.push(...compareToBase(current, today, log));
  for (const p of problems) log(`FAIL ${p}`);
  if (problems.length > 0)
    log("api-surface: FAIL (regenerate with --write; breaking changes need a major changeset)");
  else log("api-surface: PASS");
  return problems.length > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  process.exit(main(process.argv.slice(2)));
