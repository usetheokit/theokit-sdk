import { describe, expect, it } from "vitest";

import { parseSimpleYaml } from "../../../../src/internal/runtime/context/yaml-frontmatter.js";

/**
 * A block-style YAML list was dropped, and the docblock recommended the shape it could not read.
 *
 * The parser is line-oriented: it splits on the first `:` and coerces. A continuation line `- item`
 * has no colon and is skipped by `if (colonIndex === -1) continue`, while the key line has an empty
 * value and coerces to `undefined`. The key vanishes entirely — a reader sees it on disk and finds
 * no behaviour, with nothing to grep for.
 *
 * Two things make this worth fixing rather than documenting:
 *
 *   - The file's own docblock, listing the inline list's comma limitation, advises "Use multi-line
 *     lists or reword if you need this." Multi-line lists were the one shape it did not support.
 *   - `theokit`'s scaffold writes `paths:` in block form, and the format documents the block form
 *     for `allowed-tools`, `disallowed-tools`, `arguments`, `paths` and `skills`.
 *
 * The sibling parser `context-yaml-lite.ts` already reads block lists, and its comment records that
 * adding them was a repair rather than a feature. Two parsers in one package disagreeing about the
 * same frontmatter is the divergence this closes.
 */
describe("a block-style list parses", () => {
  it("reads a multi-line list into an array", () => {
    const fields = parseSimpleYaml(["paths:", "  - src/api/**", "  - src/web/**"].join("\n"));
    expect(
      fields.paths,
      "the key vanished — a reader sees `paths:` on disk and finds no behaviour",
    ).toEqual(["src/api/**", "src/web/**"]);
  });

  it("keeps reading the inline list form", () => {
    // The control. Both shapes are documented; a fix that traded one for the other is not a fix.
    const fields = parseSimpleYaml("tags: [a, b]");
    expect(fields.tags).toEqual(["a", "b"]);
  });

  it("does not swallow the key that follows a block list", () => {
    const fields = parseSimpleYaml(["paths:", "  - a.ts", "name: after"].join("\n"));
    expect(fields.paths).toEqual(["a.ts"]);
    expect(fields.name, "the list consumed the key after it").toBe("after");
  });

  it("leaves a bare empty key as undefined", () => {
    // Unchanged: `key:` with nothing under it still means absent, so a caller's Zod default applies.
    const fields = parseSimpleYaml(["empty:", "name: x"].join("\n"));
    expect(fields.empty).toBeUndefined();
    expect(fields.name).toBe("x");
  });

  it("still reads scalars", () => {
    const fields = parseSimpleYaml(["name: agent", "count: 42", "on: true"].join("\n"));
    expect(fields).toMatchObject({ name: "agent", count: 42, on: true });
  });
});
