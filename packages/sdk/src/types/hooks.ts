/**
 * Hook contract types.
 *
 * Owner: `internal/runtime/hooks/` (2 of 3 importers). Derived from the import graph, not declared —
 * `hooks-executor.ts` re-exports every name here, and `types/agent.ts` reads only the gate.
 *
 * A LEAF: it imports nothing, so anything may depend on it without closing a cycle. That is the
 * whole reason it exists as its own file. The first version of #631 put
 * `import("../internal/runtime/hooks/hooks-executor.js").HookApprovalGate` inline in
 * `types/agent.ts`, which made the public contract depend on an internal module and produced
 * thirteen failing cycle assertions — the exact defect `types/plugin.ts` documents at its own head
 * ("the public contract sits above the DIP boundary").
 *
 * `HookEvent` is DECLARED here and re-exported by `internal/runtime/hooks/hooks-executor.ts`, so
 * that pair has one definition. `internal/runtime/hooks/hooks-source.ts` still carries its own copy;
 * consolidating that third one is the same class of problem as #586 and is deliberately not folded
 * into this change.
 *
 * @public
 */

/** The five lifecycle events the runtime actually fires. */
export type HookEvent = "preRun" | "postRun" | "preToolUse" | "postToolUse" | "stop";

/**
 * #631 — what the consumer is shown when asked to approve a hook.
 *
 * The command TEXT and the file it was declared in, because neither alone answers the question. A
 * consumer's fingerprint is over the command; which file it came from is what separates its own
 * configuration from a foreign dialect it merely imported, and those deserve different answers.
 *
 * @public
 */
export interface HookApprovalRequest {
  readonly command: string;
  readonly event: HookEvent;
  readonly sourcePath?: string;
  readonly matcher?: string;
  /**
   * #637 — the timeout the runtime WILL apply, in milliseconds, default already resolved.
   *
   * A config that omits `timeout` still runs under one (30s). Reporting `undefined` there would
   * make a consumer reimplement this package's default in order to compute the same fingerprint,
   * and a default duplicated across a boundary is a default that drifts.
   */
  readonly timeoutMs: number;
  /**
   * #637 — the event key exactly as the config file spelled it (`PreToolUse`), which is NOT
   * `event` (`preToolUse`).
   *
   * A consumer's approval is taken against the file it showed the user, so its stored fingerprint
   * is over the file's vocabulary. Without this the two sides hash different strings and no hook
   * can ever be approved — only refused. The literal key rather than a published mapping table,
   * because a mapping is a second thing to keep in step with the first.
   *
   * `string` and not a union of the keys this SDK currently recognises: the vocabulary belongs to
   * whichever dialect declared the hook, so narrowing it would make adding a dialect a breaking
   * change to this public type. A consumer hashes it; it does not need to switch on it.
   */
  readonly sourceEvent: string;
}

/**
 * #631 — a consumer's decision point before this package spawns a hook.
 *
 * Absent means run, which is what every consumer gets today: a gate that defaulted to refusing
 * would disable every hook in the ecosystem on an upgrade.
 *
 * @public
 */
export interface HookApprovalGate {
  readonly approve?: (request: HookApprovalRequest) => boolean | Promise<boolean>;
}
