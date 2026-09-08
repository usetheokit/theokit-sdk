import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { projectConfigRoots } from "../src/internal/persistence/paths.js";

/*
 * Where a project's configuration is read from.
 *
 * `.theokit` is this SDK's own namespace and stays first: a project that declares both means the
 * explicit one to win. `.claude` is read too — a repository already set up for the Claude Code CLI
 * works here without being converted, since its skills, agents, hooks and rules are the same
 * formats — but only once the project ASKS for it (#524).
 *
 * The default flipped because trust is not consent. A consumer's trust gate answers "do I trust the
 * code in this directory?"; it was doing double duty as the answer to "do I want another product's
 * configuration imported into this one?" — and those come apart in the ordinary case, since
 * `.claude/` is populated in exactly the repository one trusts most, for a different tool, often by
 * a teammate who never heard of this SDK. The measured cost of conflating them was #522: every turn
 * denied by a hook nobody had declared.
 */
describe("projectConfigRoots", () => {
  const saved = process.env.THEOKIT_HOME;
  afterEach(() => {
    if (saved === undefined) delete process.env.THEOKIT_HOME;
    else process.env.THEOKIT_HOME = saved;
  });

  it("test_only_the_native_directory_is_searched_by_default", () => {
    expect(projectConfigRoots("/work", [], "hooks")).toEqual([join("/work", ".theokit")]);
  });

  it("test_a_declared_foreign_directory_is_searched_after_the_native_one", () => {
    expect(projectConfigRoots("/work", ["claude-code"], "hooks")).toEqual([
      join("/work", ".theokit"),
      join("/work", ".claude"),
    ]);
  });

  it("test_the_explicit_namespace_is_searched_first_so_it_wins_a_collision", () => {
    expect(projectConfigRoots("/work", [], "hooks")[0]).toBe(join("/work", ".theokit"));
  });

  // THEOKIT_HOME relocates cwd-anchored SDK STATE (sessions, credentials). A project's
  // CONFIGURATION belongs to the repository, and the loaders reading these directories have always
  // anchored on cwd directly — following the override here would move where a project's agents come
  // from, which is a behaviour change wearing the costume of a refactor.
  it("test_the_theokit_home_override_does_not_move_project_configuration", () => {
    process.env.THEOKIT_HOME = "/elsewhere";
    expect(projectConfigRoots("/work", ["claude-code"], "hooks")).toEqual([
      join("/work", ".theokit"),
      join("/work", ".claude"),
    ]);
  });
});

/**
 * #631 — the native root can decline a surface, in the vocabulary foreign roots already use.
 *
 * Until now `theokitConfigRoot(cwd)` was prepended unconditionally: a foreign dialect could declare
 * WHICH surfaces it contributes (`{ kind, import }`), and the SDK's own root could declare nothing.
 * It contributed every surface, always.
 *
 * That asymmetry had a measured cost. `hookConfigCandidates` reads `settings.json` from every root,
 * so a consumer keeping its own configuration in `.theokit/settings.json` had its `hooks` key
 * executed by THIS package — with no approval gate — and, when that consumer also ran them, twice.
 * Measured by `usetheoai-lab/TheoCode`: unapproved fired once, approved fired twice.
 *
 * The consumer could not opt out. `settingSources` grants a foreign dialect per SOURCE, not per
 * surface, so dropping `claude-code` to avoid its hooks would also drop its skills, agents and
 * rules — which are the reason an adopter can use this SDK without migrating anything.
 *
 * The declaration reuses `{ kind, import }` rather than inventing an option, and it rides on
 * `compatSources`, which already reaches all four surfaces. No new parameter is threaded anywhere.
 *
 * Deliberately NOT included: renaming the directory. `theokitConfigRoot` is also the DATA root —
 * `agent-registry-store.ts` builds `registry.json`'s path from it directly, without passing through
 * here — so a `dirName` override would move persisted state. Different change, different blast
 * radius, its own migration question.
 */
describe("projectConfigRoots — the native root's own declaration", () => {
  const SURFACES = ["hooks", "plugins", "skills", "subagents"] as const;
  const own = join("/work", ".theokit");

  it("test_absent_declaration_contributes_every_surface", () => {
    for (const surface of SURFACES) {
      expect(projectConfigRoots("/work", [], surface), surface).toEqual([own]);
    }
  });

  it("test_a_declared_surface_is_contributed", () => {
    const sources = [{ kind: "theokit", import: ["skills"] }];
    expect(projectConfigRoots("/work", sources, "skills")).toEqual([own]);
  });

  it("test_an_undeclared_surface_is_not", () => {
    const sources = [{ kind: "theokit", import: ["skills"] }];
    expect(projectConfigRoots("/work", sources, "hooks")).toEqual([]);
  });

  /**
   * The bare string admits everything, matching `adaptersForSurface`'s own rule for foreign kinds.
   * Two vocabularies that look the same and differ in the default would be worse than one.
   */
  it("test_a_bare_string_declaration_admits_every_surface", () => {
    for (const surface of SURFACES) {
      expect(projectConfigRoots("/work", ["theokit"], surface), surface).toEqual([own]);
    }
  });

  /**
   * CONTROL. Without it, "hooks returned []" cannot be told from "the whole function stopped
   * returning roots" — the native declaration must narrow ITSELF and leave foreign roots alone.
   */
  it("test_CONTROL_a_foreign_root_is_unaffected_by_the_native_declaration", () => {
    const sources = [
      { kind: "theokit", import: ["skills"] },
      { kind: "claude-code", import: ["hooks"] },
    ];
    expect(projectConfigRoots("/work", sources, "hooks")).toEqual([join("/work", ".claude")]);
  });
});
