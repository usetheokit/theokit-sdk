/**
 * B-494: the `theokit-acp` bin must stay executable. A tool that rewrites the file in place
 * (a Stryker run restores content, not mode) leaves 100644 on disk and a `old mode 100755` diff.
 * Asserts both the committed mode (git index) and the on-disk owner execute bit.
 */
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const BIN = join(import.meta.dirname, "..", "bin", "theokit-acp.mjs");

describe("theokit-acp bin mode", () => {
  it("is 100755 in the git index", () => {
    const out = execFileSync("git", ["ls-files", "-s", "--", BIN], {
      cwd: join(import.meta.dirname, ".."),
      encoding: "utf8",
    });
    expect(out.startsWith("100755 ")).toBe(true);
  });

  it("has the owner execute bit on disk", () => {
    expect(statSync(BIN).mode & 0o100).toBe(0o100);
  });
});
