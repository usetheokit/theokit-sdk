import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  breakingChanges,
  buildSurface,
  declaresMajor,
  differingNames,
  evaluateChange,
  main,
  onlyAddsOptionalProperties,
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

describe("evaluateChange", () => {
  const before = surfaceOf(BASE);
  const after = surfaceOf("export interface Opts { a: string }\n");
  const major = '---\n"@theokit/sdk": major\n---\n\nx';
  it("test_removal_without_major_fails", () => {
    expect(evaluateChange({ before, current: after, changesets: [], today: "2026-11-20" })).toHaveLength(1);
  });
  it("test_removal_with_major_passes", () => {
    expect(evaluateChange({ before, current: after, changesets: [major], today: "2026-11-20" })).toEqual([]);
  });
  it("test_added_optional_property_passes_and_required_fails_without_major", () => {
    const opt = surfaceOf(BASE.replace("a: string", "a: string; b?: number"));
    const req = surfaceOf(BASE.replace("a: string", "a: string; b: number"));
    expect(evaluateChange({ before, current: opt, changesets: [], today: "2026-11-20" })).toEqual([]);
    expect(evaluateChange({ before, current: req, changesets: [], today: "2026-11-20" })).toHaveLength(1);
  });
  it("test_major_does_not_excuse_removal_inside_the_window", () => {
    const dep = surfaceOf("/** @deprecated */\nexport declare const old: number;\n", undefined, "2026-10-21");
    const out = evaluateChange({ before: dep, current: surfaceOf(""), changesets: [major], today: "2026-11-20" });
    expect(out).toHaveLength(1);
    const old = surfaceOf("/** @deprecated */\nexport declare const old: number;\n", undefined, "2026-07-23");
    expect(evaluateChange({ before: old, current: surfaceOf(""), changesets: [major], today: "2026-11-20" })).toEqual([]);
  });
});

describe("main, end to end in a git repository", () => {
  const sh = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" });

  function repo(dts: string, today = "2026-11-20") {
    const root = mkdtempSync(join(tmpdir(), "api-surface-repo-"));
    sh(root, "init", "-q");
    mkdirSync(join(root, "tools/api-surface"), { recursive: true });
    mkdirSync(join(root, ".changeset"));
    const typesAbs = join(root, "index.d.ts");
    const write = (text: string, day: string) => {
      writeFileSync(typesAbs, text);
      main(["--write"], opts(day));
    };
    const opts = (day: string, env: Record<string, string> = { API_SURFACE_BASE: "workspace" }) => ({
      root,
      today: day,
      env,
      log: () => {},
      baselinePath: join(root, "tools/api-surface/sdk.json"),
      entries: () => [{ subpath: ".", condition: "import", typesAbs }],
    });
    write(dts, today);
    return { root, write, opts, commit: (m: string) => (sh(root, "add", "-A"), sh(root, "commit", "-q", "-m", m)) };
  }

  it("test_removal_without_major_exits_nonzero_and_with_major_exits_zero", () => {
    const r = repo(BASE);
    r.commit("base");
    sh(r.root, "update-ref", "refs/remotes/origin/workspace", "HEAD");
    r.write("export interface Opts { a: string }\n", "2026-11-20");
    r.commit("remove");
    expect(main([], r.opts("2026-11-20"))).toBe(1);
    writeFileSync(join(r.root, ".changeset/m.md"), '---\n"@theokit/sdk": major\n---\n\nx');
    r.commit("major");
    expect(main([], r.opts("2026-11-20"))).toBe(0);
  });

  it("test_removal_inside_the_window_fails_even_with_major", () => {
    const r = repo("/** @deprecated */\nexport declare const old: number;\n", "2026-10-21");
    r.commit("base");
    sh(r.root, "update-ref", "refs/remotes/origin/workspace", "HEAD");
    r.write("", "2026-11-20");
    writeFileSync(join(r.root, ".changeset/m.md"), '---\n"@theokit/sdk": major\n---\n\nx');
    r.commit("remove");
    expect(main([], r.opts("2026-11-20"))).toBe(1);
  });

  it("test_an_unresolvable_base_fails_closed", () => {
    const r = repo(BASE);
    r.commit("base");
    expect(main([], r.opts("2026-11-20"))).toBe(1);
  });

  it("test_a_base_without_a_baseline_is_the_bootstrap_and_passes", () => {
    const r = repo(BASE);
    sh(r.root, "commit", "-q", "--allow-empty", "-m", "empty");
    sh(r.root, "update-ref", "refs/remotes/origin/workspace", "HEAD");
    r.commit("baseline");
    expect(main([], r.opts("2026-11-20"))).toBe(0);
  });

  it("test_a_drifted_baseline_exits_nonzero", () => {
    const r = repo(BASE);
    r.commit("base");
    sh(r.root, "update-ref", "refs/remotes/origin/workspace", "HEAD");
    writeFileSync(join(r.root, "index.d.ts"), `${BASE}export declare const extra: number;\n`);
    expect(main([], r.opts("2026-11-20"))).toBe(1);
  });

  it("test_a_missing_baseline_fails_check_and_is_created_by_write", () => {
    const r = repo(BASE);
    const o = r.opts("2026-11-20");
    rmSync(o.baselinePath);
    expect(main([], o)).toBe(1);
    expect(main(["--write"], o)).toBe(0);
    expect(existsSync(o.baselinePath)).toBe(true);
  });

  it("test_an_unreadable_or_invalid_baseline_propagates", () => {
    const r = repo(BASE);
    const o = r.opts("2026-11-20");
    writeFileSync(o.baselinePath, "{not json");
    expect(() => main([], o)).toThrow();
    rmSync(o.baselinePath);
    mkdirSync(o.baselinePath);
    expect(() => main([], o)).toThrow();
  });

  it("test_an_optional_property_nested_in_a_parameter_is_additive", () => {
    const prev = "export declare function f(o: {\n    a: string;\n}): void;";
    const added = "export declare function f(o: {\n    a: string;\n    b?: number;\n}): void;";
    const required = "export declare function f(o: {\n    a: string;\n    b: number;\n}): void;";
    expect(onlyAddsOptionalProperties(prev, added)).toBe(true);
    expect(onlyAddsOptionalProperties(prev, required)).toBe(false);
    expect(onlyAddsOptionalProperties(added, prev)).toBe(false);
  });
});
