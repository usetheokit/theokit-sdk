#!/usr/bin/env node

// `@public` means a consumer can import it. This checks that it is true.
//
// A `@public` symbol that no entry point exports is what this finds. The fix is normally one
// export line — but NOT always, and the exception costs a day if you meet it without warning:
//
//   `tsconfig.base.json` sets `stripInternal: true`, so every declaration whose docblock carries
//   `@internal` is REMOVED from the emitted .d.ts. Re-exporting one from a public barrel produces
//   TS2305 against a module that plainly declares it in the source. `admittedSpecs` is the live
//   example, and its own docblock already says it is "not re-exported from any public entry
//   point" — the tag is the decision, and the export map follows it rather than the other way.
//
// So a symbol this gate reports has exactly two honest resolutions: export it, or drop the
// `@public` marker. Marking it `@internal` to silence the gate deletes it from the .d.ts, which
// is a third thing that looks like the second and is not.
//
// A symbol marked `@public` in its docblock is a promise: somebody outside this package is meant to
// name it. Nothing verified the promise, and the export map is where it quietly breaks — a symbol
// can be declared, documented, compiled into a chunk, and still be reachable from no entry at all.
//
// Measured 2026-09-14 against the published 5.7.0: of 115 `@public` VALUES, six resolve from no
// subpath in the export map — verified by importing them at runtime from ten of them, against a
// positive control (`Agent`, `Tool`, `Task` all resolve) and a negative one (an invented name does
// not). Two of the six are typed errors, which means a consumer cannot `catch` them by type; one is
// a `define*` extension point, which means the extension cannot be written.
//
// THE ORACLE IS THE COMPILER, for the reason `check-doc-api-drift.mjs` records after paying for it:
// a first version there hand-parsed export clauses and called `RetryOptions` missing while
// `retry.d.ts` plainly exported it. My own first pass at this check had the same disease in both
// directions — it reported 31 unreachable symbols, of which 19 were reachable under another form,
// and it MISSED nothing only by luck. Matching names against `.d.ts` text is precisely what fails.
//
// So: one probe per export-map entry, `import type { … }` for every declared name, and `tsc` says
// which names that entry cannot resolve. A name no entry resolves is unreachable.
//
// `import type` and not a value import, deliberately: it resolves a class, a function and an
// interface alike, so one probe covers both halves of the surface. The cost is that it cannot tell
// a type-only export from a value one — a separate question, and not the one this gate asks.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PKG_DIR = join(ROOT, "packages/sdk");
const pkg = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8"));

/**
 * Every `.ts` under `dir` that is not a declaration file.
 *
 * Lifted out of the scan because Biome measured the combined function at cognitive complexity 16
 * against a limit of 10, and it was right: walking a directory and matching a docblock are different
 * questions, and reading them interleaved is what made the original hard to follow.
 */
function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** Every `@public`-marked export in the source, with the file that declares it. */
function declaredPublic() {
  const found = new Map();
  // `@public` must be a JSDoc TAG — at the start of a docblock line — and not the token appearing
  // anywhere in prose. Writing "carries no @public tag" in a comment made the scanner see a marker
  // that the sentence was denying, which is how a symbol I had just DE-marked stayed on the list.
  const pattern =
    /\/\*\*(?:(?!\*\/)[\s\S])*?^\s*\*\s*@public\b(?:(?!\*\/)[\s\S])*?\*\/\s*export\s+(?:declare\s+)?(?:async\s+)?(?:function|class|const|enum|type|interface)\s+([A-Za-z_$][\w$]*)/gm;

  for (const file of sourceFiles(join(PKG_DIR, "src"))) {
    for (const match of readFileSync(file, "utf8").matchAll(pattern)) {
      if (!found.has(match[1])) found.set(match[1], relative(PKG_DIR, file));
    }
  }
  return found;
}

/** The subpaths a consumer may import from. */
function entries() {
  const out = [];
  for (const [sub, spec] of Object.entries(pkg.exports ?? {})) {
    if (sub.endsWith(".json")) continue;
    const types = typeof spec === "object" ? (spec.import?.types ?? spec.types) : undefined;
    // The absolute path to the entry's own .d.ts, NOT the bare specifier.
    //
    // The first version imported from `@theokit/sdk` and reported PASS on all 408 symbols. It was
    // measuring nothing: the probe ran outside any node_modules that contains the package, so tsc
    // answered TS2307 ("cannot find module") — and the scan only looked for TS2305 ("no exported
    // member"). A gate that is green because the compiler never reached the question is worse than
    // no gate, and a negative control is what caught it: an invented name passed too.
    if (types) out.push({ sub, file: join(PKG_DIR, types) });
  }
  return out;
}

/**
 * The names this entry resolves.
 *
 * Its own function for the same reason `sourceFiles` is: `main` measured 16 against a limit of 10,
 * and running one probe is a different question from deciding what the whole surface is missing.
 *
 * A resolution failure means the probe asked nothing, and that must never read as a clean run — the
 * first version of this checker counted zero complaints as 408 successes for exactly that reason.
 */
function resolvedBy(work, sub, file, names) {
  const probe = join(work, `probe-${sub.replace(/[^a-z0-9]/gi, "-")}.ts`);
  writeFileSync(
    probe,
    `import type { ${names.join(", ")} } from '${file.replace(/\.d\.ts$/, "")}'\n`,
  );

  let output = "";
  try {
    execFileSync(
      "npx",
      [
        "tsc",
        "--noEmit",
        "--skipLibCheck",
        "--moduleResolution",
        "bundler",
        "--module",
        "esnext",
        "--target",
        "es2022",
        probe,
      ],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }

  if (/TS2307/.test(output)) {
    console.error(
      `[public-surface] probe for '${sub}' could not resolve its own entry:\n${output.trim().slice(0, 300)}`,
    );
    process.exit(1);
  }

  const complained = new Set(
    [
      ...output.matchAll(/has no exported member named? '([^']+)'|no exported member '([^']+)'/g),
    ].map((m) => m[1] ?? m[2]),
  );
  return names.filter((n) => !complained.has(n));
}

function main() {
  const declared = declaredPublic();
  const names = [...declared.keys()].sort();
  if (names.length === 0) {
    console.error(
      "[public-surface] found no @public markers — the scan is broken, not the surface",
    );
    process.exit(1);
  }

  const work = mkdtempSync(join(tmpdir(), "public-surface-"));
  const unresolvedEverywhere = new Set(names);

  try {
    for (const { sub, file } of entries()) {
      for (const n of resolvedBy(work, sub, file, names)) unresolvedEverywhere.delete(n);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  const missing = [...unresolvedEverywhere].sort();
  if (missing.length === 0) {
    console.log(
      `[public-surface] PASS — all ${names.length} @public symbols resolve from the export map.`,
    );
    return;
  }

  console.error(
    `[public-surface] ${missing.length} symbol(s) marked @public that NO entry resolves:\n`,
  );
  for (const n of missing) console.error(`    ${n.padEnd(34)} ${declared.get(n)}`);
  console.error(
    "\n  `@public` is a promise that somebody outside can name it. Either export it from the entry it\n" +
      "  belongs to, or drop the marker — a documented symbol nobody can import is worse than an\n" +
      "  undocumented one, because the docblock says it is ready.",
  );
  process.exit(1);
}

main();
