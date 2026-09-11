import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CompatSurface } from "../../../types/agent.js";
import { diagFailure } from "../../diagnostics.js";

/*
 * The foreign configuration dialects this SDK can read, and what each one PRESUMES.
 *
 * ## Why a registry and not a list of directory names
 *
 * `projectConfigRoots` returned `[".theokit", ".claude"]` — two paths — and that shape is what
 * usetheokit/theokit-sdk#522 fell through. A path says WHERE a file lives. It does not say how the
 * file is parsed, and it does not say what runtime the commands inside it were written against.
 *
 * Claude Code defines `$CLAUDE_PROJECT_DIR` for the hook commands in its `settings.json`, and its
 * documentation tells authors to reach project files through it — an absolute path would break for
 * every other person on the team, so the shape that failed here is the shape upstream recommends.
 * This SDK read the file and ran the command without the variable. `sh` expands an unset variable to
 * the empty string, so
 *
 *     bash "$CLAUDE_PROJECT_DIR/.claude/hooks/guard.sh"   became   bash "/.claude/hooks/guard.sh"
 *
 * which does not exist, which a hook runner correctly reads as a refusal. Every turn denied, in any
 * repository that also had Claude Code set up, with a message naming a file that was present and
 * executable all along.
 *
 * Importing a format means accepting the contract that format presumes. An adapter is where that
 * contract is written down, so the next dialect (`.codex/` is the obvious one) declares its own
 * instead of inheriting a hole.
 *
 * ## What an adapter deliberately does NOT do
 *
 * It does not make the foreign source trusted, and it does not make its hooks permissive: a script
 * that exits non-zero is still a refusal. It supplies the variables the format's authors were
 * entitled to assume, and nothing else — `env` here is merged over the scrubbed inherit policy by
 * `spawnAndCollect`, so it adds names rather than widening what a child can see.
 *
 * @internal
 */

/**
 * The project config directory literal.
 *
 * Renamed from `THEOKIT_DIR_NAME` in #410. Sharing a name with the (now removed) sovereign env var
 * was the MECHANISM of that defect, not scenery: every grep for the variable landed on that const
 * and looked answered, so "is it read?" returned five hits and nobody checked what they were.
 *
 * Lives here rather than in `persistence/paths.ts` because a directory name is one third of what a
 * dialect is — the other two being how it parses and what it presumes — and splitting the three
 * across two modules is what let the third go unwritten.
 */
export const THEOKIT_DIR_LITERAL = ".theokit";

/** The Claude Code CLI's project configuration directory. */
export const CLAUDE_DIR_NAME = ".claude";

/** A configuration dialect this SDK understands. `theokit` is native; the rest are foreign. */
export interface ConfigSourceAdapter {
  /** Stable identifier, and what a consumer names to opt in. */
  readonly kind: string;
  /** The project-relative directory the dialect keeps its configuration in. */
  readonly dirName: string;
  /**
   * Variables the dialect's own runtime defines for commands it executes, under the dialect's own
   * documented spellings.
   *
   * Every dialect gets a project-directory variable, because none of them can locate a
   * project-relative script without one — the inherited environment says where the PROCESS is, and
   * a hook that has to depend on the process cwd is the dependency #522 removed for the foreign
   * side. Fixing one dialect and leaving the other different was the half-fix.
   *
   * The SPELLINGS differ on purpose: a ported script reaches for the name its own docs use, and a
   * native one for this runtime's.
   */
  runtimeEnv(cwd: string): Record<string, string>;
}

/**
 * The native source. Always read, never opted into, always first for precedence.
 *
 * `THEOKIT_PROJECT_DIR` is the native counterpart of `CLAUDE_PROJECT_DIR` below. This used to be
 * `{}`, on the reasoning that a `.theokit/` hook "is written against THIS runtime and inherits it
 * already" — true of the runtime's BEHAVIOUR and not of a project PATH. Nothing in the inherited
 * environment says where the project is, so a native hook had to depend on the process cwd.
 */
export const NATIVE_SOURCE: ConfigSourceAdapter = {
  kind: "theokit",
  dirName: THEOKIT_DIR_LITERAL,
  runtimeEnv: (cwd) => ({ THEOKIT_PROJECT_DIR: cwd }),
};

