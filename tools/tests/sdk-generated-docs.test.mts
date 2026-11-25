import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOCS = ["docs/harness-capability-map.md", "docs/error-codes.md"];

// The two references are produced by the SDK build and shipped in the package; nothing commits them.
describe("@theokit/sdk generated references", () => {
  // Reads the output of `pnpm --filter @theokit/sdk build`; it must not run that build itself,
  // because `pnpm quality` runs gates in parallel and a rebuild wipes `dist` under them.
  it("exist after the build and are listed in the packed tarball", () => {
    for (const rel of DOCS) {
      expect(statSync(join(ROOT, "packages/sdk", rel)).size).toBeGreaterThan(0);
    }
    const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: join(ROOT, "packages/sdk"),
      encoding: "utf8",
    });
    const files: string[] = JSON.parse(out)[0].files.map((f: { path: string }) => f.path);
    for (const rel of DOCS) expect(files).toContain(rel);
  });
});
