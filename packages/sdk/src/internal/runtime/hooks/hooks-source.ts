/**
 * Single source of truth for loading the hooks config (ADR 0016 — reverses
 * D74/D77 for hooks: JSON is canonical again, in the Claude Code shape).
 *
 * `.theokit/hooks.json` (Claude-Code-shaped JSON) is the only supported form.
 * A stray legacy `.theokit/hooks/*.md` dir (no hooks.json) is NOT loaded — it
 * warns to migrate and yields no hooks. Absent both → empty config.
 *
 * Consumed by `hooks-executor.ts` (runtime dispatch).
 *
 * Config SHAPE is Claude Code's `settings.json` hooks:
 *   { "hooks": { "PreToolUse": [ { "matcher": "shell",
 *       "hooks": [ { "type": "command", "command": "…", "timeout": 30 } ] } ] } }
 *
 * The shape, not the event COVERAGE. Four of the thirty-three documented events are fired by this
 * runtime — see {@link CLAUDE_CODE_EVENT_MAP} for which, why the rest are refused rather than
 * mapped, and the order in which they should be added. An event outside the set is reported to the
 * operator rather than skipped in silence.
 *
 * @internal
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ConfigurationError } from "../../../errors.js";
import { diag, diagFailure } from "../../diagnostics.js";
import { projectConfigRoots, theokitConfigRoot } from "../../persistence/paths.js";
import type { CompatSourceDeclaration } from "../compat/foreign-config-sources.js";

/** The five lifecycle events the SDK runtime actually fires. */
export type HookEvent = "preRun" | "postRun" | "preToolUse" | "postToolUse" | "stop";

/**
 * The Claude Code event names this runtime actually FIRES, and the internal event each becomes.
 *
 * Exported so the supported set is stated rather than implied. It used to be private, and the
 * docblock above claimed a shape "identical to Claude Code's `settings.json` hooks" while accepting
 * four of the thirty-three documented events — a claim nothing could contradict.
 *
 * A Claude Code event with no firing point here — `SessionStart`, `SubagentStop`, `PreCompact`,
 * `Notification`, `SessionEnd` among them — is skipped with a report rather than silently accepted,
 * because it would never run.
 *
 * ## Why this map is not simply grown
 *
 * Mapping a name the runtime does not fire is strictly WORSE than refusing it. An operator declaring
 * `PreCompact` today gets a report saying it will not fire; with the name mapped they would get
 * silence and a guard that never runs — a declared veto that does not exist. The map grows when the
 * seam exists, one event at a time.
 *
 * ## Priority, when it does grow
 *
 * The blocking events first. An unwired veto loses a CAPABILITY; an unwired observer loses a
 * SIGNAL. Thirteen of the sixteen the spec marks "Can block? Yes" are unwired, and
 * `tests/internal/runtime/hooks/the-supported-event-set-is-stated.test.ts` lists them in the order
 * they should be taken, so the next person does not re-derive which is which.
 *
 * `postRun` is reachable through this SDK's own config and has no entry here on purpose: it fires
 * per RUN, and no documented Claude Code event means that. `SessionEnd` is the near miss, and a
 * session is not a run.
 */
export const CLAUDE_CODE_EVENT_MAP: Readonly<Record<string, HookEvent>> = {
  PreToolUse: "preToolUse",
  PostToolUse: "postToolUse",
  UserPromptSubmit: "preRun",
  Stop: "stop",
};

export interface HookCommand {
  command: string;
  matcher?: string;
  timeoutMs?: number;
  /**
   * #637 — the event key as written in the config file (`PreToolUse`), carried so the approval
   * gate can report the vocabulary the consumer's stored fingerprint was taken against.
   *
   * REQUIRED, not optional: `parseClaudeCodeCommand` is the only producer of a `HookCommand` in
   * this package, so every command has one. An optional field would hand every reader a fallback
   * branch for a case that cannot occur — and if an in-memory producer is added later, required is
   * what forces it to supply a value instead of inheriting a silent `undefined`.
   */
  sourceEvent: string;
  /**
   * The config file this command was declared in.
   *
   * Carried so the executor can supply the runtime contract the declaring DIALECT presumes — a
   * command from `.claude/settings.json` is written against Claude Code's runtime and expects
   * `$CLAUDE_PROJECT_DIR` to exist (#522). Absent for a command built in memory, which is native by
   * construction.
   */
  sourcePath?: string;
}

