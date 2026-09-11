/**
 * The OPERATOR tier: settings an organisation deploys to a machine, which the project and the code
 * below it cannot switch off.
 *
 * Claude Code defines `managed-settings.json` as settings a user "cannot override, except for
 * limited exceptions". This SDK read no such file — measured, `grep -rl managed-settings` returned
 * 0 here, 0 in the 4.52.1 dist and 0 in the 5.5.0 dist, against a control of 31 files for `hooks`.
 * An organisation that deployed a policy got it dropped in silence, while the same file was enforced
 * by the tool it was written for.
 *
 * That is not an incomplete feature. The failure direction is PERMIT.
 *
 * ## The decision this implements
 *
 * Recorded in `packages/agents/README.md` § "Who decides policy": an operator who did not write the
 * code CAN impose policy on it. Hooks, MCP servers, permissions and skill execution used to be
 * values the PROGRAMMER passed at build time — defensible for a framework, indefensible for anything
 * an organisation deploys, because the person answerable for what an agent may do on a machine had
 * no way to say so.
 *
 * Precedence, highest first:
 *
 *   managed-settings.json   → the operator
 *   .claude/settings.json   → the project
 *   defineAgent({ … })      → the programmer
 *
 * @internal
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:process";

import { diagFailure } from "../../diagnostics.js";

/**
 * What an operator may impose. One key today, and the shape is the point: each addition is a control
 * that already exists somewhere below and is being lifted into a tier the project cannot reach.
 *
 * Deliberately NOT a passthrough of arbitrary keys. A policy file whose unknown keys were carried
 * along would let an organisation believe it had imposed something this runtime never reads — the
 * exact belief-in-an-absent-protection this tier exists to remove.
 */
export interface ManagedSettings {
  /**
   * Refuse to execute the `` !`command` `` form in a skill or command body.
   *
   * A skill is a markdown file a repository can carry, and its body can run shell at expansion time.
   * Without this the only way to decline was to stop reading skills entirely.
   */
  disableSkillShellExecution?: boolean;
  /**
   * The permission posture the operator imposes on every run.
   *
   * `plan` is the one this exists for: an explore-only posture where edits are structurally refused.
   * A `createPlanModeTool` already existed and it is a tool the MODEL may call — the difference is
   * who decides. A never-prompt posture (`bypass`) is the other end, for a locked-down CI run where
   * there is nobody to ask.
   *
   * It does NOT reach the standing-grant gate. `bypass` allows what the RULES would have asked
   * about; a grant an operator recorded is not the run's to clear.
   */
  permissionMode?: "default" | "plan" | "acceptEdits" | "bypass";
  /**
   * The permission policy, as rule strings an operator writes and reviews.
   *
   * `{ "permissions": { "deny": ["Read(path:./.env)"] } }` — the spec's own paste-ready
   * secret-exclusion example, which could not be expressed at all while every policy was a compiled
   * predicate. Parsed by `parsePermissionRules` into the rules `PermissionEngine` already evaluates;
   * the engine is unchanged and keeps its fail-closed default and its immune-to-un-deny explicit
   * deny.
   */
  permissions?: {
    readonly deny?: readonly string[];
    readonly ask?: readonly string[];
    readonly allow?: readonly string[];
  };
  /**
   * Refuse to run ANY hook, whatever the project declared.
   *
   * The first control lifted, because it is the one whose absence is hardest to notice: a hook that
   * does not run looks identical to a hook that ran and approved.
   */
  disableAllHooks?: boolean;
}

/** Keys this runtime actually reads. Anything else in the file is reported, never carried. */
const KNOWN_KEYS = new Set<keyof ManagedSettings>([
  "disableAllHooks",
  "disableSkillShellExecution",
  "permissions",
  "permissionMode",
]);

/**
 * Where the platform keeps its managed settings.
 *
 * `root` exists so the precedence rule is testable: the real directories are platform-owned and a
 * test must not write to `/etc`. Hard-coding the path inside the reader would make the thing that
 * actually matters — that a project cannot override this file — unreachable by any test not running
 * as root.
 *
 * The paths are Claude Code's own, because the file is Claude Code's format: an organisation that
 * already deployed one should not have to deploy a second copy under a different name to get the
 * same policy honoured here.
 */
export function managedSettingsPathFor(root?: string): string {
  if (root !== undefined) return join(root, "claude-code", "managed-settings.json");
  if (platform === "darwin") {
    return "/Library/Application Support/ClaudeCode/managed-settings.json";
  }
  if (platform === "win32") {
    const programData = process.env.PROGRAMDATA ?? "C:\\ProgramData";
    return join(programData, "ClaudeCode", "managed-settings.json");
  }
  return "/etc/claude-code/managed-settings.json";
}

