import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PKG = join(import.meta.dirname, "..");
const BIN = join(PKG, "bin", "theokit-acp.mjs");
const TOOL = join(PKG, "..", "..", "tools", "ensure-bin-executable.mjs");

// These read the real working tree and never repair it: a lost bit must stay visible.
describe("theokit-acp.mjs executable bit", () => {
  it("is committed as 100755 in the git index", () => {
    const out = execFileSync("git", ["ls-files", "-s", "--", "bin/theokit-acp.mjs"], {
      cwd: PKG,
      encoding: "utf8",
    });
    expect(out.startsWith("100755 ")).toBe(true);
  });

  it("has the owner execute bit on disk", () => {
    expect(statSync(BIN).mode & 0o100).toBe(0o100);
  });

  it("the build script ends with the step that restores the bit", () => {
    const { scripts } = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
    expect(scripts.build).toContain("ensure-bin-executable.mjs");
  });

  it("that step restores a lost bit (on a scratch copy)", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-bin-"));
    try {
      cpSync(join(PKG, "package.json"), join(dir, "package.json"));
      cpSync(join(PKG, "bin"), join(dir, "bin"), { recursive: true });
      const copy = join(dir, "bin", "theokit-acp.mjs");
      chmodSync(copy, 0o644);
      execFileSync("node", [TOOL, dir]);
      expect(statSync(copy).mode & 0o100).toBe(0o100);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