/**
 * Claude Code.
 *
 * `CLAUDE_PROJECT_DIR` is the documented way for a hook command in `settings.json` to reach a file
 * in the project. Only that one variable is supplied: `$CLAUDE_PLUGIN_ROOT` and the rest of that
 * runtime's surface are NOT defined here, because supplying a name whose value this SDK would have
 * to invent is worse than leaving it unset — an invented root sends a script somewhere real and
 * wrong, where an unset one fails loudly.
 */
export const CLAUDE_CODE_SOURCE: ConfigSourceAdapter = {
  kind: "claude-code",
  dirName: CLAUDE_DIR_NAME,
  runtimeEnv: (cwd) => ({ CLAUDE_PROJECT_DIR: cwd }),
};

const FOREIGN_SOURCES: readonly ConfigSourceAdapter[] = [CLAUDE_CODE_SOURCE];

const BY_DIR_NAME: ReadonlyMap<string, ConfigSourceAdapter> = new Map(
  [NATIVE_SOURCE, ...FOREIGN_SOURCES].map((a) => [a.dirName, a]),
);

/**
 * The adapters a caller declared, in declaration order, skipping any name that names no adapter.
 *
 * An unknown name is DROPPED rather than turned into `<cwd>/<name>`: a typo must fail closed. Making
 * a directory out of an unrecognised string would import a dialect nothing knows how to parse — and
 * the whole reason this exists is that a directory name was never enough to describe a dialect.
 */
export function adaptersFor(kinds: readonly string[]): ConfigSourceAdapter[] {
  const byKind = new Map(FOREIGN_SOURCES.map((a) => [a.kind, a]));
  const out: ConfigSourceAdapter[] = [];
  for (const kind of kinds) {
    const adapter = byKind.get(kind);
    if (adapter !== undefined && !out.includes(adapter)) out.push(adapter);
  }
  return out;
}

/**
 * #586 — re-exported from `types/agent.ts` rather than declared here, which is what it used to be.
 *
 * Two independent declarations of one public contract: `AgentOptions.local.compatSources` was typed
 * by the public one, `persistence/paths.ts` by this one, and neither imported the other. Measured:
 * adding a member to one alone produced ZERO type errors, because structurally-identical unions
 * compare equal and the two halves would simply stop agreeing about which surfaces exist.
 *
 * Neither direction of that drift raises anything. Widen the public type and a caller declares a
 * surface the admission logic ignores; widen this one and the loader admits a surface no public
 * caller can name. Both produce a declaration that reads as honoured and is not — the failure #524
 * exists to prevent, one layer down.
 *
 * `types/` is a leaf by design (theokit#146), so the public declaration is the one that stays and
 * this module imports it. The docblock that lived here — a skill is text entering the system prompt,
 * a hook is command execution, a plugin is code loading — is on the declaration in `types/agent.ts`.
 */
export type { CompatSurface };

/**
 * The runtime list. A type cannot be enumerated at runtime, so this is the one place the members are
 * written twice by necessity — and {@link assertCompatSurfacesExhaustive} below is what stops that
 * second copy from being a second source of truth.
 *
 * `as const satisfies` rather than an annotation, and the difference is the whole guard: annotating
 * it `readonly CompatSurface[]` widens each entry back to `CompatSurface`, so the check below
 * compares a type against itself and passes on any drift. Measured on the first attempt — a member
 * added to the public type alone produced zero errors. `satisfies` keeps the literals while still
 * rejecting an entry that is not a surface, which is both directions at once.
 */
const COMPAT_SURFACES = [
  "hooks",
  "plugins",
  "skills",
  "subagents",
] as const satisfies readonly CompatSurface[];

/**
 * Compile-time guard: adding a member to {@link CompatSurface} without adding it to
 * {@link COMPAT_SURFACES} fails `tsc` here.
 *
 * Never called. It exists so the pairing is checked by the compiler rather than by whoever
 * remembers — which is the entire lesson of #586, applied to the copy that could not be removed.
 */
function assertCompatSurfacesExhaustive(surface: CompatSurface): (typeof COMPAT_SURFACES)[number] {
  return surface;
}
void assertCompatSurfacesExhaustive;

/**
 * A declared foreign source: a bare kind, or a kind with the surfaces it may be read for.
 */
export type CompatSourceDeclaration =
  | string
  | { readonly kind: string; readonly import?: readonly string[] };

