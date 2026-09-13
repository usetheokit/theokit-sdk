import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import type { CompatSourceDeclaration } from "../src/internal/runtime/compat/foreign-config-sources.js";
import {
  admittedSpecs,
  DEFAULT_DISCOVERY_SPECS,
} from "../src/internal/runtime/context/context-discovery.js";
import { FileContextManager } from "../src/internal/runtime/context/context-manager.js";
import { removeTempDirRobustSync } from "./helpers/temp-workspace.js";

/**
 * A foreign root's instructions entered the prompt through a door the trust separation never covered.
 *
 * `FileContextManager.initialize()` gated project-level context on
 * `settingSourcesIncludeProject || settings.manager === "file"` and consulted no foreign-dialect
 * grant. Measured at HEAD 2026-09-12: `compatSources` appeared nowhere under
 * `src/internal/runtime/context/`, while `DEFAULT_DISCOVERY_SPECS` carried `.claude/rules/*.md`.
 *
 * So a consumer who granted `project` for its OWN `.theokit/` and deliberately never declared
 * `claude-code` still received that repository's `.claude/rules/*.md` in its system prompt — while
 * the same directory's hooks, skills, subagents and plugins were correctly withheld. Four surfaces
 * failing closed and a fifth nobody had wired to the gate (usetheokit/theokit-sdk#652).
 *
 * ## Why a surface and not a condition
 *
 * `CompatSurface` was `"hooks" | "plugins" | "skills" | "subagents"`. There was no member for
 * instructions, so no grant could govern them and the gate had nothing to consult — the root cause,
 * and the reason an `if` at the call site would have been the wrong shape. Adding the member makes
 * the question askable, and `assertCompatSurfacesExhaustive` forces the runtime list to pair with it.
 *
 * ## What this deliberately does NOT gate, and why the scope is the honest one
 *
 * `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` and `.cursor/rules/*.mdc` stay ungated. `adaptersFor`
 * registers ONE foreign adapter, so `compatSources` has no spelling that admits `agents`, `gemini`
 * or `cursor`: labelling them would gate them on a grant nobody can write and make three formats
 * permanently unreachable. The grant gates the foreign ROOT, and the repo-root files do not live
 * there. That is stated in `DiscoverySpec.dialect`'s docblock rather than left to be inferred.
 */
describe("only what a grant can actually govern carries a dialect", () => {
  const byId = new Map(DEFAULT_DISCOVERY_SPECS.map((s) => [s.id, s]));

  it("labels the spec that reads Claude Code's own root", () => {
    expect(byId.get("claude-rules")?.pattern).toContain(".claude/");
    expect(byId.get("claude-rules")?.dialect).toBe("claude-code");
  });

  it("leaves every other spec unlabelled, including the repo-root instruction files", () => {
    // Asserted per id rather than in aggregate: a count would still pass if the wrong spec were the
    // labelled one, and "which file requires a grant" is exactly the fact under test.
    for (const id of ["CLAUDE.md", "AGENTS.md", "GEMINI.md", "cursor-rules"]) {
      expect(
        byId.get(id)?.dialect,
        `${id} is gated on a grant; three of these four have no spelling in compatSources, and CLAUDE.md is used by projects with no .claude/ at all`,
      ).toBeUndefined();
    }
    expect(byId.get("theokit-rules")?.dialect, "the native root needs no grant").toBeUndefined();
  });
});

/**
 * The label is only half of it: something must READ it.
 *
 * A `dialect` field nobody consults is the defect this backlog keeps closing — a control declared,
 * exported, documented and wired to nothing. `admittedSpecs` turns the label into a gate.
 */