export interface HookConfig {
  hooks?: Partial<Record<HookEvent, HookCommand[]>>;
}

const warned = new Set<string>();

/**
 * Emit a stderr warn once per process per unique key. Helps surface the
 * deprecation path without spamming when the loader is called many times
 * during a session (cron + send + skills all hit this).
 *
 * Note: spawned workers (cron, subagent) start fresh processes — warn
 * re-emits there, by design (1 per process boot, not per call).
 *
 * @internal
 */
export function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  diag(`${message}\n`);
}

/**
 * A warn-once that is NOT dropped when the host installed no diagnostics sink.
 *
 * `diag` is silent by default and that is right for chatter — a library must not assume the host's
 * stderr is a free-form log, because in a TUI it is the render surface. A configuration the operator
 * WROTE and this runtime will not honour is not chatter. `diagFailure`'s own docblock records the
 * precedent, `theokit-sdk#189`: an MCP server failed to start, the only report went to `diag()`, the
 * embedding UI never read it, and "the user saw an agent with missing tools and no reason given".
 *
 * A dropped hook is that shape with a sharper edge, because the missing thing is a guard: the
 * operator declared a refusal, it silently does not exist, and nothing distinguishes that from a
 * refusal that ran and approved.
 *
 * The asymmetry that decides it is quoted from the same place: a corrupted frame is visible and
 * recoverable, while a silently dropped failure is neither.
 *
 * @internal
 */
export function warnFailureOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  diagFailure(`${message}\n`);
}

/** Reset for tests; not exported via barrel. @internal */
export function _resetWarnOnceForTests(): void {
  warned.clear();
}

/**
 * Load hooks from `.theokit/hooks.json` (Claude-Code-shaped — the only supported
 * form). A stray legacy `.theokit/hooks/*.md` markdown dir (no `hooks.json`) is
 * NOT loaded — it emits a one-time migration warn and yields no hooks.
 *
 * @internal
 */
export async function loadHookConfig(
  cwd: string,
  compatSources: readonly CompatSourceDeclaration[] = [],
): Promise<HookConfig> {
  const merged: HookConfig = {};
  let sawAny = false;
  for (const path of hookConfigCandidates(cwd, compatSources)) {
    if (!existsSync(path)) continue;
    sawAny = true;
    // Stamped at merge, where the file is still known. One line later the commands are pooled per
    // event and every trace of which dialect declared them is gone — which is how a Claude Code
    // command came to be run without Claude Code's runtime (#522).
    mergeInto(merged, stampSource(await readHookFile(path), path));
  }
  if (!sawAny && existsSync(join(theokitConfigRoot(cwd), "hooks"))) {
    warnOnce(
      "hooks-md-unsupported",
      "[theokit-sdk] .theokit/hooks/*.md hooks are no longer supported (ADR 0016) — migrate to a Claude-Code-shaped .theokit/hooks.json",
    );
  }
  return merged;
}

/**
 * Every file that may declare hooks, in precedence order.
 *
 * `hooks.json` under each project config root, then the Claude Code CLI's own settings files — which
 * is where the CLI actually keeps hooks, so a repository set up for it presents its hooks here
 * without being converted. `settings.local.json` is the CLI's personal-override file and sits beside
 * the shared one rather than replacing it.
 *
 * The shape never needed translating: `parseClaudeCodeConfig` reads the `hooks` key off whatever
 * object it is given, and a settings file is that same object with other keys alongside.
 */
function hookConfigCandidates(
  cwd: string,
  compatSources: readonly CompatSourceDeclaration[],
): string[] {
  const roots = projectConfigRoots(cwd, compatSources, "hooks");
  return [
    ...roots.map((root) => join(root, "hooks.json")),
    ...roots.map((root) => join(root, "settings.json")),
    ...roots.map((root) => join(root, "settings.local.json")),
  ];
}

/**
 * Record which file each command came from.
 *
 * A command already carrying a `sourcePath` keeps it: nothing produces that today, and a nested
 * config that declared its own origin would be describing something this function cannot see.
 */
function stampSource(config: HookConfig, sourcePath: string): HookConfig {
  if (config.hooks === undefined) return config;
  const hooks: NonNullable<HookConfig["hooks"]> = {};
  for (const [event, commands] of Object.entries(config.hooks) as [
    HookEvent,
    HookCommand[] | undefined,
  ][]) {
    if (commands === undefined) continue;
    hooks[event] = commands.map((c) => ({ sourcePath, ...c }));
  }
  return { hooks };
}

