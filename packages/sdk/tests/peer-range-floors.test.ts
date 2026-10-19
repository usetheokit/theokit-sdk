import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * SE43 DoD#4 — the 5 satellites that import v4-only surfaces MUST declare a
 * `@theokit/sdk` peer-range floor of at least 4.0.0. A loose `>=1.7.0` floor lets
 * a non-workspace install resolve an incompatible old sdk against v4-only imports
 * (system-design-output/final_report.md § MEDIUM — Loose >=1.7.0).
 *
 * What this file CANNOT see, recorded because it took a CI leg to find: a major-only floor is a
 * weaker claim than the one that matters. `sdk-cache` declared `>=4.0.0` and passed every case here
 * while using `PostAssistantReplyContext.usedTools`, which did not exist until 4.54.0 — so an
 * install at the bottom of its own declared range failed to build. Measured 2026-08-27 by the
 * `dep-check` leg that installs each package at its floor and builds it.
 *
 * Deriving the true floor statically would mean type-checking every satellite against every version
 * its range admits, which is that leg's job and not a unit test's. What is possible here is pinning
 * a floor once it is KNOWN, so it cannot silently drop back.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..");
const SATELLITES = [
  "sdk-tools",
  "sdk-memory",
  "sdk-cache",
  "sdk-handoff",
  "sdk-budget",
  "sdk-pty",
] as const;

/** The version of `@theokit/sdk` in this workspace, which a `workspace:` peer range publishes against. */
const WORKSPACE_SDK_VERSION = (
  JSON.parse(readFileSync(join(REPO_ROOT, "packages", "sdk", "package.json"), "utf8")) as {
    version: string;
  }
).version;

/**
 * The range pnpm writes into the published manifest for `range`.
 *
 * A `workspace:` range never reaches a consumer as written: `pnpm pack` replaces `workspace:^`
 * with `^<version>`, `workspace:~` with `~<version>` and `workspace:*` with `<version>`, where
 * `<version>` is the workspace package's version at pack time, and drops the protocol from a
 * `workspace:` range that already names a version. The floor a consumer sees is the one in the
 * published range, so that is the range the floor checks below have to read.
 *
 * `sdk-memory` declares `workspace:^` since 852c9b34: the `dep-check` gate refuses a plain range
 * above the version installed in the workspace, and `>=5.10.0` names a version that exists only
 * after `changeset version`. The siblings `memory-honcho`, `memory-mem0` and `memory-supermemory`
 * declare the same peer the same way.
 */
function publishedPeerRange(range: string, workspaceVersion: string): string {
  if (!range.startsWith("workspace:")) return range;
  const spec = range.slice("workspace:".length);
  if (spec === "^" || spec === "~") return `${spec}${workspaceVersion}`;
  if (spec === "*") return workspaceVersion;
  return spec;
}

/**
 * The [major, minor, patch] a range floors at, ignoring any prerelease suffix.
 *
 * `>=4.63.4-next.0` floors at 4.63.4 for this purpose. The suffix is deliberately dropped: what the
 * assertion below protects is that the floor did not DROP, and a prerelease of a version is the
 * same version for that question.
 */
function peerFloorTriple(range: string): [number, number, number] {
  const m = range.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) throw new Error(`unparseable peer range: ${range}`);
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

/** Is `range`'s floor at least `floor`? */
function floorAtLeast(range: string, floor: string): boolean {
  // Destructured rather than indexed: `noUncheckedIndexedAccess` types `a[i]` as possibly
  // undefined, and comparing those would be a type error the typecheck gate refuses — correctly.
  const [aMajor, aMinor, aPatch] = peerFloorTriple(range);
  const [bMajor, bMinor, bPatch] = peerFloorTriple(floor);
  if (aMajor !== bMajor) return aMajor > bMajor;
  if (aMinor !== bMinor) return aMinor > bMinor;
  return aPatch >= bPatch;
}

/** The numeric major floor of a peer range like ">=4.0.0" or "^4". */
function peerFloorMajor(range: string): number {
  const [major] = peerFloorTriple(range);
  return major;
}

