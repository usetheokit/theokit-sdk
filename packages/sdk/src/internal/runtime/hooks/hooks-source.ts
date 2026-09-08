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
 * Config shape (identical to Claude Code's `settings.json` hooks):
 *   { "hooks": { "PreToolUse": [ { "matcher": "shell",
 *       "hooks": [ { "type": "command", "command": "…", "timeout": 30 } ] } ] } }
 *
 * @internal
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ConfigurationError } from "../../../errors.js";
import { diag } from "../../diagnostics.js";
import { projectConfigRoots, theokitConfigRoot } from "../../persistence/paths.js";
import type { CompatSourceDeclaration } from "../compat/foreign-config-sources.js";

/** The five lifecycle events the SDK runtime actually fires. */
export type HookEvent = "preRun" | "postRun" | "preToolUse" | "postToolUse" | "stop";

/**
 * Claude Code event name → the SDK firing event. Only events the runtime
 * genuinely emits are mapped; a Claude Code event with no SDK firing point
 * (SessionStart / SubagentStop / PreCompact / Notification / SessionEnd) is
 * skipped with a warn rather than silently accepted (it would never run).
 */
const CLAUDE_CODE_EVENT_MAP: Readonly<Record<string, HookEvent>> = {
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
      warnOnce(
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
  const hc: HookCommand = { command: cmd.command, sourceEvent: ccEvent };
  if (matcher !== undefined) hc.matcher = matcher;
  if (typeof cmd.timeout === "number" && cmd.timeout > 0) {
    hc.timeoutMs = Math.round(cmd.timeout * 1000);
  }
  return hc;
}
