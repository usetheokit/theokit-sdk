import type { CompatSourceDeclaration } from "../compat/foreign-config-sources.js";
import { adapterForConfigPath, undefinedVariablesIn } from "../compat/foreign-config-sources.js";
import { readManagedSettings } from "../compat/managed-settings.js";
import { spawnAndCollect } from "../lifecycle/spawn-collect.js";
import { loadHookConfig, warnFailureOnce } from "./hooks-source.js";

/**
 * Real file-based hook executor. Reads `.theokit/hooks.json` from the
 * workspace, spawns the configured command for each event with a JSON
 * payload on stdin, and aggregates the decisions.
 *
 * Decisions are conservative by design:
 *   - Non-zero exit code on a `preRun` / `preToolUse` hook fails the
 *     attached operation with `HookDeniedError`-style data.
 *   - JSON-shaped stdout (e.g. `{"decision":"deny","reason":"..."}`) is
 *     parsed and respected.
 *
 * @internal
 */

// Declared in `types/hooks.ts` (a leaf) and re-exported here so the pair has ONE definition.
export type {
  HookApprovalGate,
  HookApprovalRequest,
  HookEvent,
} from "../../../types/hooks.js";

import type { HookApprovalGate, HookApprovalRequest, HookEvent } from "../../../types/hooks.js";

