#!/usr/bin/env node
// Generates `packages/sdk/docs/error-codes.md` — every error code the SDK can put on an error, the
// class that carries it, and where it is raised.
//
// WHY. `packages/sdk/README.md` points at `node_modules/@theokit/sdk/docs/error-codes.md` as the
// `AgentRunError.code` reference. The file did not exist. Meanwhile `errors.ts` declares an
// `ErrorCode` union of eleven transport-level codes while the source raises far more than that
// across configuration, auth, memory, sandbox and tools — so a caller reading only the union sees a
// fraction of what it can meet, and a caller reading nothing writes `catch (e) {}`.
//
// EXTRACTED FROM THE AST, not a regex. Two forms carry a code and a regex over the text finds one of
// them: `new SomeError(msg, { code: "x" })` and `readonly code = "x" as const` on a class. An
// earlier pass that matched only the first reported two live codes as undocumented.
//
// Usage: node tools/generate-error-codes.mjs [--check]

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ts = require(join(ROOT, "node_modules/typescript"));
const CHECK = process.argv.includes("--check");
const OUT = join(ROOT, "packages", "sdk", "docs", "error-codes.md");

// SORTED, both here and over `packages/` below. `record()` appends sites in traversal order and the
// table renders `sites[0]` verbatim into a file that `--check` compares byte-for-byte. readdir order
// is guaranteed by neither POSIX nor Node — it varies by filesystem and by file-creation order — so
// an unsorted walk makes a required CI gate depend on how the checkout happened to be written.
// Measured: reversing directory order moves 58 lines of the committed reference.
function sources(dir, out = []) {
  for (const entry of readdirSync(dir).sort()) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const files = [];
for (const pkg of readdirSync(join(ROOT, "packages")).sort()) {
  const src = join(ROOT, "packages", pkg, "src");
  const manifest = join(ROOT, "packages", pkg, "package.json");
  if (!existsSync(src) || !existsSync(manifest)) continue;
  if (JSON.parse(readFileSync(manifest, "utf8")).private === true) continue;
  sources(src, files);
}

/** code -> { classes:Set, sites:[{file,line}] } */
const codes = new Map();

function record(code, className, file, line) {
  if (!codes.has(code)) codes.set(code, { classes: new Set(), sites: [] });
  const e = codes.get(code);
  if (className) e.classes.add(className);
  e.sites.push({ file, line });
}

/** Form 1 — `new SomeError(message, { code: "x" })`, or the same shape as a plain call. */
/** The string a `code:` property is assigned in an object literal, or `undefined`. */
function codeLiteralIn(objectLiteral, sf) {
  for (const prop of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = prop.name.getText(sf);
    if (key !== "code" && key !== '"code"') continue;
    if (ts.isStringLiteral(prop.initializer)) return prop.initializer.text;
  }
  return undefined;
}

function visitConstruction(node, sf, rel) {
  if (!ts.isNewExpression(node) && !ts.isCallExpression(node)) return;
  const className = ts.isIdentifier(node.expression) ? node.expression.text : undefined;
  const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  for (const arg of node.arguments ?? []) {
    if (!ts.isObjectLiteralExpression(arg)) continue;
    const code = codeLiteralIn(arg, sf);
    if (code !== undefined) record(code, className, rel, line);
  }
}

/**
 * Form 3 — a bare object-literal property, `{ code: "x", … }`, assigned anywhere. The error mappers
 * build their result objects this way rather than constructing an error class, so matching only
 * forms 1 and 2 dropped ELEVEN codes — including `rate_limit`, `context_too_long` and `timeout`,
 * which are the canonical transport ones. A reference missing those is worse than no reference: it
 * reads as complete.
 */
function visitBareProperty(node, sf, rel) {
  if (!ts.isPropertyAssignment(node)) return;
  if (node.name.getText(sf) !== "code") return;
  if (!ts.isStringLiteral(node.initializer)) return;
  // ANY identifier-shaped literal, not just snake_case lowercase. The narrower class silently
  // dropped `INTERNAL_SERVER_ERROR` (`src/server/errors-envelope.ts`, published as
  // `@theokit/sdk/server/errors-envelope`) and `subscribe_baseUrl_missing`
  // (`src/subscription/theokit-subscribe.ts`, published as `@theokit/sdk/subscription`) — one
  // SCREAMING_CASE, one camelCase in the middle. A reference that promises "every code this SDK
  // puts on an error" and omits two of them is worse than no reference: it reads as complete.
  // Measured over `src/` only (tests are never walked), widening admits exactly those two and no
  // noise.
  if (!/^[A-Za-z][A-Za-z0-9_]{3,}$/.test(node.initializer.text)) return;

  const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const already = codes
    .get(node.initializer.text)
    ?.sites.some((site) => site.file === rel && Math.abs(site.line - line) <= 2);
  if (already !== true) record(node.initializer.text, undefined, rel, line);
}

/**
 * Form 4 — a DECLARED union: `code: "a" | "b"` on an interface property OR a constructor parameter.
 * A code can be part of the contract and never appear as a literal at a raise site, because a
 * mapper assigns it through a variable — `context_too_long` is exactly that, and it is the
 * canonical code callers branch on most.
 */
/** The string-literal members of a union type node, in declaration order. */
function stringLiteralsOf(unionType) {
  return unionType.types
    .filter((member) => ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal))
    .map((member) => member.literal.text);
}

