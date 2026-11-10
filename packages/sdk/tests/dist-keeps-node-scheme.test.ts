import { existsSync, readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dist = join(__dirname, "..", "dist");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : /\.(js|cjs)$/.test(e.name) ? [join(dir, e.name)] : [],
  );
}

// #960: a bare `readline/promises` is not resolved as a builtin by esbuild bundles.
describe.skipIf(!existsSync(dist))("dist keeps the node: scheme on builtin subpaths", () => {
  it("has no bare import of a builtin subpath", () => {
    const subpaths = builtinModules.filter((m) => m.includes("/") && !m.startsWith("_"));
    const re = /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s*)["']([^"']+)["']/g;
    const bad: string[] = [];
    for (const f of files(dist)) {
      for (const m of readFileSync(f, "utf8").matchAll(re)) {
        if (subpaths.includes(m[1] as string)) bad.push(`${f}: ${m[1]}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
