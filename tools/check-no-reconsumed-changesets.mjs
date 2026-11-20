#!/usr/bin/env node
/**
 * Refuse a release PR that would re-release work already shipped (B-109).
 *
 * `changesets/action` runs on `push: [main]`. It opens a "Version Packages" PR into `main`, and it
 * is THAT PR which consumes the `.changeset/*.md` files and bumps every `package.json`. Nothing
 * carries either back to `develop`, so `develop` falls one release further behind on every cut.
 *
 * The drift is not merely untidy. Measured on 2026-08-11, immediately before cutting a security
 * release: `develop` was 10 commits behind `main`, still declared `4.40.0` against main's `4.41.0`,
 * and still held three changesets that `4.41.0` had already consumed. Opening `develop → main` in
 * that state would have re-added all three, and the next `changeset version` would have re-released
 * three shipped features as fresh minors with duplicated CHANGELOG entries. A wrong version on npm
 * cannot be fixed — only deprecated.
 *
 * It was avoided that day only because someone happened to look. This script is what looks.
 *
 * ## The rule
 *
 * A changeset file is CONSUMED when a "Version Packages" merge deletes it from `main`. So for every
 * `.changeset/*.md` present on the PR head, ask git whether `main` has ever deleted that exact
 * path. If it has, the file is a resurrection of shipped work rather than a new change.
 *
 * This is a question about history, not about content, which is what makes it cheap and exact — no
 * parsing of changeset bodies, no guessing at which release absorbed what.
 *
 * A legitimate new change never trips it: `changeset add` generates a fresh random name, and a name
 * main has deleted is by definition one that already went out.
 */

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The repository root, resolved from THIS FILE rather than from the caller's cwd.
 *
 * Load-bearing. Every git call below names `.changeset/`, and git resolves a pathspec relative to
 * the working directory — so running from `packages/sdk` asked about `packages/sdk/.changeset/`,
 * found nothing, and reported an empty list. For this guard, empty means "all clear": it would have
 * passed a re-release silently, from any subdirectory, which is the one failure mode a guard must
 * not have. Caught by a test running under vitest's cwd, not by reading.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * @returns stdout, trimmed. Throws with git's stderr attached, so a failure is diagnosable.
 *
 * `git` is resolved through PATH, and SonarCloud raises its "fixed, unwriteable directories"
 * hotspot on that. Reviewed and accepted, for a reason specific to where this runs: it is a
 * maintainer/CI release script in a repository whose ENTIRE toolchain arrives through PATH —
 * `pnpm`, `node`, `turbo`, `git` — and the pre-existing tools beside it (`preflight-native-bindings`,
 * `check-cycles`, `check-bundle-budget`) do the same. An attacker able to write to this
 * PATH already controls the build, so pinning an absolute `git` here moves nothing, while breaking
 * every nvm and macOS checkout where git does not live at a fixed location.
 *
 * The argument-injection half of the same rule is NOT waved away — see `assertPlainRef` below,
 * which is the real defence and is tested.
 */
function git(args, opts = {}) {
  // Reviewed above: PATH resolution is deliberate here, and `assertPlainRef` is the real defence
  // against the argument-injection half of the same rule. The marker must sit on the flagged line.
  return execFileSync("git", args, { encoding: "utf8", cwd: REPO_ROOT, ...opts }).trim(); // NOSONAR
}

/**
 * A ref that git will read as a REF and never as an option.
 *
 * The refs reaching this script come from the CI context — `github.base_ref` and the PR head sha —
 * which is data from a pull request, not from a maintainer. `execFileSync` already rules out shell
 * injection (there is no shell), but it does nothing about ARGUMENT injection: a value beginning
 * with `-` is parsed by git as a flag, so a branch named `--output=…` would be an option rather
 * than the thing being inspected.
 *
 * Two defences, because each covers what the other misses. `--end-of-options` (git ≥ 2.24) tells
 * git that everything after it is an operand, which handles flags git knows. The character check
 * rejects the value outright, which also covers older git and makes the refusal legible instead of
 * producing a confusing git error. Failing loudly beats a guard that inspects the wrong ref and
 * reports clean.
 */
function assertPlainRef(ref) {
  if (typeof ref !== "string" || ref.length === 0 || ref.startsWith("-")) {
    throw new Error(
      `refusing to inspect ${JSON.stringify(ref)}: a ref must not be empty or begin with "-", ` +
        `which git would read as an option rather than a revision`,
    );
  }
  return ref;
}

