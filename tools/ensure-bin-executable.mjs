#!/usr/bin/env node
/**
 * Restores the owner execute bit on every file a package's `bin` field names.
 *
 * A bin that is a committed source file (not build output), like `packages/acp/bin/theokit-acp.mjs`,
 * must stay mode 100755 in git; a step that rewrites it can leave 100644 and a release would then
 * ship a non-executable bin. Run after the build: `node ../../tools/ensure-bin-executable.mjs .`
 */
import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const pkgDir = resolve(process.argv[2] ?? ".");
const { bin } = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const rels = typeof bin === "string" ? [bin] : Object.values(bin ?? {});
for (const rel of rels) {
  const file = join(pkgDir, rel);
  if (!existsSync(file)) continue;
  const mode = statSync(file).mode;
  if ((mode & 0o100) === 0) chmodSync(file, mode | 0o755);
}
