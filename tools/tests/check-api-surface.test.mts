import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  breakingChanges,
  buildSurface,
  declaresMajor,
  differingNames,
  windowViolations,
} from "../check-api-surface.mjs";

function surfaceOf(dts: string, previous?: unknown, today = "2026-11-20") {
  const dir = mkdtempSync(join(tmpdir(), "api-surface-"));
  const typesAbs = join(dir, "index.d.ts");
  writeFileSync(typesAbs, dts);
  return buildSurface([{ subpath: ".", condition: "import", typesAbs }], { previous, today });
}

const BASE = "export interface Opts { a: string }\nexport declare function run(): void;\n";

describe("surface", () => {
  it("test_records_tier_and_declaration_per_name", () => {
    const s = surfaceOf(`${BASE}/** @experimental */\nexport declare const e: number;\n`);
    expect(s.entries[".#import"].run.tier).toBe("stable");
    expect(s.entries[".#import"].e.tier).toBe("experimental");
    expect(s.entries[".#import"].Opts.declaration).toContain("a: string");
  });

  it("test_internal_entries_are_not_recorded", () => {
    const dir = mkdtempSync(join(tmpdir(), "api-surface-"));
    const typesAbs = join(dir, "i.d.ts");
    writeFileSync(typesAbs, BASE);
    const s = buildSurface([{ subpath: "./internal/x", condition: "import", typesAbs }]);
    expect(s.entries).toEqual({});
  });

  it("test_deprecated_since_is_first_seen_date_and_is_carried", () => {
    const dts = "/** @deprecated use b */\nexport declare const a: number;\n";
    const first = surfaceOf(dts, undefined, "2026-01-01");
    expect(first.entries[".#import"].a.deprecatedSince).toBe("2026-01-01");
    const later = surfaceOf(dts, first, "2026-11-20");
    expect(later.entries[".#import"].a.deprecatedSince).toBe("2026-01-01");
  });

  it("test_differing_names_lists_changed_names", () => {
    expect(differingNames(surfaceOf(BASE), surfaceOf("export declare function run(): void;\n"))).toEqual([
      ".#import Opts",
    ]);
  });
});

describe("breakingChanges", () => {
  const base = surfaceOf(BASE);
  it("test_removal_is_breaking", () => {
    const out = breakingChanges(base, surfaceOf("export interface Opts { a: string }\n"));
    expect(out.map((b) => [b.name, b.reason])).toEqual([["run", "removed"]]);
  });
  it("test_rename_is_breaking", () => {
    const out = breakingChanges(base, surfaceOf(BASE.replace("run", "go")));
    expect(out.map((b) => b.name)).toEqual(["run"]);
  });
  it("test_demotion_to_experimental_is_breaking", () => {
    const out = breakingChanges(base, surfaceOf(BASE.replace("export declare function", "/** @experimental */\nexport declare function")));
    expect(out.map((b) => b.reason)).toEqual(["demoted to experimental"]);
  });
  it("test_added_optional_property_is_not_breaking", () => {
    expect(breakingChanges(base, surfaceOf(BASE.replace("a: string", "a: string; b?: number")))).toEqual([]);
  });
  it("test_added_required_property_is_breaking", () => {
    const out = breakingChanges(base, surfaceOf(BASE.replace("a: string", "a: string; b: number")));
    expect(out.map((b) => [b.name, b.reason])).toEqual([["Opts", "declaration changed"]]);
  });
  it("test_unchanged_surface_is_not_breaking", () => {
    expect(breakingChanges(base, surfaceOf(BASE))).toEqual([]);
  });
});

describe("changesets and the deprecation window", () => {
  it("test_major_for_the_sdk_is_recognised_and_minor_is_not", () => {
    expect(declaresMajor('---\n"@theokit/sdk": major\n---\n\nx')).toBe(true);
    expect(declaresMajor('---\n"@theokit/sdk": minor\n---\n\nx')).toBe(false);
    expect(declaresMajor('---\n"@theokit/other": major\n---\n\nx')).toBe(false);
  });

  const dep = "/** @deprecated */\nexport declare const old: number;\n";
  it("test_removal_30_days_after_deprecation_fails", () => {
    const base = surfaceOf(dep, undefined, "2026-10-21");
    const gone = breakingChanges(base, surfaceOf(""));
    expect(windowViolations(gone, "2026-11-20")).toHaveLength(1);
  });
  it("test_removal_120_days_after_deprecation_passes", () => {
    const base = surfaceOf(dep, undefined, "2026-07-23");
    const gone = breakingChanges(base, surfaceOf(""));
    expect(windowViolations(gone, "2026-11-20")).toEqual([]);
  });
});
