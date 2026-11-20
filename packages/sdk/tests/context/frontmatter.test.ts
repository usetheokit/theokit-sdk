import { describe, expect, it } from "vitest";
import { parseFrontmatterYaml, splitFrontmatter } from "../../src/context/index.js";
import { ConfigurationError } from "../../src/errors.js";

describe("splitFrontmatter", () => {
  it("gives equal yaml and body for LF and CRLF", () => {
    const lf = "---\nname: x\n---\nhello\nworld\n";
    const a = splitFrontmatter(lf);
    const b = splitFrontmatter(lf.replace(/\n/g, "\r\n"));
    expect(b).toEqual(a);
    expect(a.yaml).toBe("name: x");
    expect(a.body).toBe("hello\nworld\n");
  });
  it("accepts a closing fence on the last line", () => {
    expect(splitFrontmatter("---\nname: x\n---")).toEqual({ yaml: "name: x", body: "" });
  });
  it("returns the whole text when there is no opening fence", () => {
    expect(splitFrontmatter("# hi\n---\n")).toEqual({ yaml: undefined, body: "# hi\n---\n" });
  });
  it("throws frontmatter_unterminated without a closing fence", () => {
    try {
      splitFrontmatter("---\nname: x\nbody");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigurationError);
      expect((e as ConfigurationError).code).toBe("frontmatter_unterminated");
    }
  });
});

describe("parseFrontmatterYaml", () => {
  it("parses scalars, inline and block lists", () => {
    expect(parseFrontmatterYaml("a: 1\nb: true\nc: hi\nd: [x, y]\ne:\n  - p\n  - q\n# c")).toEqual({
      a: 1,
      b: true,
      c: "hi",
      d: ["x", "y"],
      e: ["p", "q"],
    });
  });
  it("throws frontmatter_invalid naming line 1", () => {
    try {
      parseFrontmatterYaml("name x");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigurationError);
      expect((e as ConfigurationError).code).toBe("frontmatter_invalid");
      expect((e as ConfigurationError).message).toContain("line 1");
    }
  });
});
