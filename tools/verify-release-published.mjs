#!/usr/bin/env node
/**
 * Release guard — refuse to report success for a release that published nothing.
 *
 * Ported from usetheokit/theokit's scripts/verify-release-published.mjs, per its own release.yml
 * comment claiming theokit-sdk "already records" this guard — it did not. Measured here 2026-09-03:
 * `Release via Changesets (Harness)` reported success on run 33786821826 while
 * `@theokit/sdk@5.0.0-next.2` never reached the registry (E404), git tag and GitHub release both
 * present. `verify-release-refs.mjs` in this same pipeline checks the tag; nothing checked npm.
 * Filed as usetheokit/theokit-sdk#537.
 *
 * ## The failure this exists to prevent
 *
 * A publish pipeline that reports success when it publishes nothing is indistinguishable from one
 * that published — until the day it matters. "Nothing to publish" (every version already on the
 * registry) and "published" produce the same visible outcome unless something checks the registry
 * directly, which nothing in this pipeline did before this file.
 *
 * ## What it proves, and what it does not
 *
 * It proves the versions this release was supposed to publish are ON the registry. It does not
 * prove the tarball's contents, the provenance attestation, or that the right account published —
 * a guard that claimed more than it measures is the failure mode this repository keeps finding.
 *
 * An unreachable registry FAILS rather than passing: "I could not check" and "it published" are
 * different facts, and only one of them is safe to report as a release.
 *
 * Usage: `node tools/verify-release-published.mjs`
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function publishablePackages() {
  return readdirSync("packages", { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join("packages", e.name))
    .flatMap((dir) => {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        if (pkg.private === true) return [];
        if (typeof pkg.name !== "string" || typeof pkg.version !== "string") return [];
        return [{ dir, name: pkg.name, version: pkg.version }];
      } catch {
        return [];
      }
    });
}

/**
 * The published size of a package, for backoff scaling. Large packages (>5MB) propagate slower
 * on the npm registry.
 *
 * Asked WITHOUT a version, and that is the whole point. This is only ever called for a version
 * the registry has just answered 404 for — that is what put it in `pending` — so asking for
 * `name@version` 404s for the same reason, the size comes back `undefined`, and the scaling this
 * function exists to drive never engages. It was unreachable by construction: in the loop below
 * it could not return anything else. Three releases (`5.0.0-next.2`, `.3`, `.4`) hit the default
 * 30s window and reported a false "was NOT published" with the mitigation supposedly in place.
 *
 * The bare name resolves the published `latest`, which by definition exists. Its size is a proxy
 * for the version being published, and a good one: measured 2026-09-04 on @theokit/sdk, `latest`
 * was 12_369_860 bytes against the pending version's 12_940_376 — 4% apart, and both land on the
 * same multiplier. A package with no published version at all still yields `undefined`, which is
 * the honest answer: nothing was measured, so nothing is scaled.
 */
