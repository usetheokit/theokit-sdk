import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * `@theokit/sdk` publishes three `./internal/*` subpaths. That is deliberate:
 * the word `internal` in a specifier is the warning that the surface is
 * semver-exempt, and satellites in this monorepo consume them on that footing.
 *
 * The risk is not the three. It is a fifth appearing because it was convenient,
 * with nobody deciding whether it is a raw channel that also needs a stable
 * facade (`security` has one) or a satellite-only channel that
 * must NOT have one (`memory-adapters`, `memory-store` — a facade there would
 * promise a stability their surface does not have).
 *
 * So this gate does not forbid the escape hatch. It forbids growing it in
 * silence: `src/internal/README.md` names every subpath and its kind, and a new
 * one fails here until someone writes down which kind it is.
 *
 * What it does NOT check: whether the kind recorded is the right one. That is
 * the judgement the gate exists to force someone to make, not to make for them.
 */
describe("every published internal subpath is a declared decision", () => {
  const manifest = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as {
    exports: Record<string, unknown>;
  };
  const readme = readFileSync(join(PKG_ROOT, "src", "internal", "README.md"), "utf8");
  // Only the declaring section counts. The first draft searched the whole file
  // and passed for a fake `./internal/telemetry` subpath, because the word
  // appears elsewhere in a list of barrel pairs — a gate satisfied by an
  // unrelated mention is a gate that reports coverage it does not have.
  const DECLARING_HEADING = "## What `internal` means here";
  const declaration = readme.slice(readme.indexOf(DECLARING_HEADING));
  const subpaths = Object.keys(manifest.exports).filter((k) => k.startsWith("./internal/"));

  it("reads the manifest and the declaring section — either being empty passes vacuously", () => {
    expect(readme, "the declaring section is gone or was renamed").toContain(DECLARING_HEADING);
    expect(declaration.length).toBeGreaterThan(500);
    expect(
      subpaths.length,
      "no ./internal/* subpath was found; the exports field or this filter changed",
    ).toBeGreaterThanOrEqual(3);
  });

  it("names each one in src/internal/README.md", () => {
    const undeclared = subpaths.filter(
      (p) => !declaration.includes(`\`${p.replace("./internal/", "")}\``),
    );
    expect(
      undeclared,
      "a published semver-exempt subpath nobody wrote down is the escape hatch " +
        "growing by accident. Add it to src/internal/README.md § What `internal` means " +
        "here, saying whether it takes a stable facade at src/ root or deliberately does not",
    ).toEqual([]);
  });

  it("the README states the count it is declaring, so a stale table is visible", () => {
    expect(declaration).toContain("| 2 | a published `./internal/*` subpath |");
    const declared =
      /semver-exempt\*\* — the word `internal` in the specifier IS the warning \| (\d+) \|/.exec(
        readme,
      );
    expect(declared?.[1], "the subpath count is not stated in the table").toBeDefined();
    expect(Number(declared?.[1]), "the README's count disagrees with package.json").toBe(
      subpaths.length,
    );
  });
});