export interface HookCommand {
  command: string;
  /** Optional matcher restricting the hook to specific tools (regex). */
  matcher?: string;
  /** Optional timeout in ms; defaults to 30s. */
  timeoutMs?: number;
  /**
   * #637 — the event key as the config file spelled it (`PreToolUse`), for the approval gate.
   *
   * Declared here AND in `hooks-source.ts`, because this interface has two independent copies —
   * the same duplication `types/hooks.ts` records for `HookEvent`. Adding the field to one only
   * would break at the assignment boundary in one direction and pass silently in the other.
   * Consolidating the pair is a separate change with its own blast radius, per the decision
   * recorded at the head of `types/hooks.ts`.
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

export interface HookDecision {
  decision: "allow" | "deny" | "feedback";
  reason?: string;
  feedback?: string;
}

export interface HookPayload {
  event: HookEvent;
  tool?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  agentId?: string;
  runId?: string;
}

export interface HookExecutionResult {
  decisions: HookDecision[];
  blocked: boolean;
  reason?: string;
}

interface HookConfig {
  hooks?: Partial<Record<HookEvent, HookCommand[]>>;
}

export class HooksExecutor {
  private config: HookConfig = {};

  constructor(
    private readonly cwd: string,
    /** Declared foreign dialects (#524). Empty reads `.theokit/` only. */
    private readonly compatSources: readonly CompatSourceDeclaration[] = [],
    /** #631 — the consumer's chance to refuse a command before it is spawned. */
    private readonly gate: HookApprovalGate | undefined = undefined,
    /**
     * B-026 — the operator tier. `managedSettingsRoot` exists so the precedence rule is testable;
     * production passes nothing and the platform path is resolved.
     */
    private readonly policy: { readonly managedSettingsRoot?: string } = {},
  ) {}

  async initialize(settingSourcesIncludeProject: boolean): Promise<void> {
    // B-026 — the OPERATOR's policy, read before anything the project declared and unaffected by
    // `settingSourcesIncludeProject`: that flag is the programmer choosing whether to read the
    // project's files, and a tier a lower layer can switch off is not a tier.
    //
    // A veto, not a merge. `disableAllHooks` does not lose to a project file that sets it `false`,
    // because the whole point of the tier is that the layer below cannot reach it.
    if (readManagedSettings(this.policy.managedSettingsRoot).disableAllHooks === true) {
      // Loud, once. A hook that does not run looks identical to a hook that ran and approved, which
      // is why this is the first control lifted into the tier — and why its absence is announced
      // rather than left for someone to infer from behaviour.
      warnFailureOnce(
        "hooks-disabled-by-policy",
        "[theokit-sdk] hooks: an operator policy (managed-settings.json) declares " +
          "disableAllHooks — NO hook will run, including any this project declared.",
      );
      this.config = {};
      return;
    }
    if (!settingSourcesIncludeProject) {
      this.config = {};
      return;
    }
    // ADR D77: try .theokit/hooks/*.md first; fallback .theokit/hooks.json
    // with deprecation warn. Shared loader in hooks-source.ts.
    this.config = await loadHookConfig(this.cwd, this.compatSources);
  }

  /** Fire every hook registered for `event` and aggregate the decisions. */
  async run(payload: HookPayload): Promise<HookExecutionResult> {
    const commands = this.commandsFor(payload.event, payload.tool);
    if (commands.length === 0) return { decisions: [], blocked: false };
    const decisions: HookDecision[] = [];
    for (const command of commands) {
      const decision = await this.executeOne(command, payload);
      decisions.push(decision);
      if (decision.decision === "deny") {
        const result: HookExecutionResult = {
          decisions,
          blocked: true,
        };
        if (decision.reason !== undefined) result.reason = decision.reason;
        return result;
      }
    }
    return { decisions, blocked: false };
  }

  private commandsFor(event: HookEvent, tool: string | undefined): HookCommand[] {
    const list = this.config.hooks?.[event] ?? [];
    if (tool === undefined) return list;
    return list.filter((entry) => {
      if (entry.matcher === undefined) return true;
      try {
        return new RegExp(entry.matcher).test(tool);
      } catch {
        return entry.matcher === tool;
      }
    });
  }

  /**
   * #631 — the consumer's gate, consulted at the ONLY point a hook is spawned.
   *
   * Here and not at the caller on purpose: a check anywhere else could be reached around by a
   * second execution path later, and this one cannot — `spawnAndCollect` is called for a hook from
   * exactly one place.
   *
   * No gate means no refusal, which is what every consumer gets today.
   */
  private async refusedByConsumer(
    command: HookCommand,
    payload: HookPayload,
    timeoutMs: number,
  ): Promise<boolean> {
    if (this.gate?.approve === undefined) return false;
    const request: HookApprovalRequest = {
      command: command.command,
      event: payload.event,
      // #637 — the EFFECTIVE timeout, passed in rather than recomputed here, so the number the
      // consumer is shown and the number `spawnAndCollect` enforces are the same expression.
      // Recomputing would be one line and would be the place they later diverge.
      timeoutMs,
      sourceEvent: command.sourceEvent,
      ...(command.sourcePath === undefined ? {} : { sourcePath: command.sourcePath }),
      ...(command.matcher === undefined ? {} : { matcher: command.matcher }),
    };
    return !(await this.gate.approve(request));
  }

  private async executeOne(command: HookCommand, payload: HookPayload): Promise<HookDecision> {
    // Resolved BEFORE the gate, because #637 shows the consumer the timeout that will actually be
    // applied, and `spawnAndCollect` below is handed this same binding.
    const timeoutMs = command.timeoutMs ?? 30_000;
    // A refused hook resolves to `allow`, NOT to `deny`. `preRun` and `preToolUse` decisions can
    // block the operation they attach to, so treating "not approved" as a denial would make an
    // unapproved hook worse than an absent one — the consumer asked for the COMMAND not to run, not
    // for the work to stop. A refused hook is treated as if it were not configured.
    if (await this.refusedByConsumer(command, payload, timeoutMs)) return { decision: "allow" };
    // #522 — a command imported from a foreign dialect runs under the contract that dialect
    // presumes. Claude Code's docs tell hook authors to reach project files through
    // `$CLAUDE_PROJECT_DIR`, so a command written the documented way expanded to a leading `/`
    // here, failed to find a file that was present, and denied every turn. Empty for a native
    // command, which already inherits this runtime. Merged OVER the scrubbed inherit policy by
    // `spawnAndCollect`, so it adds names and widens nothing.
    const env = runtimeEnvFor(command.sourcePath, this.cwd);
    const result = await spawnAndCollect({
      command: "sh",
      args: ["-c", command.command],
      cwd: this.cwd,
      ...(Object.keys(env).length > 0 ? { env } : {}),
      timeoutMs,
      stdin: JSON.stringify(stdinPayloadFor(payload, command, this.cwd)),
    });
    const failure = this.decisionFromFailure(result, command, env, timeoutMs);
    return failure ?? parseDecisionFromStdout(result.stdout);
  }

  /**
   * A run that did not succeed, turned into a decision. `undefined` when it did.
   *
   * Extracted from `executeOne` when the approval gate pushed that function past the complexity
   * gate. The seam is not arbitrary — every branch here answers one question, "the command did not
   * run cleanly, so what does this hook decide?", and none of them knows how the command was
   * spawned.
   */
  private decisionFromFailure(
    result: Awaited<ReturnType<typeof spawnAndCollect>>,
    command: HookCommand,
    env: Record<string, string>,
    timeoutMs: number,
  ): HookDecision | undefined {
    if (result.timedOut)
      return {
        decision: "deny",
        reason: `Hook timed out after ${timeoutMs}ms`,
      };
    if (result.spawnError !== undefined) {
      return {
        decision: "deny",
        reason: `Hook spawn failed: ${result.spawnError.message}`,
      };
    }
    if (result.exitCode === 0) return undefined;
    const stderr = result.stderr.trim();
    const base = stderr.length > 0 ? stderr : `Hook exited with code ${result.exitCode}`;
    // #522 — a failure whose cause is an undefined variable says so. `sh` expanded it to the empty
    // string and the error surfaced as a path, so the reader went looking for a file that was
    // present all along. Appended rather than replacing: the shell's own message is still the
    // evidence, and this names what the shell had no way to mention.
    const missing = undefinedVariablesIn(command.command, env);
    if (missing.length === 0) return { decision: "deny", reason: base };
    return {
      decision: "deny",
      reason:
        `${base} — this hook came from ${command.sourcePath ?? "an unrecorded source"} and uses ` +
        `${missing.map((n) => `$${n}`).join(", ")}, which nothing defines here. A variable this ` +
        "runtime does not supply expands to the empty string, so the error above names a path " +
        "rather than the cause.",
    };
  }
}

