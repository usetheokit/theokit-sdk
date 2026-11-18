import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function hasRef(ref: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("promotion: no re-consumed changesets", () => {
  // Without origin/main there is nothing to compare against (shallow or detached clone).
  it.runIf(hasRef("origin/main"))("HEAD holds no changeset that origin/main already consumed", () => {
    expect(() =>
      execFileSync("node", ["tools/check-no-reconsumed-changesets.mjs", "origin/main", "HEAD"], {
        cwd: ROOT,
        stdio: "pipe",
      }),
    ).not.toThrow();
  });
});
