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