/**
 * Append one source's commands onto the accumulator, per event.
 *
 * MERGED, not first-wins, and the distinction is deliberate. An agent or a skill is a NAMED
 * declaration: two files claiming one name collide, and the explicit namespace should win. Hooks are
 * unnamed lists — two files declaring `PreToolUse` are two sets of commands an operator wrote, and
 * keeping only one drops the other in silence, which is the failure class this package guards
 * against everywhere else.
 */
function mergeInto(target: HookConfig, source: HookConfig): void {
  for (const [event, commands] of Object.entries(source.hooks ?? {}) as [
    HookEvent,
    HookCommand[] | undefined,
  ][]) {
    if (commands === undefined || commands.length === 0) continue;
    target.hooks ??= {};
    target.hooks[event] = [...(target.hooks[event] ?? []), ...commands];
  }
}

async function readHookFile(jsonPath: string): Promise<HookConfig> {
  let raw: string;
  try {
    raw = await readFile(jsonPath, "utf8");
  } catch (cause) {
    throw new ConfigurationError(`Failed to read hooks config: ${jsonPath}`, {
      code: "hooks_read_error",
      cause,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ConfigurationError(`Invalid JSON in hooks config: ${jsonPath}`, {
      code: "hooks_json_invalid",
      cause,
    });
  }
  return parseClaudeCodeConfig(parsed, jsonPath);
}

/**
 * Narrow an unknown to a record, or throw a typed config error.
 *
 * `hint` names the shape that WOULD be accepted, and exists because the message without it names
 * only the validator's expectation. Measured on a consumer in 2026-09: a flat `hooks` array in a
 * `.theokit/settings.json` made this throw on every turn, and `expected an object at "hooks"` gave
 * the operator nothing to act on — the file parses fine for the product that wrote it, and it is
 * this independent read of the same path that fails. An error on a refusal path should carry the
 * fix, not the diagnosis.
 */
function asRecord(
  value: unknown,
  path: string,
  where: string,
  hint?: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigurationError(
      `hooks: expected an object at ${where} in ${path}${hint === undefined ? "" : ` — ${hint}`}`,
      { code: "hooks_json_invalid" },
    );
  }
  return value as Record<string, unknown>;
}

/**
 * The shape this loader accepts, quoted back on the one refusal an operator is most likely to hit:
 * `hooks` keyed by event, each event an array of matcher groups.
 */
const HOOKS_SHAPE_HINT =
  'hooks are keyed by event, e.g. { "hooks": { "PreToolUse": [ { "hooks": ' +
  '[ { "type": "command", "command": "…" } ] } ] } }';

/** Narrow an unknown to an array, or throw a typed config error. */
function asArray(value: unknown, path: string, where: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ConfigurationError(`hooks: expected an array at ${where} in ${path}`, {
      code: "hooks_json_invalid",
    });
  }
  return value;
}

/**
 * Parse Claude Code's nested hooks config into the SDK's flat internal shape:
 * `{ hooks: { PreToolUse: [{ matcher?, hooks: [{ type:"command", command, timeout? }] }] } }`
 * → `{ hooks: { preToolUse: [{ command, matcher?, timeoutMs? }] } }`. Each group's
 * `matcher` applies to every command it wraps; `timeout` (seconds) → `timeoutMs`.
 */
function parseClaudeCodeConfig(raw: unknown, path: string): HookConfig {
  const root = asRecord(raw, path, "the root");
  if (root.hooks === undefined) return {};
  const hooksRec = asRecord(root.hooks, path, `"hooks"`, HOOKS_SHAPE_HINT);
  const grouped: Partial<Record<HookEvent, HookCommand[]>> = {};

  for (const [ccEvent, groups] of Object.entries(hooksRec)) {
    const event = CLAUDE_CODE_EVENT_MAP[ccEvent];
    if (event === undefined) {
      // The operator wrote this event and it will not fire. Reported through the channel that
      // survives an absent sink — see `warnFailureOnce`.
      warnFailureOnce(
        `hooks-event-${ccEvent}`,
        `[theokit-sdk] hooks: event "${ccEvent}" is not fired by the SDK runtime (supported: ${Object.keys(CLAUDE_CODE_EVENT_MAP).join(", ")}) — skipping`,
      );
      continue;
    }
    grouped[event] = [...(grouped[event] ?? []), ...flattenEventGroups(groups, path, ccEvent)];
  }
  return { hooks: grouped };
}