function visitDeclaredUnion(node, sf, rel) {
  if (!ts.isPropertySignature(node) && !ts.isParameter(node)) return;
  if (node.name.getText(sf) !== "code") return;
  if (!node.type || !ts.isUnionTypeNode(node.type)) return;

  const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  for (const code of stringLiteralsOf(node.type)) {
    if (!codes.has(code)) record(code, undefined, rel, line);
  }
}

/** Form 2 — `readonly code = "x" as const;` inside a class declaration. */
function visitClassProperty(node, sf, rel) {
  if (!ts.isPropertyDeclaration(node)) return;
  if (node.name.getText(sf) !== "code" || !node.initializer) return;

  const init = ts.isAsExpression(node.initializer) ? node.initializer.expression : node.initializer;
  if (!ts.isStringLiteral(init)) return;

  const owner = node.parent;
  const className =
    owner && ts.isClassDeclaration(owner) && owner.name ? owner.name.text : undefined;
  record(init.text, className, rel, sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
}

const FORMS = [visitConstruction, visitBareProperty, visitDeclaredUnion, visitClassProperty];

for (const file of files) {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const rel = relative(ROOT, file);

  const visit = (node) => {
    for (const form of FORMS) form(node, sf, rel);
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

const canonical = new Set();
{
  const errorsFile = join(ROOT, "packages/sdk/src/errors.ts");
  if (existsSync(errorsFile)) {
    const sf = ts.createSourceFile(
      errorsFile,
      readFileSync(errorsFile, "utf8"),
      ts.ScriptTarget.ES2022,
      true,
    );
    const visit = (node) => {
      if (
        ts.isTypeAliasDeclaration(node) &&
        node.name.text === "ErrorCode" &&
        ts.isUnionTypeNode(node.type)
      ) {
        for (const member of node.type.types) {
          if (ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)) {
            canonical.add(member.literal.text);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
}

// Every canonical code belongs in the table whether or not a literal raise site was found: the
// union IS the contract a caller branches on.
for (const code of canonical) {
  if (!codes.has(code)) {
    codes.set(code, {
      classes: new Set(),
      sites: [{ file: "packages/sdk/src/errors.ts", line: 0 }],
    });
  }
}

const rows = [...codes].sort(([a], [b]) => a.localeCompare(b));

const lines = [];
lines.push("# Error codes");
lines.push("");
lines.push(
  "Every `code` this SDK puts on a thrown or reported error, the class that carries it, and where " +
    "it is raised. **Generated from the source AST** by `tools/generate-error-codes.mjs` — do not " +
    "edit by hand.",
);
lines.push("");
lines.push(
  "Branch on `code`, never on the message: messages carry context (an id, a path, a limit) and " +
    'change with it, while a code is the contract. `err.code === "context_too_long"` keeps working ' +
    "when the message gains a token count.",
);
lines.push("");
lines.push(
  "**Transport codes vs the rest.** `ErrorCode` in `errors.ts` is the small canonical union a " +
    "provider failure maps onto — the codes marked *transport* below. Everything else is raised by a " +
    "specific subsystem at a specific place, and a `catch` that only handles the union will meet " +
    "them anyway.",
);
lines.push("");
lines.push(`${rows.length} distinct code(s).`);
lines.push("");
lines.push("| Code | Kind | Raised by | Sites |");
lines.push("|---|---|---|---|");
for (const [code, info] of rows) {
  const kind = canonical.has(code) ? "transport" : "domain";
  const classes = [...info.classes].sort().join(", ") || "—";
  const first = info.sites[0];
  const where =
    info.sites.length === 1
      ? `\`${first.file}:${first.line}\``
      : `\`${first.file}:${first.line}\` +${info.sites.length - 1}`;
  lines.push(`| \`${code}\` | ${kind} | ${classes} | ${where} |`);
}
lines.push("");

const rendered = `${lines.join("\n")}\n`;

if (CHECK) {
  if (!existsSync(OUT)) {
    console.error(`[error-codes] ${OUT} is missing — run \`pnpm run docs:error-codes\`.`);
    process.exit(1);
  }
  if (readFileSync(OUT, "utf8") !== rendered) {
    console.error(
      "[error-codes] the committed reference has drifted from the source — run " +
        "`pnpm run docs:error-codes` and commit the result.",
    );
    process.exit(1);
  }
  console.log(`[error-codes] up to date — ${rows.length} code(s).`);
  process.exit(0);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, rendered);
console.log(`[error-codes] wrote ${relative(ROOT, OUT)} — ${rows.length} code(s).`);
