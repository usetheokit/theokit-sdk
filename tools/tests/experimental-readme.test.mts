import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

type Surface = { entries: Record<string, Record<string, { tier: string }>> };

/** `{ "./a2a": [names] }` from the README's "Experimental exports" section. */
function readmeSection(): Record<string, string[]> {
  const md = readFileSync(join(ROOT, "packages/sdk/README.md"), "utf8");
  const start = md.indexOf("\n## Experimental exports");
  expect(start, "README has an 'Experimental exports' section").toBeGreaterThan(-1);
  const rest = md.slice(start + 1);
  const end = rest.slice(3).search(/\n## /);
  const body = end === -1 ? rest : rest.slice(0, end + 3);
  const out: Record<string, string[]> = {};
  let current: string | undefined;
  for (const line of body.split("\n")) {
    const h = /^### `@theokit\/sdk(\/[^`]*)?`/.exec(line);
    if (h) {
      current = h[1] ? `.${h[1]}` : ".";
      out[current] = [];
      continue;
    }
    const item = /^- `([^`]+)`/.exec(line);
    if (item?.[1] && current) out[current]?.push(item[1]);
  }
  return out;
}

function baselineExperimental(): Map<string, string[]> {
  const surface = JSON.parse(
    readFileSync(join(ROOT, "tools/api-surface/sdk.json"), "utf8"),
  ) as Surface;
  const out = new Map<string, string[]>();
  for (const [key, names] of Object.entries(surface.entries)) {
    const exp = Object.entries(names)
      .filter(([, v]) => v.tier === "experimental")
      .map(([n]) => n)
      .sort();
    if (exp.length) out.set(key, exp);
  }
  return out;
}

describe("README experimental list vs surface baseline", () => {
  it("test_readme_lists_exactly_the_baseline_experimental_names_per_entry_and_condition", () => {
    const readme = readmeSection();
    const base = baselineExperimental();
    const problems: string[] = [];
    for (const [key, names] of base) {
      const [subpath, condition] = key.split("#") as [string, string];
      const listed = new Set(readme[subpath] ?? []);
      for (const n of names) if (!listed.has(n)) problems.push(`${key}: ${n} missing from README`);
      void condition;
    }
    for (const [subpath, listed] of Object.entries(readme)) {
      for (const condition of ["import", "require"]) {
        const names = new Set(base.get(`${subpath}#${condition}`) ?? []);
        for (const n of listed)
          if (!names.has(n)) problems.push(`${subpath}#${condition}: ${n} not experimental in baseline`);
      }
    }
    expect(problems).toEqual([]);
  });
});
