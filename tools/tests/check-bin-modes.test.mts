import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs tool
import { collectModes, diffModes, main } from "../check-bin-modes.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "binmodes-"));
  mkdirSync(join(root, "packages/a/bin"), { recursive: true });
  mkdirSync(join(root, "packages/b/src"), { recursive: true });
  const f = join(root, "packages/a/bin/x.mjs");
  writeFileSync(f, "#!/usr/bin/env node\n");
  chmodSync(f, 0o755);
  return { root, f, snap: join(root, "snap.json") };
}

describe("check-bin-modes", () => {
  it("collects only packages/*/bin/*.mjs", () => {
    expect(collectModes(fixture().root)).toEqual({ "packages/a/bin/x.mjs": 0o755 });
  });
  it("passes when modes are unchanged", () => {
    const { root, snap } = fixture();
    expect(main(["snapshot", snap], root)).toBe(0);
    expect(main(["verify", snap], root)).toBe(0);
  });
  it("fails when a mode changes", () => {
    const { root, f, snap } = fixture();
    main(["snapshot", snap], root);
    chmodSync(f, 0o644);
    expect(main(["verify", snap], root)).toBe(1);
  });
  it("fails without a snapshot", () => {
    const { root, snap } = fixture();
    expect(main(["verify", snap], root)).toBe(1);
  });
  it("diffs added and removed files", () => {
    expect(diffModes({ a: 1 }, { b: 1 })).toHaveLength(2);
  });
});
