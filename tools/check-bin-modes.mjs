#!/usr/bin/env node
// B-445: Stryker runs inPlace (packages/sdk is not relocatable) and restores file content but not
// file mode, which strips the executable bit from bin entry points. `pnpm run mutation` brackets the
// run with `snapshot` and `verify`; verify exits 1 when any packages/*/bin/*.mjs mode differs.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_SNAPSHOT = "reports/mutation/bin-modes.json";

export function collectModes(root) {
  const modes = {};
  const pkgs = join(root, "packages");
  for (const pkg of readdirSync(pkgs).sort()) {
    const bin = join(pkgs, pkg, "bin");
    if (!existsSync(bin)) continue;
    for (const f of readdirSync(bin).sort()) {
      if (f.endsWith(".mjs"))
        modes[`packages/${pkg}/bin/${f}`] = statSync(join(bin, f)).mode & 0o7777;
    }
  }
  return modes;
}

export function diffModes(before, after) {
  const out = [];
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[k] !== after[k]) out.push({ file: k, before: before[k], after: after[k] });
  }
  return out;
}

const oct = (m) => (m === undefined ? "missing" : m.toString(8));

export function main(argv, root = process.cwd()) {
  const [cmd, snap = join(root, DEFAULT_SNAPSHOT)] = argv;
  if (cmd === "snapshot") {
    mkdirSync(dirname(snap), { recursive: true });
    writeFileSync(snap, JSON.stringify(collectModes(root), null, 2));
    return 0;
  }
  if (cmd === "verify") {
    if (!existsSync(snap)) {
      console.error(`check-bin-modes: no snapshot at ${snap}; run \`snapshot\` first`);
      return 1;
    }
    const diffs = diffModes(JSON.parse(readFileSync(snap, "utf8")), collectModes(root));
    for (const d of diffs)
      console.error(`mode changed: ${d.file} ${oct(d.before)} -> ${oct(d.after)}`);
    return diffs.length ? 1 : 0;
  }
  console.error("usage: check-bin-modes.mjs snapshot|verify [snapshot-file]");
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
