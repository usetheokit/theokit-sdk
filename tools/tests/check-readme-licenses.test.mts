import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs tool
import { findMismatches, main, readmeLicense } from "../check-readme-licenses.mjs";

function fixture(pkgs: Record<string, [string, string]>) {
  const root = mkdtempSync(join(tmpdir(), "readmelic-"));
  for (const [name, [license, readme]] of Object.entries(pkgs)) {
    const d = join(root, "packages", name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "package.json"), JSON.stringify({ license }));
    writeFileSync(join(d, "README.md"), readme);
  }
  return root;
}

describe("check-readme-licenses", () => {
  it("reads the license under the License heading", () => {
    expect(readmeLicense("# x\n\n## License\n\nApache-2.0 — see [LICENSE](./LICENSE).\n")).toBe(
      "Apache-2.0",
    );
    expect(readmeLicense("MIT-licensed dep mentioned\n")).toBeUndefined();
  });
  it("passes when README and package.json agree or README has no section", () => {
    const root = fixture({
      a: ["Apache-2.0", "## License\n\nApache-2.0.\n"],
      b: ["Apache-2.0", "no license section, MIT dep\n"],
    });
    expect(main(root)).toBe(0);
  });
  it("fails when they disagree", () => {
    const root = fixture({ a: ["Apache-2.0", "## License\n\nMIT.\n"] });
    expect(findMismatches(root)).toEqual([
      { file: "packages/a/README.md", readme: "MIT", manifest: "Apache-2.0" },
    ]);
    expect(main(root)).toBe(1);
  });
});