function getUnpackedSize({ name }) {
  try {
    const out = execFileSync("npm", ["view", name, "dist.unpackedSize", "--prefer-online"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    // A package with several published versions answers one line per version; the sizes are
    // within a few percent of each other, so the first is as good a proxy as any.
    const size = Number(out.trim().split("\n")[0]);
    return Number.isFinite(size) ? size : undefined;
  } catch {
    // If we cannot get the size, we do not scale the backoff; proceed with default delays.
    return undefined;
  }
}

function registryState({ name, version }) {
  try {
    // `--prefer-online` because `npm view` will otherwise answer from the local metadata cache,
    // which in a release job was populated moments before the publish.
    const out = execFileSync("npm", ["view", `${name}@${version}`, "version", "--prefer-online"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.trim().length > 0 ? "published" : "absent";
  } catch (err) {
    const stderr = String(err?.stderr ?? "");
    if (stderr.includes("E404") || stderr.includes("404 Not Found")) return "absent";
    return `unknown: ${stderr.split("\n").find((l) => l.trim().length > 0) ?? "no detail"}`;
  }
}

/**
 * Does the tag for this release exist locally?
 *
 * Checked LOCALLY on purpose: changesets creates the tags before pushing them, so a local hit with
 * a failed push is precisely the state this distinguishes, and asking the remote would report the
 * same "absent" for both.
 */
function tagState({ name, version }) {
  const tag = `${name}@${version}`;
  try {
    const out = execFileSync("git", ["tag", "-l", tag], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.trim().length > 0 ? "tagged" : "absent";
  } catch (err) {
    // A git that cannot answer is NOT evidence of an absent tag. Saying so keeps this from
    // reporting a failure it did not observe.
    return `unknown: ${String(err?.stderr ?? err).split("\n")[0]}`;
  }
}

const packages = publishablePackages();

if (packages.length === 0) {
  console.error("verify-release-published: found no publishable package — nothing was checked");
  process.exit(1);
}

/**
 * npmjs is eventually consistent: a publish that has already succeeded can answer E404 on the read
 * path, and `npm view` reports that identically to a version nobody published. So `absent` is
 * retried before it is believed. `unknown` is not: an unreachable registry is an infrastructure
 * fault, and the honest response is to say so now rather than after minutes of waiting for a
 * network that is down.
 *
 * ## Why the ladder reaches 64 s (#574)
 *
 * "A few seconds" was the original estimate and it was wrong by an order of magnitude. Measured on
 * the `5.0.1` release, run 33971302112:
 *
 *   14:26:34  changeset: ◇ Successfully published @theokit/sdk@5.0.1, @theokit/sdk-memory@0.5.3
 *   14:28:03  this script: ✗ was NOT published, exit 1
 *   14:28:09  npm registers @theokit/sdk-memory@0.5.3   ← 6 s after we gave up
 *   14:29:36  npm registers @theokit/sdk@5.0.1          ← 93 s after we gave up
 *
 * Both were on the registry; `latest` moved to `5.0.1`. The publish had worked and this script
 * called it failed. `5.0.0` failed the same way the day before, on four packages — two of the last
 * twelve release runs were false failures.
 *
 * The old ladder `2000,4000,8000,16000` scaled by 2.6 for the 13 MB package gave it 78 s of budget
 * against 182 s of real lag. Adding `32000,64000` takes the scaled budget to 328 s, which covers
 * the measurement with margin.
 *
 * IT COSTS NOTHING ON A FAST RELEASE. Each step returns the moment the version appears, so the
 * extra rungs are only reached by a release that would otherwise have been reported as failed.
 *
 * 2026-11-19 (#1241): run 44432134014 published @theokit/sdk@5.26.0 but the six-rung window (~6.3 min)
 * ended before npm showed it. `128000` adds a seventh rung, roughly doubling the window to ~11 min.
 *
 * WHAT WAS DELIBERATELY NOT DONE: softening the verdict to a warning. The reason this script exists
 * is #537 — a publish that silently did not happen, reported green. What was wrong here is the
 * budget, not the strictness, and a warning would trade a false failure for a false success.
 */
const RETRY_DELAYS_MS = (
  process.env.THEOKIT_RELEASE_VERIFY_DELAYS_MS ?? "2000,4000,8000,16000,32000,64000,128000"
)
  .split(",")
  .map((n) => Number(n.trim()))
  .filter((n) => Number.isFinite(n) && n >= 0);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let unknown = 0;
let pending = [];
for (const pkg of packages) {
  const state = registryState(pkg);
  if (state === "published") {
    console.log(`✓ ${pkg.name}@${pkg.version} is on the registry`);
  } else if (state === "absent") {
    pending.push(pkg);
  } else {
    unknown++;
    console.error(`? ${pkg.name}@${pkg.version} could not be checked — ${state}`);
  }
}

for (const delay of RETRY_DELAYS_MS) {
  if (pending.length === 0) break;

  // Scale backoff for large packages: npm registry eventual consistency
  // is slower for multi-megabyte tarballs. Observed: @theokit/sdk (12.9MB)
  // failed twice while smaller packages (276KB–1.25MB) succeeded in the same
  // batch. Backoff is scaled proportionally to dist.unpackedSize.
  let maxScaledDelay = delay;
  const scaledDelays = new Map();
  for (const pkg of pending) {
    const size = getUnpackedSize(pkg);
    let scaledDelay = delay;
    if (size !== undefined && size > 5_000_000) {
      // Scale by (size / 5MB), capped at 4x for packages >20MB
      const scale = Math.min(4, size / 5_000_000);
      scaledDelay = Math.round(delay * scale);
      scaledDelays.set(pkg.name, { size, scale: scale.toFixed(1), scaledDelay });
      maxScaledDelay = Math.max(maxScaledDelay, scaledDelay);
    }
  }

  if (scaledDelays.size > 0) {
    for (const [name, info] of scaledDelays) {
      console.log(
        `… ${name}: ${String(info.size)} bytes (${info.scale}x backoff multiplier) → ` +
          `${String(info.scaledDelay)}ms`,
      );
    }
  }

  console.log(
    `… ${String(pending.length)} version(s) not visible yet; the registry is eventually ` +
      `consistent, so waiting ${String(maxScaledDelay)}ms and re-reading before calling them unpublished`,
  );
  await sleep(maxScaledDelay);
  const stillPending = [];
  for (const pkg of pending) {
    if (registryState(pkg) === "published") {
      console.log(`✓ ${pkg.name}@${pkg.version} is on the registry (after a retry)`);
    } else {
      stillPending.push(pkg);
    }
  }
  pending = stillPending;
}

const missing = pending.length;
for (const pkg of pending) {
  console.error(`✗ ${pkg.name}@${pkg.version} was NOT published`);
}

// A push that fails after a successful publish leaves the run red and indistinguishable from one
// that published nothing — the wrong thing to conclude. An operator who concludes it would re-cut a
// release against a registry that already has the version.
const untagged = [];
const untagStateUnknown = [];
for (const pkg of packages) {
  const state = tagState(pkg);
  if (state === "tagged") continue;
  if (state.startsWith("unknown")) untagStateUnknown.push({ ...pkg, state });
  else untagged.push({ ...pkg, state });
}

for (const pkg of untagStateUnknown) {
  console.warn(`⚠ ${pkg.name}@${pkg.version}: could not read the tag — ${pkg.state}`);
}

if (untagged.length > 0 && missing === 0 && unknown === 0) {
  console.error("");
  for (const pkg of untagged) {
    console.error(`✗ ${pkg.name}@${pkg.version} WAS published, and its tag is ${pkg.state}`);
  }
  console.error(
    "\nThe publish succeeded and the tagging did not — these versions are on the registry with no\n" +
      "tag pointing at the commit they came from. This is NOT a failed release: do not re-cut it.\n" +
      "Create the tags against the commit this run published from and push them:\n" +
      untagged
        .map((p) => `    git tag -a "${p.name}@${p.version}" <sha> -m "${p.name}@${p.version}"`)
        .join("\n"),
  );
  process.exit(1);
}

if (missing > 0 || unknown > 0) {
  console.error(
    `\nThis release wrote a CHANGELOG entry for ${String(missing + unknown)} package(s) ` +
      "that are not on the registry. A green pipeline that published nothing is exactly\n" +
      "usetheokit/theokit-sdk#537 — the trusted-publisher configuration on npmjs.com is the first\n" +
      "thing worth checking.",
  );
  process.exit(1);
}
