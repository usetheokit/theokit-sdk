import type { CompatSourceDeclaration } from "../compat/foreign-config-sources.js";
import { adapterForConfigPath, undefinedVariablesIn } from "../compat/foreign-config-sources.js";
import { spawnAndCollect } from "../lifecycle/spawn-collect.js";
import { loadHookConfig } from "./hooks-source.js";

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
export type { HookApprovalGate, HookApprovalRequest, HookEvent } from "../../../types/hooks.js";

import type { HookApprovalGate, HookApprovalRequest, HookEvent } from "../../../types/hooks.js";

export interface HookCommand {
  command: string;
  /** Optional matcher restricting the hook to specific tools (regex). */
  matcher?: string;
  /** Optional timeout in ms; defaults to 30s. */
  timeoutMs?: number;
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
  ) {}

  async initialize(settingSourcesIncludeProject: boolean): Promise<void> {
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
  private async refusedByConsumer(command: HookCommand, payload: HookPayload): Promise<boolean> {
    if (this.gate?.approve === undefined) return false;
    const request: HookApprovalRequest = {
      command: command.command,
      event: payload.event,
      ...(command.sourcePath === undefined ? {} : { sourcePath: command.sourcePath }),
      ...(command.matcher === undefined ? {} : { matcher: command.matcher }),
    };
    return !(await this.gate.approve(request));
  }

  private async executeOne(command: HookCommand, payload: HookPayload): Promise<HookDecision> {
    // A refused hook resolves to `allow`, NOT to `deny`. `preRun` and `preToolUse` decisions can
    // block the operation they attach to, so treating "not approved" as a denial would make an
    // unapproved hook worse than an absent one — the consumer asked for the COMMAND not to run, not
    // for the work to stop. A refused hook is treated as if it were not configured.
    if (await this.refusedByConsumer(command, payload)) return { decision: "allow" };
    const timeoutMs = command.timeoutMs ?? 30_000;
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
      stdin: JSON.stringify(payload),
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
    if (result.timedOut) return { decision: "deny", reason: `Hook timed out after ${timeoutMs}ms` };
    if (result.spawnError !== undefined) {
      return { decision: "deny", reason: `Hook spawn failed: ${result.spawnError.message}` };
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
 * The variables the dialect that declared this command defines for it.
 *
 * `{}` for a native command, for one with no recorded origin, and for a path under no registered
 * dialect — in each case this runtime is the only contract in play and it is inherited already.
 */
function runtimeEnvFor(sourcePath: string | undefined, cwd: string): Record<string, string> {
  if (sourcePath === undefined) return {};
  return adapterForConfigPath(sourcePath)?.runtimeEnv(cwd) ?? {};
}

function parseDecisionFromStdout(stdout: string): HookDecision {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return { decision: "allow" };
  try {
    const parsed = JSON.parse(trimmed) as Partial<HookDecision> & {
      decision?: string;
    };
    if (parsed.decision === "deny" || parsed.decision === "feedback") {
      const result: HookDecision = { decision: parsed.decision };
      if (parsed.reason !== undefined) result.reason = parsed.reason;
      if (parsed.feedback !== undefined) result.feedback = parsed.feedback;
      return result;
    }
    if (parsed.decision === "allow") return { decision: "allow" };
  } catch {
    // Treat unparseable stdout as feedback rather than failure.
    return { decision: "feedback", feedback: trimmed };
  }
  return { decision: "allow" };
}
