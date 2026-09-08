/**
 * Path resolution for SDK state files (ADR D60).
 *
 * Theokit anchors state at `<cwd>/.theokit/` by default (per-cwd). An
 * optional `THEOKIT_HOME` environment variable overrides this, enabling
 * test isolation, profile switching, and multi-tenant deployments.
 *
 * Rules:
 *   - `getTheokitHome(cwd)` is the canonical resolver **for cwd-anchored state**. Never hardcode
 *     `path.join(cwd, ".theokit")` in callers — use this function so tests
 *     and overrides stay consistent.
 *
 *     M94 — this comment said "the ONLY canonical resolver", and stopped being true: the
 *     transcript gained `transcriptRoot()`, which is **home-anchored** (`~/.theokit`) with the same
 *     `THEOKIT_HOME` override. The two defaults differ on purpose — unifying would move the
 *     transcript of everyone who does NOT set the variable, which is a data migration and not a
 *     re-export.
 *
 *     A consequence worth writing down: **without `THEOKIT_HOME` the state stays split in two**
 *     — registry in `<cwd>/.theokit`, transcript in `~/.theokit`. M94 unifies only for those who set
 *     the variable. Unifying both defaults is another milestone's work.
 *   - `getProfilesRoot()` is intentionally home-anchored (not affected by
 *     `THEOKIT_HOME`) so `theokit profile list` discovers all profiles
 *     regardless of which is active.
 *   - `displayTheokitHome(cwd)` returns a human-readable path for logs.
 *
 * @internal
 */

import { homedir } from "node:os";
import { join } from "node:path";

import {
  adaptersForSurface,
  type CompatSourceDeclaration,
  type CompatSurface,
  THEOKIT_DIR_LITERAL,
} from "../runtime/compat/foreign-config-sources.js";

// The directory names live with the dialect registry that owns them — a name is one third of what a
// configuration dialect is, and keeping the three together is what stops the next one shipping
// without its runtime contract (#522).

/**
 * Resolve the directory cwd-anchored SDK state lives in.
 *
 * `THEOKIT_HOME` wins when it is set and not blank after trimming; the trimmed value is used, and
 * it is used VERBATIM — it is not resolved against `cwd`, so a relative value stays relative and
 * `.theokit` is not appended to it. Otherwise the answer is `<cwd>/.theokit`.
 *
 * The environment is read on every call, so a change to the variable takes effect immediately
 * rather than being frozen at import.
 *
 * This creates nothing and checks nothing: the returned path may not exist, and the caller owns
 * the `mkdir`. Call it instead of writing `join(cwd, ".theokit")` by hand, or the override stops
 * working for that one call site and tests silently touch the real home.
 *
 * Not the whole story about where state lives — the transcript is home-anchored via
 * `transcriptRoot()`, honoring the same variable but defaulting to `~/.theokit`. With
 * `THEOKIT_HOME` unset, state is genuinely split between two roots.
 *
 * Semver-exempt: reachable via the `@theokit/sdk/internal/persistence` sub-path, which the package
 * declares in `exports` but does NOT cover with its semver contract.
 */
export function getTheokitHome(cwd: string): string {
  const override = process.env.THEOKIT_HOME?.trim();
  if (override !== undefined && override.length > 0) {
    return override;
  }
  return join(cwd, THEOKIT_DIR_LITERAL);
}

/**
 * The project's own configuration root: `<cwd>/.theokit`, always — never `THEOKIT_HOME`.
 *
 * `THEOKIT_HOME` relocates cwd-anchored SDK STATE (sessions, credentials). A project's
 * CONFIGURATION belongs to the repository: hooks, MCP servers, context sources, subagents, the
 * personality a project declares, all committed to git and shared by a team. Following the
 * override for any of them would move where a project's declared capabilities come from — a
 * behaviour change wearing the costume of a refactor, which is exactly what this function exists
 * to make impossible to do by accident: every config-class reader calls this instead of writing
 * `join(cwd, ".theokit")` by hand.
 *
 * NOT for the `.claude/`-style foreign roots {@link adaptersForSurface} adds — those are additive,
 * opt-in, and each has its own directory name.
 *
 * Semver-exempt: reachable via the `@theokit/sdk/internal/persistence` sub-path, which the package
 * declares in `exports` but does NOT cover with its semver contract.
 */
export function theokitConfigRoot(cwd: string): string {
  return join(cwd, THEOKIT_DIR_LITERAL);
}

/**
 * Every directory a project's configuration may be read from, in precedence order.
 *
 * `.theokit` first — via {@link theokitConfigRoot}, so it is NEVER affected by `THEOKIT_HOME` for
 * the reason documented there — then `.claude`. The order is the whole contract: a project that
 * declares a skill, agent or rule in both means the explicit namespace to win, and a caller merging
 * these roots must therefore keep the FIRST occurrence of a name rather than the last.
 *
 * `.claude` is read because the formats already agree and only the location did not. Measured
 * 2026-08-26: the SKILL.md frontmatter this SDK requires (`name` + `description`) is exactly what
 * the CLI writes, its hook config is the same JSON shape, and 59 of the CLI's agent declarations
 * parse here unchanged. A repository set up for the CLI was failing on the directory name alone.
 *
 * NOT a rename of `.theokit`, and not a migration. Both are read, so nothing that works today stops
 * working — which is why this returns a LIST and not a single resolved answer.
 *
 * Creates nothing and checks nothing; either path may not exist, and the caller owns that.
 *
 * Semver-exempt: reachable via the `@theokit/sdk/internal/persistence` sub-path, which the package
 * declares in `exports` but does NOT cover with its semver contract.
 */
