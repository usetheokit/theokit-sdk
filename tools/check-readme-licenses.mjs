#!/usr/bin/env node
// #1105: a package README that names a license different from its package.json `license` field
// misleads npm readers. Checks the first non-empty line under each `## License` heading; READMEs
// without such a section are skipped.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SPDX = /\b(Apache-2\.0|MIT|ISC|BSD-[23]-Clause|MPL-2\.0|A?GPL-[\d.]+(?:-only|-or-later)?)\b/;

export function readmeLicense(readme) {
  const lines = readme.split("\n");
  const at = lines.findIndex((l) => /^##\s+License\s*$/i.test(l));
  if (at < 0) return undefined;
  const first = lines.slice(at + 1).find((l) => l.trim() !== "");
  return first?.match(SPDX)?.[1];
}

export function findMismatches(root) {
  const out = [];
  const pkgs = join(root, "packages");
  for (const pkg of readdirSync(pkgs).sort()) {
    const manifest = join(pkgs, pkg, "package.json");
    const readme = join(pkgs, pkg, "README.md");
    if (!existsSync(manifest) || !existsSync(readme)) continue;
    const license = JSON.parse(readFileSync(manifest, "utf8")).license;
    const stated = readmeLicense(readFileSync(readme, "utf8"));
    if (stated && license && stated !== license)
      out.push({ file: `packages/${pkg}/README.md`, readme: stated, manifest: license });
  }
  return out;
}

export function main(root = process.cwd()) {
  const bad = findMismatches(root);
  for (const m of bad)
    console.error(`${m.file}: says ${m.readme}, package.json license is ${m.manifest}`);
  return bad.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(main());