/** @returns every `.changeset/*.md` entry present at `ref` (excluding the upstream README). */
export function changesetsAt(ref) {
  assertPlainRef(ref);
  // B-120 — an unreadable ref must REFUSE, not report clean. This used to catch and return `[]`,
  // and for this guard an empty list means "nothing to worry about" — so a sha the repository does
  // not have produced the same tick as a genuinely clean release, with git's `fatal:` on stderr
  // above it. A guard whose failure mode is a green tick is worse than no guard, because it is
  // trusted.
  //
  // The two cases are distinguished by asking git to resolve the ref FIRST: a ref that resolves and
  // legitimately lists nothing still returns `[]`, which is the honest empty.
  let out;
  try {
    out = git(["ls-tree", "-r", "--name-only", "--end-of-options", ref, "--", ".changeset/"]);
  } catch (err) {
    throw new Error(
      `could not read \`${ref}\` — the repository cannot resolve it. Fetch it first ` +
        `(\`git fetch origin\`), or pass a ref this checkout has. Reporting a release as clean ` +
        `because a ref was unreadable is the one answer this guard must never give.\n` +
        `  git said: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
    );
  }
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.endsWith(".md") && !l.endsWith("README.md"));
}

/**
 * Has `baseRef` ever DELETED this path?
 *
 * `--diff-filter=D` over the base's own history answers exactly "was this consumed on the release
 * line", which is the question — not "does it exist now", which a plain `ls-tree` would answer and
 * which is true of every un-consumed changeset too.
 */
export function wasDeletedOn(baseRef, path) {
  assertPlainRef(baseRef);
  try {
    return (
      git(["log", "--diff-filter=D", "--format=%H", "--end-of-options", baseRef, "--", path])
        .length > 0
    );
  } catch {
    return false;
  }
}

/**
 * @returns the changeset paths on `headRef` that `baseRef` has already consumed. Empty means the PR
 *   is safe to merge as far as this check is concerned.
 */
export function reconsumedChangesets(baseRef, headRef) {
  return changesetsAt(headRef).filter((p) => wasDeletedOn(baseRef, p));
}

/**
 * The release line a promotion base must also be checked against (#863). The "Version Packages"
 * PR that consumes changesets merges into `main`, so for a PR into `develop` the deletion never
 * lands on the base and `wasDeletedOn(base)` cannot see it. `origin/develop` maps to `origin/main`,
 * `develop` to `main`. Returns null when the base is not a develop branch.
 */
export function releaseRefFor(baseRef) {
  const m = /^(.*\/)?develop$/.exec(baseRef);
  return m ? `${m[1] ?? ""}main` : null;
}

/** @returns true when `ancestor` is already contained in `descendant`. */
export function isAncestor(ancestor, descendant) {
  assertPlainRef(ancestor);
  assertPlainRef(descendant);
  try {
    git(["merge-base", "--is-ancestor", "--end-of-options", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

/** Refuse (throw) when `ref` cannot be resolved: a missing release ref must not read as clean. */
function assertResolvable(ref) {
  assertPlainRef(ref);
  try {
    git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
  } catch {
    throw new Error(
      `could not read \`${ref}\` — the repository cannot resolve it. Fetch it first ` +
        `(\`git fetch origin\`). A develop promotion is also checked against ${ref}, because that is ` +
        `where "Version Packages" consumes changesets; skipping it would report released work as clean.`,
    );
  }
}

/** @returns [{ ref, paths }] for the base and, for a develop base, the release line. */
export function reconsumedByRef(baseRef, headRef) {
  const refs = [baseRef];
  const release = releaseRefFor(baseRef);
  if (release) {
    assertResolvable(release);
    refs.push(release);
  }
  return refs.map((ref) => ({ ref, paths: reconsumedChangesets(ref, headRef) }));
}

function fixHint(ref, head) {
  return isAncestor(ref, head)
    ? `${ref} is already merged into ${head}, so a back-merge changes nothing: delete the listed\n` +
        `  files from ${head} (\`git rm\`).`
    : `back-merge ${ref} into ${head} first, which deletes the consumed files.`;
}

function main() {
  const base = process.argv[2] ?? "origin/main";
  const head = process.argv[3] ?? "HEAD";

  let results;
  try {
    results = reconsumedByRef(base, head);
  } catch (err) {
    // A rejected ref is a legible refusal, not a crash. Exit 2 distinguishes "could not check"
    // from exit 1's "checked, and it is unsafe".
    console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
  const hits = results.filter((r) => r.paths.length > 0);
  if (hits.length === 0) {
    console.log(
      `✓ no changeset on ${head} has already been consumed by ${results.map((r) => r.ref).join(" or ")}`,
    );
    return;
  }

  console.error(`\n✗ this merge would RE-RELEASE work already shipped\n`);
  for (const { ref, paths } of hits) {
    console.error(
      `  ${paths.length} changeset file(s) on ${head} were already consumed by a\n` +
        `  "Version Packages" merge on ${ref}:\n`,
    );
    for (const p of paths) console.error(`    ${p}`);
    console.error(`\n  Fix: ${fixHint(ref, head)}\n`);
  }
  console.error(
    `  Merging this would make the next \`changeset version\` publish those changes again as\n` +
      `  fresh versions, with duplicated CHANGELOG entries. A wrong version on npm cannot be\n` +
      `  fixed, only deprecated.\n`,
  );
  process.exit(1);
}

if (process.argv[1]?.endsWith("check-no-reconsumed-changesets.mjs")) {
  main();
}