/**
 * Read the deployed policy, or `{}` when none is.
 *
 * Absent is the ordinary case and not an error — most machines have no operator tier, and a reader
 * that failed without one would make the feature a prerequisite for running at all.
 *
 * A file that EXISTS and cannot be read is different, and says so — through `diagFailure`, not
 * `diag`. `diag` returns immediately when no sink is installed, and most consumers never install
 * one: an organisation that deployed a policy with a typo in it would get complete silence, which is
 * the same defect this repository just fixed for dropped hook events. A policy channel that is
 * silent by default reports nothing about the one thing the tier exists to make certain. An organisation that deployed a
 * policy and got silence would believe it applied; that belief is what this tier removes.
 *
 * SYNC for the same reason `readCompatConfigFile` is: the caller resolves this before any submanager
 * exists to await a promise, and a once-per-agent read of one small file is the same class of work.
 */
export function readManagedSettings(root?: string): ManagedSettings {
  const path = managedSettingsPathFor(root);
  const parsed = readPolicyDocument(path);
  if (parsed === undefined) return {};

  const out: ManagedSettings = {};
  for (const [key, value] of Object.entries(parsed)) {
    applyPolicyKey(out, key, value, path);
  }
  return out;
}

/**
 * The policy file as a JSON object, or `undefined` when there is none to apply.
 *
 * Split from the key loop because the two answer different questions — "is there a document?" and
 * "what does this key mean?" — and together they put `readManagedSettings` at a cognitive complexity
 * of 30 against this repository's limit of 10.
 *
 * Every `undefined` here is REPORTED except the first: an absent file is the ordinary case on a
 * machine with no operator tier, and a reader that complained about it would make the feature a
 * prerequisite for running at all. A file that exists and cannot be used is the opposite — an
 * organisation deployed a policy and it is not applying, which they must be told.
 */
function readPolicyDocument(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    diagFailure(
      `[theokit-sdk] ${path} exists and could not be read (${(cause as Error).message}) — ` +
        `NO operator policy is being applied. Fix the permissions or remove the file.\n`,
    );
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    diagFailure(
      `[theokit-sdk] ${path} is not valid JSON (${(cause as Error).message}) — ` +
        `NO operator policy is being applied.\n`,
    );
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    diagFailure(
      `[theokit-sdk] ${path} is not a JSON object — NO operator policy is being applied.\n`,
    );
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

/** The four permission postures a policy may impose. */
const PERMISSION_MODES = ["default", "plan", "acceptEdits", "bypass"] as const;

/**
 * Apply ONE declared key, or report why it is not being applied.
 *
 * Every path that declines writes a message naming the key. An organisation that wrote a policy and
 * got silence concludes it applied, which is the belief this whole tier exists to remove — so
 * "unknown key", "wrong type" and "not one of the four" are each said out loud rather than skipped.
 */
function applyPolicyKey(out: ManagedSettings, key: string, value: unknown, path: string): void {
  if (!KNOWN_KEYS.has(key as keyof ManagedSettings)) {
    decline(path, key, "this runtime does not enforce it");
    return;
  }
  if (key === "permissionMode") {
    const mode = readMode(value, path);
    if (mode !== undefined) out.permissionMode = mode;
    return;
  }
  if (key === "permissions") {
    const rules = readRuleLists(value, path);
    if (rules !== undefined) out.permissions = rules;
    return;
  }
  const flag = readBoolean(value, key, path);
  if (flag === undefined) return;
  if (key === "disableAllHooks") out.disableAllHooks = flag;
  if (key === "disableSkillShellExecution") out.disableSkillShellExecution = flag;
}

/** One sentence, one shape, so every refusal reads the same and none can be silent by accident. */
function decline(path: string, key: string, reason: string): void {
  diagFailure(`[theokit-sdk] ${path} declares "${key}" — ${reason}. It is NOT being applied.\n`);
}

function readMode(value: unknown, path: string): ManagedSettings["permissionMode"] {
  if (typeof value === "string" && PERMISSION_MODES.includes(value as never)) {
    return value as ManagedSettings["permissionMode"];
  }
  decline(
    path,
    "permissionMode",
    `${JSON.stringify(value)} is not one of ${PERMISSION_MODES.join(", ")}`,
  );
  return undefined;
}

/**
 * The rule lists, carried as written.
 *
 * Not parsed here on purpose: a parse failure must reach whoever constructs the engine rather than
 * being swallowed into an empty policy — a rule an operator wrote and this runtime silently dropped
 * is the belief-in-an-absent-protection the whole tier removes.
 */
function readRuleLists(value: unknown, path: string): ManagedSettings["permissions"] {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as ManagedSettings["permissions"];
  }
  decline(
    path,
    "permissions",
    `it is ${Array.isArray(value) ? "an array" : typeof value}, not an object of rule lists`,
  );
  return undefined;
}

function readBoolean(value: unknown, key: string, path: string): boolean | undefined {
  if (typeof value === "boolean") return value;
  decline(path, key, `it is ${typeof value}, not a boolean`);
  return undefined;
}