/**
 * The payload a hook reads on stdin: this runtime's field names, plus the documented ones.
 *
 * A script ported from Claude Code reads `tool_name`, `tool_input`, `tool_response`,
 * `hook_event_name` and `cwd`. It used to get `undefined` for every one — and RUN, deciding on
 * nothing while looking like a working guard. That is worse than a script that fails: the operator's
 * evidence that the guard works is identical either way.
 *
 * ADDED BESIDE, never instead. Both dialects execute through this one path, so renaming would break
 * every native script to fix the ported ones.
 *
 * Only what this runtime knows. `session_id`, `transcript_path`, `permission_mode` and `prompt_id`
 * stay absent because their values would have to be invented — and a script that branches on an
 * invented session id branches on a lie, which is the same trade `CLAUDE_PLUGIN_ROOT` is refused on
 * one module over. `hook_event_name` carries the spelling the config used (`PreToolUse`), which is
 * what a ported script compares against; a native hook that never declared one simply has no such
 * field.
 */
function stdinPayloadFor(
  payload: HookPayload,
  command: HookCommand,
  cwd: string,
): Record<string, unknown> {
  return {
    ...payload,
    cwd,
    ...(command.sourceEvent === undefined ? {} : { hook_event_name: command.sourceEvent }),
    ...(payload.tool === undefined ? {} : { tool_name: payload.tool }),
    ...(payload.input === undefined ? {} : { tool_input: payload.input }),
    ...(payload.output === undefined ? {} : { tool_response: payload.output }),
  };
}

/**
 * The variables the dialect that declared this command defines for it.
 *
 * `{}` for a native command, for one with no recorded origin, and for a path under no registered
 * dialect — in each case this runtime is the only contract in play and it is inherited already.
 */
function runtimeEnvFor(sourcePath: string | undefined, cwd: string): Record<string, string> {
  if (sourcePath === undefined) return {};
  return adapterForConfigPath(sourcePath)?.runtimeEnv(cwd) ?? {};
}

