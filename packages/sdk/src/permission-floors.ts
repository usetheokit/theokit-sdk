/**
 * The two tiers no rule and no mode can reach.
 *
 * Measured before this existed: `protectedPath` returned 0 files here and 0 in the dist, and
 * `criticalPath` the same, against a control of 31/72 on the word `hooks`.
 *
 * **Protected paths** are the circuit breaker that stops an agent editing its own configuration, the
 * git hooks, or the shell rc files. An `allow`-broad setup wrote all of them freely, and the operator
 * had no way to express the exception because the concept was absent.
 *
 * **Critical paths** are destructive operations on `/`, the home directory, the working directory
 * and its parents. The nearest analogue was `catastrophicShellReason` in `@theokit/sdk-tools`,
 * reached through an opt-in `denyCatastrophicCommands()` — and an opt-in guard is not a floor. The
 * whole point of this tier is that nothing overrides it; a function a consumer may forget to call
 * makes the guarantee a convention.
 *
 * ## Why a floor and not a deny rule
 *
 * A deny rule is ordered, and order is defeasible: it can be shadowed by a broader rule above it,
 * reordered, or simply not shipped. This is consulted BEFORE any verdict is honoured and there is no
 * rule that can reach it — the difference between "we recommend denying this" and "this cannot be
 * approved".
 *
 * ## What it deliberately does not do
 *
 * It does not gate READS. The tier is about writes and destruction; refusing reads would stop an
 * agent inspecting the repository it was pointed at, which is the work.
 *
 * It is also not a shell parser. It recognises the destructive command shapes the spec names, on the
 * arguments they name, and a determined obfuscation will get past it — `rm` reached through a
 * variable holding the command name, for instance. Saying so is the point: a floor described as
 * complete would be trusted as complete.
 *
 * @public
 */
import { homedir } from "node:os";
import { isAbsolute, normalize, parse, relative, resolve, sep } from "node:path";

import {
  CLAUDE_DIR_NAME,
  THEOKIT_DIR_LITERAL,
} from "./internal/runtime/compat/foreign-config-sources.js";

/** Where the floor is anchored. Defaults to the real environment; overridable so it is testable. */
export interface PermissionFloorContext {
  readonly cwd?: string;
  readonly home?: string;
}

/**
 * File names and directories that may never be written, wherever they appear.
 *
 * Data, not scattered conditionals, so an operator can read what is protected — the item asks for
 * exactly that, and a list somebody has to reconstruct from `if` statements is not a list.
 */
const PROTECTED_SEGMENTS: readonly string[] = [
  ".git",
  // The two agent-configuration directories come from the dialect declarations rather than being
  // spelled again here. A second copy of `.theokit` would drift from the one `paths.ts` resolves
  // against, and this list would then protect a directory the runtime no longer uses — worse than
  // not protecting it, because the gap would be invisible.
  CLAUDE_DIR_NAME,
  THEOKIT_DIR_LITERAL,
  ".ssh",
  ".gnupg",
];

const PROTECTED_FILES: readonly string[] = [
  ".envrc",
  ".npmrc",
  ".mcp.json",
  ".pre-commit-config.yaml",
  ".netrc",
];

/**
 * Tools whose call WRITES. The floor is a write-side tier, and there is no read-side equivalent.
 *
 * ## What governs a READ, stated because the asymmetry is invisible from here (B-068)
 *
 * Reads are governed by the RULE LANGUAGE and by nothing above it. `Read(path:./.env)` works, and
 * deny-before-allow ordering means a deny cannot be overtaken by a broader allow — but every one of
 * those rules has to be WRITTEN. Nothing is refused by default, and no allow rule is refused either:
 * `Read` on its own grants reading any path the process can open, including `~/.ssh/id_rsa`.
 *
 * Writes have two tiers; reads have one. A reader who finds this module and sees `PROTECTED_SEGMENTS`
 * will reasonably assume the names in it are protected, and half of that is true: `.ssh` cannot be
 * WRITTEN through any rule, and can be READ through an ordinary allow.
 *
 * ## `additionalDirectories` does not exist here
 *
 * The reference's concept is an operator WIDENING what an agent may read beyond its working
 * directory — which presupposes a fence to widen. There is no fence, so there is nothing to widen,
 * and the absence of the key reads as permissive rather than as unimplemented. Measured 2026-09-11:
 * zero occurrences in this package and zero in `@theokit/agents`.
 *
 * ## Why a fence was not added here
 *
 * Not because it is unwanted. A read fence is a security boundary, and this tier is the wrong size
 * for one: `permissionFloorReason` sees a tool name and an argument map, and a fence that matched on
 * those alone would miss every read that reaches the filesystem by another route — a shell command,
 * a plugin, an MCP server. The SDK already confines shell reads through `SandboxMode` in
 * `sandbox/`, and a second containment vocabulary at this layer would leave two answers to "may this
 * be read" that disagree at the edges. Closing it properly means deciding which layer owns the
 * boundary, which is a measured decision and not a docblock.
 */
const WRITING_TOOLS = /^(write|edit|apply_?patch|multi_?edit|notebook_?edit|create)/i;

/** Argument names that carry a path. Same declared set the rule language uses. */
const PATH_ARGS = ["file_path", "path", "notebook_path"] as const;

/** Argument names that carry a shell command. */
const COMMAND_ARGS = ["command", "cmd"] as const;