/**
 * The adapters admitted to ONE surface.
 *
 * Three rules, and each one fails closed:
 *
 * - A bare string admits every surface. It is what `5.0.0-next.1` published, so narrowing it
 *   silently would turn a working opt-in into a no-op — the exact defect #524 is about, one level
 *   up.
 * - An object with no `import` admits nothing. The issue's own rule, and safe to apply strictly
 *   because the object form is new and nobody can be depending on it.
 * - An unrecognised surface name is dropped rather than matched loosely, for the same reason an
 *   unrecognised KIND is dropped in {@link adaptersFor}: a typo must not silently widen access.
 */
export function adaptersForSurface(
  sources: readonly CompatSourceDeclaration[],
  surface: CompatSurface,
): ConfigSourceAdapter[] {
  const admitted: string[] = [];
  for (const source of sources) {
    if (typeof source === "string") {
      admitted.push(source);
      continue;
    }
    const wanted = source.import ?? [];
    if (wanted.some((s) => s === surface && COMPAT_SURFACES.includes(s as CompatSurface))) {
      admitted.push(source.kind);
    }
  }
  return adaptersFor(admitted);
}

/**
 * The adapter whose directory an absolute config path sits under, or `undefined` for a path that
 * belongs to no registered dialect.
 *
 * Matched on the path SEGMENT rather than with `includes`, so a workspace that happens to live under
 * `/home/me/.claude-backups/repo` does not read as a Claude Code source.
 */
export function adapterForConfigPath(path: string): ConfigSourceAdapter | undefined {
  for (const segment of path.split(/[\\/]/)) {
    const adapter = BY_DIR_NAME.get(segment);
    if (adapter !== undefined) return adapter;
  }
  return undefined;
}

/**
 * Variable references in a shell command that nothing will define.
 *
 * The second half of #522, and the half that cost the debugging session. `sh` expands an unset
 * variable to the empty string and says nothing, so the failure surfaces ten characters later as a
 * path: `bash: /.claude/hooks/guard.sh: No such file or directory` — which reads as "your script is
 * missing" while the script is present and executable. Nothing in that message contains the name of
 * the variable that was actually missing, so the reader looks in the wrong place.
 *
 * Checked against BOTH the process environment and the variables the dialect supplies, because
 * either is a legitimate source: a hook may reasonably use `$HOME`.
 *
 * ## What it deliberately does not try to be
 *
 * This is not a shell parser. It finds `$NAME` and `${NAME}` outside single quotes, which is the
 * shape a config file's hook commands take. It does NOT understand `${NAME:-default}` (a default
 * makes the variable optional, so it is not reported), assignments earlier in the same command, or
 * variables a sourced script exports. A false NEGATIVE there costs the old behaviour — the confusing
 * path error — and a false positive would deny a hook that would have worked, so the parse errs
 * toward silence and the check only ever ADDS a name to a failure that already happened.
 */
export function undefinedVariablesIn(
  command: string,
  supplied: Readonly<Record<string, string>>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  // Single-quoted spans are literal in `sh`: `echo '$FOO'` prints the dollar sign.
  const unquoted = command.replace(/'[^']*'/g, " ");
  const names = new Set<string>();
  for (const match of unquoted.matchAll(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
  )) {
    const name = match[1] ?? match[2];
    if (name === undefined) continue;
    if (name in supplied) continue;
    if (env[name] !== undefined) continue;
    names.add(name);
  }
  return [...names];
}

/**
 * Workspaces already reported, so repeated agent construction in one process says it once.
 *
 * Keyed by the resolved directory rather than by dialect kind, so a long-lived host that drives
 * several workspaces still reports each of them.
 */
const reported = new Set<string>();

