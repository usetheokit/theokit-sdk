/**
 * Hook allowlists (#1053): fingerprint a hook, gate by fingerprint, list what a project would run.
 *
 * Exposed as `@theokit/sdk/hooks-approval`, not the root barrel, to keep the root bundle small.
 */
import { createHash } from "node:crypto";
import { ConfigurationError } from "./errors.js";
import type { HookConfig } from "./internal/runtime/hooks/hooks-source.js";
import { hookApprovalRequest, loadHookConfig } from "./internal/runtime/hooks/hooks-source.js";
import type { CompatSource } from "./types/agent.js";
import type { HookApprovalGate, HookApprovalRequest } from "./types/hooks.js";

/**
 * The hex sha256 of `sourceEvent`, `command` and `timeoutMs`, one per line
 * (`${sourceEvent}\n${command}\n${timeoutMs}`).
 *
 * The format is STABLE: stored approvals depend on it and it will not change.
 *
 * @public
 */
export function hookFingerprint(
  request: Pick<HookApprovalRequest, "sourceEvent" | "command" | "timeoutMs">,
): string {
  return createHash("sha256")
    .update(`${request.sourceEvent}\n${request.command}\n${request.timeoutMs}`)
    .digest("hex");
}

const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

/**
 * A gate that approves only hooks whose fingerprint is listed. Input is lower-cased; an item that is
 * not 64 hex characters throws `ConfigurationError` (`hook_fingerprint_invalid`) naming its position
 * (1-based), never its value. An empty set refuses every hook.
 *
 * @public
 */
export function fingerprintHookGate(
  approved: ReadonlySet<string> | Iterable<string>,
): HookApprovalGate {
  const allowed = new Set<string>();
  let position = 0;
  for (const item of approved) {
    position += 1;
    const value = typeof item === "string" ? item.toLowerCase() : "";
    if (!FINGERPRINT_PATTERN.test(value)) {
      throw new ConfigurationError(
        `Approved hook fingerprint ${position} is not a 64-character hex sha256`,
        { code: "hook_fingerprint_invalid" },
      );
    }
    allowed.add(value);
  }
  return { approve: (request) => allowed.has(hookFingerprint(request)) };
}

/** A command hook a project declares, with the fingerprint an owner approves. @public */
export interface ProjectHook extends HookApprovalRequest {
  readonly fingerprint: string;
}

/**
 * Every command hook the agent would load for `cwd`, in the order the runtime loads them (files in
 * precedence order, events in config order, commands in declaration order). Uses the runtime's own
 * loader, so the file set, precedence and timeout default are the runtime's.
 *
 * @public
 */
export async function listProjectHooks(
  cwd: string,
  options: { compatSources?: readonly CompatSource[] } = {},
): Promise<ProjectHook[]> {
  // The runtime's loader accepts the same declarations `AgentOptions.local.compatSources` does.
  const config: HookConfig = await loadHookConfig(
    cwd,
    (options.compatSources ?? []) as Parameters<typeof loadHookConfig>[1],
  );
  const hooks: ProjectHook[] = [];
  for (const [event, commands] of Object.entries(config.hooks ?? {})) {
    for (const command of commands ?? []) {
      const request = hookApprovalRequest(command, event as keyof NonNullable<HookConfig["hooks"]>);
      hooks.push({ ...request, fingerprint: hookFingerprint(request) });
    }
  }
  return hooks;
}
