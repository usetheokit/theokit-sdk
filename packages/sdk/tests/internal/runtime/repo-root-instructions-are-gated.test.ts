/**
 * B-081 — a repo-root instruction file requires a grant a consumer can actually write.
 *
 * `DEFAULT_DISCOVERY_SPECS` carries four repo-root instruction files — `AGENTS.md`, `GEMINI.md`,
 * `CLAUDE.md` and `.cursor/rules/*.mdc`. Each one puts text somebody else wrote into our system
 * prompt as if we had written it, and until this item exactly ONE spec in the whole file carried a
 * `dialect:` gate: `.claude/rules/*.md`, added by B-011.
 *
 * After B-011 the asymmetry is legible rather than theoretical — a cloned repository's
 * `.claude/rules/*.md` needs a declaration, and the `CLAUDE.md` one directory up does not, while
 * both carry the same risk.
 *
 * ## Why the vocabulary had to come first
 *
 * Measured 2026-09-14: `CompatSource = "claude-code" | "theokit" | CompatSourceAdapter`. There was
 * no spelling of `compatSources` admitting `agents`, `gemini` or `cursor`, so gating those three
 * would have made three instruction formats PERMANENTLY unreachable — worse than the gap, and what
 * FR-002 forbids. `every gated format has a spelling that restores it` is the test that makes
 * shipping that state impossible: it fails the moment a spec is gated on a token the union does not
 * carry.
 *
 * ## The reviewer's decisions this encodes
 *
 * All four are gated, `CLAUDE.md` included and not special-cased; and a withheld file is NAMED by
 * path rather than counted. Being told you lost something without being told what helps nobody, and
 * a count cannot be acted on — a consumer cannot decide whether to grant a dialect without knowing
 * which file it brings.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_DISCOVERY_SPECS,
  withheldSpecs,
} from "../../../src/internal/runtime/context/context-discovery.js";
import type { CompatSource } from "../../../src/types/agent.js";

/** Every literal a consumer may write today. Widened by T1.1; asserted here rather than assumed. */
const WRITABLE: readonly CompatSource[] = ["claude-code", "theokit", "agents", "gemini", "cursor"];

describe("a gated format always has a spelling that restores it", () => {
  it("every gated format has a spelling that restores it", () => {
    const gated = DEFAULT_DISCOVERY_SPECS.filter((s) => s.dialect !== undefined);
    expect(gated.length).toBeGreaterThan(0);

    // The assertion FR-002 exists for. A spec gated on a token absent from the union is a format
    // nobody can ask for — the file is silently withheld from every consumer, forever, and no
    // configuration restores it.
    for (const spec of gated) {
      expect(
        WRITABLE,
        `spec '${spec.id}' is gated on '${String(spec.dialect)}', which no consumer can write`,
      ).toContain(spec.dialect);
    }
  });

  it("all four repo-root files are gated", () => {
    const rootFiles = ["AGENTS.md", "GEMINI.md", "CLAUDE.md", "cursor-rules"];
    for (const id of rootFiles) {
      const spec = DEFAULT_DISCOVERY_SPECS.find((s) => s.id === id);
      expect(spec, `spec '${id}' is missing from DEFAULT_DISCOVERY_SPECS`).toBeDefined();
      expect(
        spec?.dialect,
        `'${id}' puts somebody else's text in our prompt with no opt-in`,
      ).toBeDefined();
    }
  });

  it("CLAUDE.md is not special-cased", () => {
    // The reviewer weighed the argument for keeping it ungated — projects with no `.claude/` use it
    // generically — and decided against. Recorded as a test so the next reader does not re-litigate
    // it from the absence of a comment.
    const claudeMd = DEFAULT_DISCOVERY_SPECS.find((s) => s.id === "CLAUDE.md");
    expect(claudeMd?.dialect).toBe("claude-code");
  });

  it("the grants are not collective", () => {
    // One grant must not admit another product's format. Collapsing them into a single "foreign"
    // token would force a consumer who wants AGENTS.md to also admit .cursor/rules/*.mdc, which is
    // the opposite of an opt-in.
    const byId = new Map(DEFAULT_DISCOVERY_SPECS.map((s) => [s.id, s.dialect]));
    expect(byId.get("AGENTS.md")).toBe("agents");
    expect(byId.get("GEMINI.md")).toBe("gemini");
    expect(byId.get("cursor-rules")).toBe("cursor");
    expect(byId.get("CLAUDE.md")).toBe("claude-code");
  });
});

describe("a withheld file is named, never counted", () => {
  it("an undeclared repository is told what it lost", () => {
    // A consumer declaring nothing goes from four repo-root files in the prompt to none. Being told
    // "4 sources withheld" is a diagnosis with no remedy: you cannot decide whether to grant a
    // dialect without knowing which file it brings.
    const withheld = withheldSpecs(DEFAULT_DISCOVERY_SPECS, []);
    const patterns = withheld.map((w) => w.pattern);

    expect(patterns).toContain("AGENTS.md");
    expect(patterns).toContain("GEMINI.md");
    expect(patterns).toContain("CLAUDE.md");
    expect(patterns).toContain(".cursor/rules/*.mdc");
  });

  it("a withheld file is named, not counted", () => {
    const withheld = withheldSpecs(DEFAULT_DISCOVERY_SPECS, []);
    // Every entry carries the grant that restores it. Without this the report says what was lost
    // and not how to get it back, which is half an answer.
    for (const entry of withheld) {
      expect(
        entry.pattern,
        "a withheld entry with no pattern is a count wearing a shape",
      ).toBeTruthy();
      expect(
        entry.grant,
        `'${entry.id}' is withheld with no grant that would admit it`,
      ).toBeTruthy();
    }
    expect(withheld.length).toBeGreaterThanOrEqual(4);
  });

  it("a granted dialect is not reported as withheld", () => {
    const withheld = withheldSpecs(DEFAULT_DISCOVERY_SPECS, ["agents"]);
    expect(withheld.map((w) => w.pattern)).not.toContain("AGENTS.md");
    expect(withheld.map((w) => w.pattern)).toContain("GEMINI.md");
  });

  it("no gate configured withholds nothing", () => {
    // `undefined` means no gate is configured and everything runs — NOT the same as `[]`, which is
    // a real declaration of no foreign dialect. Collapsing them would restore the defect B-011
    // fixed: a repository's files entering the prompt of a consumer who never asked.
    expect(withheldSpecs(DEFAULT_DISCOVERY_SPECS, undefined)).toHaveLength(0);
    expect(withheldSpecs(DEFAULT_DISCOVERY_SPECS, []).length).toBeGreaterThan(0);
  });
});