/**
 * The decision a hook printed, in whichever dialect it printed it.
 *
 * THREE spellings mean deny, and reading only one of them was a fail-open. `hooks-source.ts`
 * advertises a config shape "identical to Claude Code's `settings.json` hooks", so a consumer writes
 * the guard THAT documentation specifies — a nested `hookSpecificOutput.permissionDecision` — and
 * this function used to read only a top-level `decision`. The nested shape has no top-level
 * `decision` at all, so it fell past every branch to the final `return { decision: "allow" }`. The
 * JSON parsed, nothing warned, and the tool call proceeded.
 *
 * The direction is what made it expensive. A missing hook EVENT is discoverable: the user sees
 * nothing happen and goes looking. A veto that silently does not fire is indistinguishable from a
 * veto that fired and approved, so the operator's evidence that their guard works is the same
 * either way.
 *
 * Pinned by `tests/internal/runtime/hooks/documented-deny-shape-is-honoured.test.ts`, whose hooks
 * all `exit 0` — a non-zero exit already denies via {@link HooksExecutor.decisionFromFailure}, which
 * would pass those tests for the wrong reason and leave this function untested.
 *
 * What is deliberately NOT changed: an unrecognised shape still resolves to `allow`. Making it deny
 * would refuse every hook that prints diagnostics and happens to emit JSON, which is a behaviour
 * change with its own blast radius and belongs to its own measurement. The three documented denials
 * are unambiguous; that one is not.
 */
interface PrintedDecision {
  decision?: string;
  reason?: string;
  feedback?: string;
  hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
}

function parseDecisionFromStdout(stdout: string): HookDecision {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return { decision: "allow" };
  let parsed: PrintedDecision;
  try {
    // `Omit` on `decision`, not an intersection with it. `Partial<HookDecision> & {decision?: string}`
    // collapses to the NARROWER member, so comparing against "block" became a type error ("no
    // overlap") — for a value that arrives from `JSON.parse` and can be any string at all. The type
    // was right about the declared shape and wrong about what a hook actually prints.
    parsed = JSON.parse(trimmed) as PrintedDecision;
  } catch {
    // Treat unparseable stdout as feedback rather than failure.
    return { decision: "feedback", feedback: trimmed };
  }
  // The documented shape first: it is the one a reader of the Claude Code docs will emit.
  return nestedDecision(parsed) ?? flatDecision(parsed) ?? { decision: "allow" };
}

/**
 * The shape the Claude Code documentation instructs a hook to print.
 *
 * Reading only the flat `decision` was a fail-open: the nested form has no top-level `decision` at
 * all, so it fell past every branch to the final `allow`. The JSON parsed, nothing warned, and the
 * tool call proceeded.
 *
 * `ask` has no counterpart in this runtime's binary vocabulary, and collapsing it to `allow` would be
 * the same fail-open one value over. Deny is the honest projection: the hook asked for a decision
 * this runtime cannot put to anyone.
 */
function nestedDecision(parsed: PrintedDecision): HookDecision | undefined {
  const nested = parsed.hookSpecificOutput;
  if (nested?.permissionDecision === "allow") return { decision: "allow" };
  if (nested?.permissionDecision !== "deny" && nested?.permissionDecision !== "ask") {
    return undefined;
  }
  const result: HookDecision = { decision: "deny" };
  if (nested.permissionDecisionReason !== undefined) {
    result.reason = nested.permissionDecisionReason;
  }
  return result;
}

/**
 * This runtime's own spelling, plus `block` — Claude Code's deprecated-but-still-documented spelling
 * of the same refusal.
 *
 * `undefined` for an unrecognised shape, which the caller resolves to `allow`. Deliberately NOT
 * changed: making it deny would refuse every hook that prints diagnostics and happens to emit JSON,
 * which is a behaviour change with its own blast radius. The three documented denials are
 * unambiguous; that one is not.
 */
function flatDecision(parsed: PrintedDecision): HookDecision | undefined {
  if (parsed.decision === "allow") return { decision: "allow" };
  if (parsed.decision !== "deny" && parsed.decision !== "block" && parsed.decision !== "feedback") {
    return undefined;
  }
  const result: HookDecision =
    parsed.decision === "feedback" ? { decision: "feedback" } : { decision: "deny" };
  if (parsed.reason !== undefined) result.reason = parsed.reason;
  if (parsed.feedback !== undefined) result.feedback = parsed.feedback;
  return result;
}