export function projectConfigRoots(
  cwd: string,
  sources: readonly CompatSourceDeclaration[],
  surface: CompatSurface,
): string[] {
  const own = nativeAdmitsSurface(sources, surface) ? [theokitConfigRoot(cwd)] : [];
  return [
    ...own,
    ...adaptersForSurface(foreignOnly(sources), surface).map((a) => join(cwd, a.dirName)),
  ];
}

/** The kind a consumer names to declare THIS package's own root. */
const NATIVE_KIND = "theokit";

/**
 * #631 — whether the native root contributes `surface`.
 *
 * Undeclared means every surface, which is what this function returned unconditionally before and
 * is what every existing caller gets. A consumer that names the kind is opting into the same
 * per-surface contract a foreign dialect already has, and the defaults match on purpose: a bare
 * string admits everything, an object admits exactly what its `import` lists. Two vocabularies that
 * look identical and disagree about the default would be worse than one.
 *
 * The asymmetry this closes had a measured cost. `hookConfigCandidates` reads `settings.json` from
 * every root, so a consumer keeping its own configuration in `.theokit/settings.json` had that
 * file's `hooks` key executed by this package, and `settingSources` gave it no way to decline: it
 * grants a foreign dialect per SOURCE, not per surface, so dropping `claude-code` to avoid its
 * hooks would also drop its skills, agents and rules.
 */
function nativeAdmitsSurface(
  sources: readonly CompatSourceDeclaration[],
  surface: CompatSurface,
): boolean {
  const declared = sources.filter((s) => (typeof s === "string" ? s : s.kind) === NATIVE_KIND);
  if (declared.length === 0) return true;
  return declared.some((s) => (typeof s === "string" ? true : (s.import ?? []).includes(surface)));
}

/**
 * The native declaration is consumed here and must not reach `adaptersForSurface`, which resolves
 * kinds to FOREIGN adapters. It would be dropped there as unrecognised — harmlessly, today — but
 * relying on that would make this behaviour depend on another function failing to find something,
 * which is the kind of coupling that breaks the moment an adapter of that name is added.
 */
function foreignOnly(
  sources: readonly CompatSourceDeclaration[],
): readonly CompatSourceDeclaration[] {
  return sources.filter((s) => (typeof s === "string" ? s : s.kind) !== NATIVE_KIND);
}

/**
 * Every directory that may hold a plugin BUNDLE contributed by the Claude Code CLI.
 *
 * A CLI plugin is not a JS entry point — it is a folder whose `skills/` and `agents/` are what it
 * exists to provide. Measured 2026-08-26 on an installed one: seven agents and three skills beside
 * a manifest in `.claude-plugin/plugin.json`. Parsing that manifest and stopping there produced a
 * plugin that loaded and did nothing.
 *
 * Project-scoped deliberately. The CLI also keeps plugins under `~/.claude/plugins/cache`, behind
 * its own installer and enable/disable state — reproducing that is an installation system, not
 * reading a project's configuration, and guessing at someone's enablement would run code they
 * turned off.
 */
export function pluginBundleRoots(
  cwd: string,
  sources: readonly CompatSourceDeclaration[],
): string[] {
  // Always the `plugins` surface, including when the caller wants the SKILLS a bundle carries.
  // A bundle is code, and its skills arrive attached to it: admitting `skills` alone must not
  // reach inside a foreign plugin directory, or the narrower permission would silently grant the
  // wider one. `skills-manager` and `subagents-loader` both read bundle contents and both go
  // through here, so the rule holds in one place rather than three.
  return projectConfigRoots(cwd, sources, "plugins").map((root) => join(root, "plugins"));
}

/**
 * The directory holding every profile: always `~/.theokit/profiles`, from `os.homedir()`.
 *
 * Deliberately NOT affected by `THEOKIT_HOME`, which is the one thing to remember about it. If it
 * followed the override, a session pointed at one profile would only be able to see that profile,
 * and `theokit profile list` could never enumerate the rest. Profiles are the thing the override
 * switches between, so their index cannot live behind it.
 *
 * Takes no `cwd` for the same reason. Creates nothing; the path may not exist.
 *
 * Semver-exempt: reachable via the `@theokit/sdk/internal/persistence` sub-path, which the package
 * declares in `exports` but does NOT cover with its semver contract.
 */
export function getProfilesRoot(): string {
  return join(homedir(), THEOKIT_DIR_LITERAL, "profiles");
}

/**
 * The same path `getTheokitHome(cwd)` returns, shortened for display: the home directory prefix
 * collapses to `~`, so `/home/ada/.theokit` prints as `~/.theokit`.
 *
 * For humans only — log lines, CLI output, error messages. The result is NOT a usable path: `~`
 * is a shell convention that `fs` does not expand, so passing this to a filesystem call resolves
 * a literal directory named `~` relative to the process cwd. Use `getTheokitHome` for anything
 * that touches disk.
 *
 * Collapsing is a prefix match on the home directory followed by a literal `/`, so a sibling like
 * `/home/adalovelace` is left alone even though `/home/ada` is a string prefix of it. A path
 * outside the home directory comes back unchanged — and so does a Windows path, where the
 * separator is a backslash and the prefix test therefore never matches.
 *
 * Semver-exempt: reachable via the `@theokit/sdk/internal/persistence` sub-path, which the package
 * declares in `exports` but does NOT cover with its semver contract.
 */
export function displayTheokitHome(cwd: string): string {
  const resolved = getTheokitHome(cwd);
  const home = homedir();
  if (resolved === home) return "~";
  if (resolved.startsWith(`${home}/`)) {
    return `~${resolved.slice(home.length)}`;
  }
  return resolved;
}
