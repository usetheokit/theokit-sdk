import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACCEPTED_HOOK_FIELDS,
  CLAUDE_CODE_EVENT_MAP,
  UNIMPLEMENTED_CLAUDE_CODE_HOOK_FIELDS,
} from "../src/internal/runtime/hooks/hooks-source.js";

/**
 * #638 — the README told a consumer to validate a `hooks` key "against the shape above", and no
 * shape was above it. The shape is there now, and this is what keeps it true.
 *
 * The three facts a consumer writes `hooks.json` from are all enumerable in the loader, so the
 * README is checked AGAINST the loader rather than beside it. A doc that restates a list is a doc
 * that drifts from it on the first change; the whole reason `CLAUDE_CODE_EVENT_MAP` is exported is
 * that somebody already learned this here.
 *
 * Deliberately NOT asserting the prose. This pins the enumerable claims — which events fire, which
 * fields are taken, which are refused — and leaves the explanation to a human.
 */
const README = readFileSync(join(__dirname, "..", "..", "..", "README.md"), "utf8");

function hooksSection(): string {
  const start = README.indexOf("\n## Hooks\n");
  expect(
    start,
    "the README has no `## Hooks` section — this gate is reading nothing",
  ).toBeGreaterThan(-1);
  const after = README.indexOf("\n## ", start + 1);
  return README.slice(start, after === -1 ? README.length : after);
}

describe("the README's hooks section is checked against the loader", () => {
  it("shows a shape, so the sentence pointing at one is not dangling", () => {
    const section = hooksSection();
    // The defect this file exists for: prose referring to a shape that is not there.
    expect(section, "no fenced block in `## Hooks`").toContain("```json");
    expect(section).toContain('"hooks"');
    expect(section).toContain('"matcher"');
    expect(section).toContain('"type": "command"');
  });

  it("names every event that fires, and no event that does not", () => {
    const section = hooksSection();
    const fires = Object.keys(CLAUDE_CODE_EVENT_MAP);
    expect(fires.length, "the map is empty — the assertion below would be vacuous").toBeGreaterThan(
      0,
    );

    for (const event of fires) {
      expect(section, `\`${event}\` fires and the README does not name it`).toContain(
        `\`${event}\``,
      );
    }

    // A name in the table that the runtime does not fire is the worse direction: it reads as a
    // working hook and is silence. Checked against the table rows only — the prose below it names
    // refused events on purpose.
    const rows = [...section.matchAll(/^\|\s*`([A-Za-z]+)`\s*\|/gm)]
      .map((m) => m[1])
      .filter((n): n is string => n !== undefined);
    expect(rows.length, "no table rows matched — the row regex is reading nothing").toBeGreaterThan(
      0,
    );
    for (const row of rows) {
      expect(
        fires,
        `the README's table promises \`${row}\`, which this runtime never fires`,
      ).toContain(row);
    }
  });

  /**
   * Both lists are read from THEIR OWN SENTENCE, not from the section.
   *
   * The first version of this file asserted `section.toContain("`if`")` and passed after `if` was
   * deleted from the refused list — because the next sentence says "Dropping `if` in particular
   * fails OPEN". The assertion was green for a reason unrelated to what it claimed, which is the
   * defect it exists to catch, one level up. Proven by deleting each name and watching this fail.
   */
  function backticked(sentence: string | undefined): ReadonlySet<string> {
    expect(sentence, "the sentence this list is read from is not in the README").toBeDefined();
    return new Set(
      [...(sentence ?? "").matchAll(/`([A-Za-z]+)`/g)]
        .map((m) => m[1])
        .filter((n): n is string => n !== undefined),
    );
  }

  it("lists exactly the fields a hook entry may carry", () => {
    const sentence = hooksSection().match(/A hook entry accepts[^.]*\./)?.[0];
    const listed = backticked(sentence);
    for (const field of ACCEPTED_HOOK_FIELDS) {
      expect(listed, `\`${field}\` is accepted and the README's list omits it`).toContain(field);
    }
    for (const field of listed) {
      expect(
        ACCEPTED_HOOK_FIELDS,
        `the README lists \`${field}\`, which the loader does not accept`,
      ).toContain(field);
    }
  });

  it("lists every Claude Code field that is refused", () => {
    const sentence = hooksSection().match(/Claude Code fields[\s\S]*?refused[^.]*\./)?.[0];
    const listed = backticked(sentence);
    for (const field of UNIMPLEMENTED_CLAUDE_CODE_HOOK_FIELDS) {
      expect(
        listed,
        `\`${field}\` is refused with an error and the README's list omits it`,
      ).toContain(field);
    }
  });
});
