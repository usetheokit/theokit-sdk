/**
 * B-494: the `theokit-acp` bin must stay executable. Asserts both the committed mode (git index)
 * and the on-disk owner execute bit. `pnpm build` and `pnpm --filter @theokit/acp test` do not
 * change the mode (verified at HEAD); the known in-place rewriter is `stryker run`, which
 * `pnpm run mutation` already brackets with tools/check-bin-modes.mjs (B-445). This test guards
 * every other path (a bare `stryker run`, a stray chmod, a bad commit).
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