/** Floors established by measurement, with the API that forced each one. */
const MEASURED_FLOORS: Record<string, { floor: string; because: string }> = {
  // `PostAssistantReplyContext.usedTools` (8d1feaaf, first released in 4.54.0) — the cache reads it
  // to avoid replaying an answer that came from a tool call.
  "sdk-cache": { floor: "4.54.0", because: "PostAssistantReplyContext.usedTools" },
  // Not an API this package uses — 4.53.1's OWN published declarations do not compile. `#345`
  // (`e368fc18`) bound the re-exported names the rollup left unimported, and first shipped in
  // 4.54.0; before it, `index.d.ts` references `MemoryProviderFactory`, `AgentBuilderDeps` and
  // `DECLARED` without defining them. A floor may be wrong because the version it names is broken,
  // not only because the code outgrew it.
  // Raised again for a third reason: this package no longer COPIES the markdown store, it imports
  // `@theokit/sdk/internal/memory-store`, and that sub-path first ships in 4.60.0. A floor is a
  // promise about what a consumer can install; importing a path an admitted version does not export
  // is the `#399` failure exactly — a load-time crash, not a type error.
  // Raised a fourth time, and this one is about the CONTENTS of the sub-path rather than its
  // existence. #463 replaced this package's remaining copies with imports, and the names it now
  // pulls through `internal/memory-store` — `resolveMemoryRoot`, `sessionsDir`,
  // `writeSessionSummary`, `discoverSessionFiles`, `discoverWikiFiles`,
  // `persistActiveMemoryTranscript`, `collectMarkdownFiles`, `defaultIndexPath`,
  // `lanceStoragePath`, `readAllSqliteFacts`, the diary module — first ship in 4.63.0. Against
  // 4.60.0 the sub-path resolves and the members are absent, which is the same `#399` shape one
  // level in: the import succeeds and the symbol is undefined.
  //
  // It could not be raised in the release that created 4.63.0. A floor names a version a consumer
  // can install, and that version did not exist yet; `dep-check`'s floor leg failed for one
  // release, correctly and out loud, saying so.
  //
  // The same holds for 5.10.0, the first SDK exporting `resolveMaxFacts` and `ceilingReachedError`,
  // which sdk-memory imports since the memory ceiling. The peer is `workspace:^`, so its published
  // floor is the SDK version of the release that publishes it, 5.10.0 for that release. While the
  // workspace still carries 5.9.x, a pinned 5.10.0 here would fail on every commit before
  // `changeset version` runs; raise it once 5.10.0 is the workspace version.
  "sdk-memory": {
    floor: "4.63.0",
    because: "imports members of internal/memory-store added in 4.63.0 (#463)",
  },
  // Same reason, and these two PASSED the CI leg — which is what makes them worth recording. That
  // leg builds each package against its floor, and neither of these typechecks the SDK's
  // declarations while building, so a broken `.d.ts` never reaches their compiler. A consumer's
  // does. Measured 2026-08-27 with `skipLibCheck: false`, `@types/node` and `zod` installed:
  // 4.4.1 → 6 errors, 4.19.3 → 7, 4.53.1 → 7, 4.54.0 → 0.
  //
  // A peer range is a promise about what a CONSUMER can build against, not about what this
  // repository can build. Where those two disagree, the consumer's answer is the one the field is
  // making a claim about.
  "sdk-pty": { floor: "4.54.0", because: "no TS consumer compiles against the SDK below 4.54.0" },
  "sdk-tools": { floor: "4.54.0", because: "no TS consumer compiles against the SDK below 4.54.0" },
};

describe("publishedPeerRange — what pnpm writes for a workspace: range", () => {
  it("resolves workspace:^ to a caret range on the workspace version", () => {
    expect(publishedPeerRange("workspace:^", "5.10.0")).toBe("^5.10.0");
  });

  it("resolves workspace:~ to a tilde range on the workspace version", () => {
    expect(publishedPeerRange("workspace:~", "5.10.0")).toBe("~5.10.0");
  });

  it("resolves workspace:* to the exact workspace version", () => {
    expect(publishedPeerRange("workspace:*", "5.10.0")).toBe("5.10.0");
  });

  it("strips the protocol from a workspace: range that names a version", () => {
    expect(publishedPeerRange("workspace:^4.63.0", "5.10.0")).toBe("^4.63.0");
  });

  it("leaves a plain range unchanged", () => {
    expect(publishedPeerRange(">=4.63.0", "5.10.0")).toBe(">=4.63.0");
  });

  it("refuses a workspace:^ floor that publishes below a measured floor", () => {
    const published = publishedPeerRange("workspace:^", "4.62.9");
    expect(floorAtLeast(published, "4.63.0")).toBe(false);
  });

  it("still throws on a range with no version in it", () => {
    expect(() => peerFloorTriple(publishedPeerRange("workspace:latest", "5.10.0"))).toThrow(
      "unparseable peer range: latest",
    );
  });
});

describe("SE43 DoD#4 — satellite @theokit/sdk peer-range floors", () => {
  for (const pkg of SATELLITES) {
    it(`${pkg} declares a peer floor >= 4.0.0`, () => {
      const manifest = JSON.parse(
        readFileSync(join(REPO_ROOT, "packages", pkg, "package.json"), "utf8"),
      ) as { peerDependencies?: Record<string, string> };
      const range = manifest.peerDependencies?.["@theokit/sdk"];
      expect(range, `${pkg} must declare a @theokit/sdk peerDependency`).toBeDefined();
      expect(
        peerFloorMajor(publishedPeerRange(range as string, WORKSPACE_SDK_VERSION)),
      ).toBeGreaterThanOrEqual(4);
    });

    const measured = MEASURED_FLOORS[pkg];
    if (measured !== undefined) {
      it(`${pkg} keeps the floor its own imports require (${measured.floor})`, () => {
        const manifest = JSON.parse(
          readFileSync(join(REPO_ROOT, "packages", pkg, "package.json"), "utf8"),
        ) as { peerDependencies?: Record<string, string> };

        const declared = manifest.peerDependencies?.["@theokit/sdk"];
        expect(declared, `${pkg} must declare a @theokit/sdk peerDependency`).toBeDefined();

        // Compared as versions, not as substrings. `toContain` answered a different question and
        // answered it twice wrongly: `>=14.54.0` CONTAINS "4.54.0" and would have passed, while a
        // legitimately higher floor fails. Prerelease mode makes the second case routine —
        // `changeset version` rewrites every internal peer range to the prerelease being cut,
        // because a prerelease never satisfies a plain range, and no range string can admit future
        // prereleases (semver by design; measured 2026-09-01 on usetheokit/theokit-sdk#502).
        //
        // The docblock above states the invariant this file exists for: a known floor must not
        // "silently drop back". Dropping is the failure. Raising is not, and asserting against it
        // blocked every prerelease cut in the repository.
        const published = publishedPeerRange(declared as string, WORKSPACE_SDK_VERSION);
        expect(
          floorAtLeast(published, measured.floor),
          `${pkg} needs at least ${measured.floor} for ${measured.because}; a lower floor promises a build that fails. Declared: ${declared}, published as: ${published}`,
        ).toBe(true);
      });
    }
  }
});