/**
 * Reports a foreign configuration directory that exists in the workspace and was not declared.
 *
 * ## Why the flip needs a voice
 *
 * Before #524 a `.claude/` was read with no opt-in; after it, the same directory is ignored. From
 * inside the repository the two states are indistinguishable — the hook file is there, it is
 * executable, and it does not run. The only remaining way to learn why is a CHANGELOG entry for a
 * version the reader may not know they crossed.
 *
 * ## Why `diagFailure` rather than `diag` (#563)
 *
 * This used `diag`, on the reasoning that ignoring an undeclared directory is not a failure and
 * that a repository which does NOT want the import should not pay a stderr line for behaving as
 * instructed. The reasoning was sound and rested on a premise nobody checked: that a host would
 * have installed a sink.
 *
 * Measured against the published `5.0.0`. `diag` returns without doing anything when no sink is
 * installed. The SDK installs none — `currentSink()` reads a `globalThis` slot only
 * `setDiagnosticsSink` fills. Neither observable host installs one either: `theocode` renamed the
 * key, and `theokit` exports `installDiagnosticSink` and never calls it. Two hosts out of two, and
 * the SDK itself. So the message the CHANGELOG promised — "says so once, on the diagnostics
 * channel" — reached nobody, while the consumer lost hooks, skills, subagents and plugins.
 *
 * A mitigation announced in release notes for a silent loss of capability is not a diagnostic. It
 * is the error path of the breaking change itself, and `diagFailure` exists for exactly the message
 * that must not be swallowed.
 *
 * The cost the old reasoning named is real and is now paid: a repository that wants the directory
 * ignored sees a line. What makes that acceptable — ONCE per directory per process, not per turn
 * (`reported` below); and before #524 that repository was having `.claude/` imported anyway, so the
 * line it now sees confirms the fix it wanted. The asymmetry is one line of text against silently
 * losing four subsystems.
 *
 * A host that installs a sink still owns its render surface: `diagFailure` prefers the sink and
 * only falls back to stderr when there is none.
 *
 * NOT solved here: there is no way to say "I know, and I want none". `compatSources: []` would be
 * the natural spelling, but `resolveCompatSources` collapses it into the same `[]` an absent option
 * produces, so this function cannot tell them apart. If the noise turns out to matter, threading
 * that distinction through is the shape of the fix.
 */
export function reportUndeclaredSources(
  cwd: string,
  declared: readonly CompatSourceDeclaration[],
): void {
  // A kind named with a NARROW import list has still been declared: the consumer knows the
  // directory is there and chose which surfaces to admit. Warning them anyway would be the noise
  // that gets a warning ignored, and this one has exactly one job — telling somebody who does NOT
  // know the directory is being skipped.
  const declaredKinds = new Set(
    adaptersFor(declared.map((d) => (typeof d === "string" ? d : d.kind))).map((a) => a.kind),
  );
  for (const adapter of FOREIGN_SOURCES) {
    if (declaredKinds.has(adapter.kind)) continue;
    const dir = join(cwd, adapter.dirName);
    if (!existsSync(dir)) continue;
    if (reported.has(dir)) continue;
    reported.add(dir);
    // THE FILE IS NAMED FIRST because it is the entry point this message's reader can use.
    //
    // #524 gives the declaration two entry points for one shape: `.theokit/config.json`'s
    // `compat.adapters`, and `local.compatSources` in code. Until this change the warning named
    // only the second — and `local` is an argument the SDK's EMBEDDER passes, not something the
    // person reading the line can reach. Reported by the `theocode` session against 5.0.1: a user
    // of a host that embeds this SDK is told to pass an option that does not exist on their
    // surface, which is advice that is true about the mechanism and unusable as an action.
    //
    // The file is writable by anyone holding the workspace, which is exactly who sees this line.
    //
    // WHAT THIS LINE CANNOT KNOW, and it is a real limit rather than a caveat for form's sake. It
    // reports one fact: this SDK is ignoring the directory because nothing declared it. A HOST
    // embedding the SDK may be withholding the same directory for its own reasons — `theocode`
    // gates repository configuration on a trust posture — and the SDK cannot see that gate.
    //
    // So in a host that is also withholding, following this advice makes the warning stop and
    // changes nothing the user can do. That silence is honest about the SDK (it did stop ignoring
    // the directory) and uninformative about the outcome. Measured by the `theocode` session with
    // the control that settles it: a NATIVE `.theokit/` hook does not fire there either, so the
    // host's gate — not this declaration — is what holds the capability back.
    //
    // Nothing here can fix that. If a host ever gains a way to say "I am withholding this too",
    // this is the line where that belongs.
    diagFailure(
      `[theokit] ${adapter.dirName}/ is present but not declared, so its hooks, skills, subagents ` +
        `and plugins are ignored. To read it, add ` +
        `{"compat":{"adapters":["${adapter.kind}"]}} to .theokit/config.json — or, if you embed ` +
        `this SDK, pass local: { compatSources: ["${adapter.kind}"] } ` +
        `(usetheokit/theokit-sdk#524).\n`,
    );
  }
}
