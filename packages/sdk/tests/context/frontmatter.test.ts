import { describe, expect, it } from "vitest";
import { parseFrontmatterYaml, splitFrontmatter } from "../../src/context/index.js";
import { ConfigurationError } from "../../src/errors.js";

function codeOf(fn: () => unknown): { code?: string; message: string } {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigurationError);
    return { code: (e as ConfigurationError).code, message: (e as Error).message };
  }
  throw new Error("did not throw");
}

describe("splitFrontmatter", () => {
  it("gives equal results for LF and CRLF", () => {
    const lf = "---\nname: x\n---\nbody\nmore\n";
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(splitFrontmatter(crlf)).toEqual(splitFrontmatter(lf));
    expect(splitFrontmatter(lf)).toEqual({ yaml: "name: x", body: "body\nmore\n" });
  });

  it("accepts a closing fence on the last line without a newline", () => {
    expect(splitFrontmatter("---\nname: x\n---")).toEqual({ yaml: "name: x", body: "" });
  });

  it("returns yaml undefined and the whole text when there is no opening fence", () => {
    expect(splitFrontmatter("# hi\n---\nx\n---\n")).toEqual({
      yaml: undefined,
      body: "# hi\n---\nx\n---\n",
    });
  });

  it("throws frontmatter_unterminated without a closing fence", () => {
    expect(codeOf(() => splitFrontmatter("---\nname: x\nbody")).code).toBe(
      "frontmatter_unterminated",
    );
  });
});

describe("parseFrontmatterYaml", () => {
  it("parses scalars and lists", () => {
    expect(
      parseFrontmatterYaml("a: x\nb: 2\nc: true\nd: [p, q]\ne:\n  - 1\n  - 2\n# c\nf:\n"),
    ).toEqual({ a: "x", b: 2, c: true, d: ["p", "q"], e: ["1", "2"] });
  });

  it("throws frontmatter_invalid naming the line", () => {
    const err = codeOf(() => parseFrontmatterYaml("name x"));
    expect(err.code).toBe("frontmatter_invalid");
    expect(err.message).toContain("line 1");
  });
});