describe("the label is consulted, not merely carried", () => {
  const has = (specs: ReadonlyArray<{ id: string }>, id: string) => specs.some((s) => s.id === id);

  it("withholds the foreign root's rules from a consumer that granted no dialect", () => {
    const admitted = admittedSpecs(DEFAULT_DISCOVERY_SPECS, []);

    expect(has(admitted, "claude-rules"), "the claude-code grant was never given").toBe(false);
    expect(has(admitted, "theokit-rules"), "native content must survive").toBe(true);
    expect(
      has(admitted, "AGENTS.md"),
      "no grant can express this one, so gating it would strand it",
    ).toBe(true);
  });

  it("admits them once the dialect is granted", () => {
    expect(has(admittedSpecs(DEFAULT_DISCOVERY_SPECS, ["claude-code"]), "claude-rules")).toBe(true);
  });

  it("admits everything when nothing was declared to it at all", () => {
    // The back-compatibility floor. `undefined` is every caller before this field existed; an empty
    // array is a consumer who declared nothing. Collapsing the two would restore the defect.
    expect(admittedSpecs(DEFAULT_DISCOVERY_SPECS, undefined)).toHaveLength(
      DEFAULT_DISCOVERY_SPECS.length,
    );
  });

  it("keeps a caller's own unlabelled spec, whatever the grant", () => {
    const mine = {
      id: "mine",
      pattern: "MINE.md",
      scope: "cwd-only",
      parser: "plain-markdown",
      followImports: false,
      priority: 99,
    } as const;

    expect(has(admittedSpecs([...DEFAULT_DISCOVERY_SPECS, mine], []), "mine")).toBe(true);
  });
});

/**
 * End to end, through the class the item names.
 *
 * The two suites above prove the filter is correct in isolation, and neither of them would notice if
 * `FileContextManager` never called it — which is precisely the state HEAD was in. This one builds a
 * real project on disk and reads what reaches `snapshot()`.
 */
describe("a real project's .claude/rules reaches the prompt only with the grant", () => {
  function projectWithBothRoots(): string {
    const cwd = mkdtempSync(join(tmpdir(), "theokit-context-grant-"));
    // `tests/lint/temp-dirs-are-cleaned-up.test.ts` enforces this, and it caught the first version
    // of this file: four `bodiesFor` calls per run, each leaking a directory. The helper's retry
    // policy is the shared one rather than a bare `rmSync` — which is the reason to reuse it.
    onTestFinished(() => removeTempDirRobustSync(cwd));
    for (const [dir, file, body] of [
      [".claude/rules", "house-style.md", "FOREIGN RULE BODY"],
      [".theokit/rules", "ours.md", "NATIVE RULE BODY"],
    ] as const) {
      mkdirSync(join(cwd, ...dir.split("/")), { recursive: true });
      writeFileSync(join(cwd, ...dir.split("/"), file), `---\nalwaysApply: true\n---\n\n${body}\n`);
    }
    return cwd;
  }

  async function bodiesFor(compatSources: readonly CompatSourceDeclaration[] | undefined) {
    const cwd = projectWithBothRoots();
    const manager = new FileContextManager(cwd, {}, true, compatSources);
    await manager.initialize();
    const snap = await manager.snapshot();
    // `usedTokens` is `number | string[]` on the public type — a count for remote runtimes, the
    // slices for local ones. Asserting on the BODIES is the point: a count would go up and down
    // without ever saying whose text moved.
    const used = snap.budget?.usedTokens;
    return Array.isArray(used) ? used.join("\n") : "";
  }

  it("withholds it from a consumer that declared no foreign dialect", async () => {
    const text = await bodiesFor([]);

    expect(text, "the native root must still load — this gate is not about .theokit/").toContain(
      "NATIVE RULE BODY",
    );
    expect(
      text,
      "a cloned repository's .claude/rules reached the system prompt with no grant (#652)",
    ).not.toContain("FOREIGN RULE BODY");
  });

  it("delivers it once claude-code is declared", async () => {
    // The control that keeps the test above from passing for the wrong reason: without this, an
    // exception during discovery, a broken fixture or a parser that rejects the frontmatter would
    // all read as "correctly withheld".
    expect(await bodiesFor(["claude-code"])).toContain("FOREIGN RULE BODY");
  });

  it("honours a narrowed import list per surface, not per dialect", async () => {
    // #524's object form. Declaring claude-code FOR SKILLS is not a grant over instructions, and
    // reading `.kind` off the declaration instead of routing through `adaptersForSurface` would
    // treat it as one.
    expect(await bodiesFor([{ kind: "claude-code", import: ["skills"] }])).not.toContain(
      "FOREIGN RULE BODY",
    );
    expect(await bodiesFor([{ kind: "claude-code", import: ["context"] }])).toContain(
      "FOREIGN RULE BODY",
    );
  });

  it("loads everything when the caller threaded no declaration through", async () => {
    // An internal caller constructing this directly must not silently lose content.
    expect(await bodiesFor(undefined)).toContain("FOREIGN RULE BODY");
  });
});
