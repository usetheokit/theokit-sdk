import { execFileSync } from "node:child_process";
import { chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const PKG = join(import.meta.dirname, "..");
const BIN = join(PKG, "bin", "theokit-acp.mjs");
const TOOL = join(PKG, "..", "..", "tools", "ensure-bin-executable.mjs");

describe("theokit-acp.mjs executable bit", () => {
  afterEach(() => chmodSync(BIN, 0o755));

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

  it("the post-build step restores a lost bit", () => {
    chmodSync(BIN, 0o644);
    execFileSync("node", [TOOL, PKG]);
    expect(statSync(BIN).mode & 0o100).toBe(0o100);
  });
});
