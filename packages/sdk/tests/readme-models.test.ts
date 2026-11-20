import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import catalog from "../src/internal/providers/provider-catalog.json" with { type: "json" };

type Entry = { id: string; models?: Record<string, unknown> };

const known = new Set<string>();
for (const p of catalog as Entry[]) {
  for (const m of Object.keys(p.models ?? {})) known.add(`${p.id}/${m}`);
}

/** Model ids used in README code blocks: `model: "x"`, `model: { id: "x" }`, `models: ["x", ...]`. */
export function readmeModelIds(markdown: string): string[] {
  const ids: string[] = [];
  const blocks = markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/g);
  for (const [, code = ""] of blocks) {
    const body = code.replace(/^\s*\/\/.*$/gm, "");
    for (const m of body.matchAll(/\bmodel:\s*(?:\{\s*id:\s*)?"([^"]+)"/g))
      ids.push(m[1] as string);
    for (const m of body.matchAll(/\bmodels:\s*\[([^\]]*)\]/g)) {
      for (const s of (m[1] as string).matchAll(/"([^"]+)"/g)) ids.push(s[1] as string);
    }
  }
  return ids;
}

describe("README model ids", () => {
  const ids = readmeModelIds(readFileSync(new URL("../README.md", import.meta.url), "utf8"));

  it("finds the examples' model ids", () => {
    expect(ids.length).toBeGreaterThan(3);
  });

  it("extracts object, string and list forms", () => {
    const md =
      '```ts\nmodel: { id: "a/b" }\nmodel: "c/d"\nmodels: ["e/f", "g/h"]\n// model: "x/y"\n```';
    expect(readmeModelIds(md)).toEqual(["a/b", "c/d", "e/f", "g/h"]);
  });

  it("every id resolves through the shipped catalog", () => {
    expect(ids.filter((id) => !known.has(id))).toEqual([]);
  });
});