/** Flatten one Claude Code event's matcher-groups into internal HookCommands. */
function flattenEventGroups(groups: unknown, path: string, ccEvent: string): HookCommand[] {
  const commands: HookCommand[] = [];
  for (const rawGroup of asArray(groups, path, `hooks.${ccEvent}`)) {
    const group = asRecord(rawGroup, path, `hooks.${ccEvent}[]`);
    const matcher = group.matcher === undefined ? undefined : String(group.matcher);
    for (const rawCmd of asArray(group.hooks, path, `hooks.${ccEvent}[].hooks`)) {
      commands.push(parseClaudeCodeCommand(rawCmd, matcher, path, ccEvent));
    }
  }
  return commands;
}

/**
 * Fields a Claude Code hook entry may declare that this runtime does not implement.
 *
 * Listed rather than lumped into "unknown" because the two are different facts to the operator
 * reading the error: a typo is theirs to fix, and a field written for another runtime is a tree
 * that was never going to work here. The same split is made for subagent frontmatter, for the same
 * reason — an operator migrating a `.claude/` tree learned one key per round trip otherwise.
 *
 * `if` is the one that made refusal the right answer rather than a warning. Dropped, it fails OPEN:
 * a deny hook narrowed to one dangerous command shape silently becomes a deny hook over every call
 * of that tool. Every other field in this set loses a convenience; this one inverts the intent.
 */
const UNIMPLEMENTED_CLAUDE_CODE_HOOK_FIELDS = new Set([
  "if",
  "args",
  "statusMessage",
  "once",
  "async",
  "asyncRewake",
  "shell",
]);

/** What `parseClaudeCodeCommand` reads. Anything else is refused. */
const ACCEPTED_HOOK_FIELDS = new Set(["type", "command", "timeout"]);

/**
 * Refuse a hook entry that declares a field this parser does not read.
 *
 * The parser used to take `type`, `command` and `timeout` and discard the rest in silence, while
 * `packages/agents` — reading the same file one layer up — already refused an unknown key loudly
 * through a `.strict()` schema. Two layers disagreeing about whether a field is an error is bad on
 * its own; the permissive one being the layer that actually runs the hook is the defect.
 */
function rejectUnreadHookFields(cmd: Record<string, unknown>, path: string, ccEvent: string): void {
  for (const key of Object.keys(cmd)) {
    if (ACCEPTED_HOOK_FIELDS.has(key)) continue;
    const origin = UNIMPLEMENTED_CLAUDE_CODE_HOOK_FIELDS.has(key)
      ? ` — "${key}" is a Claude Code hook field that this runtime does not implement. The same ` +
        `applies to: ${[...UNIMPLEMENTED_CLAUDE_CODE_HOOK_FIELDS].filter((f) => f !== key).join(", ")}`
      : "";
    throw new ConfigurationError(
      `hooks.${ccEvent}: unsupported field "${key}" (accepted: ${[...ACCEPTED_HOOK_FIELDS].join(", ")}) in ${path}${origin}`,
      { code: "hooks_unsupported_field" },
    );
  }
}

/** One `{ type:"command", command, timeout? }` entry → an internal HookCommand. */
function parseClaudeCodeCommand(
  raw: unknown,
  matcher: string | undefined,
  path: string,
  ccEvent: string,
): HookCommand {
  const cmd = asRecord(raw, path, `hooks.${ccEvent}[].hooks[]`);
  if (cmd.type !== "command") {
    throw new ConfigurationError(
      `hooks: only { "type": "command" } is supported (got ${JSON.stringify(cmd.type)}) in ${path}`,
      { code: "hooks_unsupported_type" },
    );
  }
  if (typeof cmd.command !== "string" || cmd.command.length === 0) {
    throw new ConfigurationError(`hooks: "command" must be a non-empty string in ${path}`, {
      code: "hooks_invalid_command",
    });
  }
  // After the type/command checks, so a `{ type: "http", url }` entry still fails for its own
  // reason rather than for its `url`.
  rejectUnreadHookFields(cmd, path, ccEvent);
  const hc: HookCommand = { command: cmd.command, sourceEvent: ccEvent };
  if (matcher !== undefined) hc.matcher = matcher;
  if (typeof cmd.timeout === "number" && cmd.timeout > 0) {
    hc.timeoutMs = Math.round(cmd.timeout * 1000);
  }
  return hc;
}