/**
 * Why this call may not be approved, or `undefined` when the floor has no objection.
 *
 * The reason NAMES the path or the target and says which tier refused, so it is not mistaken for a
 * permissions misconfiguration — an operator who reads "denied" goes looking at their rules, and
 * would not find anything wrong with them.
 */
export function permissionFloorReason(
  toolName: string,
  args: Record<string, unknown> | undefined,
  context: PermissionFloorContext = {},
): string | undefined {
  const cwd = resolve(context.cwd ?? process.cwd());
  const home = resolve(context.home ?? homedir());

  const command = firstString(args, COMMAND_ARGS);
  if (command !== undefined) {
    const target = destructiveTargetIn(command, { cwd, home });
    if (target !== undefined) {
      return (
        `refused by the critical-path floor: "${command}" is a destructive operation on ` +
        `${target}. This tier is above every permission rule and every mode — it is not a rule ` +
        `you can reorder, and nothing in your settings is misconfigured.`
      );
    }
  }

  if (!WRITING_TOOLS.test(toolName)) return undefined;
  const path = firstString(args, PATH_ARGS);
  if (path === undefined) return undefined;
  const protectedBy = protectedReasonFor(path);
  if (protectedBy !== undefined) {
    return (
      `refused by the protected-path floor: writing "${path}" would change ${protectedBy}, ` +
      `which no allow rule can pre-approve. This tier is above every permission rule; nothing in ` +
      `your settings is misconfigured.`
    );
  }
  return undefined;
}

function firstString(
  args: Record<string, unknown> | undefined,
  names: readonly string[],
): string | undefined {
  if (args === undefined) return undefined;
  for (const name of names) {
    const v = args[name];
    if (typeof v === "string") return v;
  }
  return undefined;
}

/** What makes this path protected, or `undefined`. Segment-aware: `.gitignore` is not `.git`. */
function protectedReasonFor(path: string): string | undefined {
  const segments = normalize(path)
    .split(/[\\/]+/)
    .filter((s) => s.length > 0);
  for (const segment of segments) {
    if (PROTECTED_SEGMENTS.includes(segment)) return `the ${segment} directory`;
  }
  const last = segments.at(-1);
  if (last !== undefined && PROTECTED_FILES.includes(last)) return `the ${last} file`;
  return undefined;
}

/** Destructive command verbs, matched at the start of a segment of the command line. */
const DESTRUCTIVE = /(?:^|[;&|]\s*)\s*(rm|rmdir|shred|mkfs\S*|dd)\s/;

/**
 * The critical root a destructive command targets, or `undefined`.
 *
 * Substitutions are the reason this is not a literal comparison: the spec names `$(...)` and
 * `"$VAR"/*` explicitly, and in both the dangerous argument is not present in the text being
 * matched. They are treated as UNRESOLVABLE rather than expanded — expanding would mean running the
 * substitution, and a floor that executes its input to decide whether the input is safe has the
 * problem backwards. An unresolvable target on a destructive command is refused.
 */
function destructiveTargetIn(
  command: string,
  roots: { cwd: string; home: string },
): string | undefined {
  if (!DESTRUCTIVE.test(command)) return undefined;
  if (SUBSTITUTES.test(command)) {
    return "a target this floor cannot resolve (the command substitutes or expands it)";
  }
  const critical = criticalRootsFor(roots);
  for (const token of command.split(/\s+/)) {
    const target = absoluteTargetOf(token, roots.home);
    // EQUAL, never "starts with". `/workspace-other` starts with `/work` as a string and is a
    // different directory; a floor that could not tell them apart would refuse ordinary work.
    const hit = target === undefined ? undefined : critical.get(target);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** `$(...)`, backticks and `$VAR` — the forms in which the dangerous argument is not in the text. */
const SUBSTITUTES = /\$\(|`|\$\{?\w/;

/** The critical roots, keyed by resolved path so a token is one lookup rather than a scan. */
function criticalRootsFor(roots: { cwd: string; home: string }): Map<string, string> {
  const map = new Map<string, string>([
    [resolve("/"), "the filesystem root"],
    [roots.home, "the home directory"],
  ]);
  for (const parent of ancestorsOf(roots.cwd)) {
    map.set(parent, "a parent of the working directory");
  }
  // LAST, so the working directory keeps its own label when it is also somebody's parent.
  map.set(roots.cwd, "the working directory");
  return map;
}

/**
 * One command token as an absolute path, or `undefined` when it is not one.
 *
 * Strips the quoting and a trailing `/*` glob — `rm -rf "$HOME"/*` names the home directory, and the
 * glob is what makes it destructive rather than what makes it a different target. A flag is not a
 * path, and neither is a relative token: the floor is about the named roots, and `./build` is not
 * one of them.
 */
function absoluteTargetOf(token: string, home: string): string | undefined {
  const bare = token.replace(/["']/g, "").replace(/\/\*+$/, "");
  if (bare.length === 0 || bare.startsWith("-")) return undefined;
  const expanded = bare === "~" || bare.startsWith(`~${sep}`) ? home : bare;
  return isAbsolute(expanded) ? resolve(expanded) : undefined;
}

/** Every directory above `dir`, up to and including the filesystem root. */
function ancestorsOf(dir: string): string[] {
  const out: string[] = [];
  let current = dir;
  const { root } = parse(dir);
  while (current !== root) {
    const parent = resolve(current, "..");
    if (parent === current) break;
    out.push(parent);
    current = parent;
  }
  return out;
}

/** Whether `child` is inside `parent`. Kept for callers that need the containment question. */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}
