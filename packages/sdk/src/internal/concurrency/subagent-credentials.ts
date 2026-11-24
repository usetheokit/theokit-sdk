/**
 * theokit#148 — the parent's credentials, delivered through the CALL, not through the tool object.
 *
 * ## The class of bug this replaces
 *
 * Credential inheritance used to ride a property installed on the subagent tool object — first a
 * unique `Symbol()`, then `Symbol.for` after #143. Both are the same shape of contract: "this
 * object will reach the dispatcher with an extra property intact". Nothing enforces that, and it
 * broke twice for two different reasons:
 *
 *  - **Module duplication** (#142/#143): `tsup splitting: false` inlined a separate copy of the
 *    module into each public entry, so the two copies disagreed on a unique `Symbol()` key. Fixed at
 *    the build level by M78's `splitting: true`, but the fragile contract remained.
 *  - **Object normalization** (#148): any layer that rebuilds the tool from its known fields drops
 *    the property. `@theokit/agents`' `toCompiledTool` does exactly that, and had to add an explicit
 *    `Object.getOwnPropertySymbols` copy loop to compensate — a band-aid the SDK's contract forced
 *    onto a consumer. A named field would have been dropped by the same four-field rebuild, which is
 *    why "make it a typed field" alone does not close this.
 *
 * ## Why the async scope closes it
 *
 * What survives a rebuild is not the object — it is the CALL. A normalizing wrapper builds a new
 * object but still invokes the original handler, inside the parent run's async context. So
 * credentials published on that context reach the handler regardless of what the tool object looks
 * like by then. There is no property left for a layer to drop.
 *
 * It also fixes a defect the per-object slot could not: credentials were stored per tool INSTANCE,
 * so one subagent tool shared by two agents got last-writer-wins. The scope is per run.
 *
 * Nothing is exposed to third-party tool code: the store is module-private, credentials never touch
 * a handler's `ctx`, and `currentInheritedSubAgentCredentials` is `@internal`.
 *
 * @internal
 */

import { AsyncLocalStorage } from "node:async_hooks";
// The PUBLIC, validated shapes — `CompatSource`, not the loose `CompatSourceDeclaration` the
// internal loader accepts. What travels here is what the parent already resolved, so it is typed
// against the option it came from and the option it is handed to. Typing it loosely and casting at
// the destination would hide exactly the mismatch the compiler caught on the first attempt.
import type { BuiltinToolName, CompatSource, SettingSource } from "../../types/agent.js";
import type { ModelSelection } from "../../types/agent-prims.js";
import type { Plugin } from "../plugins/types.js";

/**
 * Credentials a parent agent hands down to its subagent tools so the child inherits the parent's
 * auth (and, absent an explicit `spec.model`, its model).
 *
 * Declared here rather than in `a2a/subagent.ts` so the delivery mechanism owns the payload shape
 * and the dependency runs one way (`a2a/subagent` -> this module). `a2a/subagent.ts` briefly
 * re-exported it "for back-compat"; knip proved there was no back-compat surface to preserve — the
 * type was never in the public barrel nor the exports map — so the re-export was deleted.
 *
 * Emitted rather than erased: `a2a/subagent.d.ts` imports it by name, and that entry IS published,
 * so erasing this declaration ships a `.d.ts` that does not compile. Not being in the exports map
 * is what keeps it out of the semver contract; erasure is not what does that.
 */
export interface InheritedCredentials {
  readonly apiKey?: string;
  readonly model?: ModelSelection;
  /**
   * The parent's shell-sandbox posture (`local.sandboxOptions.enabled`), handed down so a delegated
   * child of a sandboxed parent stays sandboxed unless its role explicitly opts out. Without this a
   * child ran unsandboxed whenever its role omitted `sandbox` — a default-open the sandbox wiring
   * exists to prevent.
   */
  readonly sandbox?: boolean;
  /**
   * #55 — the parent's code-registered plugins (e.g. a `PermissionPlugin`) handed down so the child
   * runs under the SAME policy. Without this, a delegated child's inner tool calls escape the
   * parent's argument-level permission gate. First-party delegation path only — never exposed to
   * third-party tool `ctx`.
   */
  readonly plugins?: readonly Plugin[];
  /**
   * #578 — the parent's RESOLVED `local.settingSources` / `local.compatSources`, handed down so a
   * delegated child can see the configuration surfaces its parent was declared to read.
   *
   * `compatSources` arrived with #524 and neither carrier was updated, so a parent declaring
   * `compatSources: ["claude-code"]` read `.claude/agents/` and its child did not: a team could
   * delegate TO a role by name and the child could not resolve the rest of the team.
   *
   * ## Why inheriting is safe here, unlike widening
   *
   * Every other field on this interface hands DOWN a restriction (the sandbox posture, the
   * permission plugins) and the danger is a child escaping it. These two are the mirror image: the
   * child is currently MORE restricted than its parent, so the failure is a missing capability
   * rather than an open door. Inheritance cannot widen — the child receives what the parent already
   * resolved, and it runs in the parent's cwd, so it reads no directory the parent could not.
   *
   * A role's explicit value still wins; these are the fallback, exactly as `model` and `sandbox` are.
   */
  readonly settingSources?: readonly SettingSource[];
  /** @see {@link InheritedCredentials.settingSources} — carried together, same reasoning. */
  readonly compatSources?: readonly CompatSource[];
  /**
   * #580 — the builtin tools the parent removed from its catalog, handed down so a delegated child
   * cannot recover one its parent revoked.
   *
   * This is the third field here that hands down a RESTRICTION, and it was the one that crossed no
   * carrier at all: measured, a parent with `withheldBuiltinTools: ["shell"]` produced a child whose
   * value was `undefined`, so the child got the shell back. Delegation widened authority the operator
   * had revoked — the inverse of #578 and materially worse, because there the child was merely
   * over-restricted.
   *
   * It bites because of a documented default (`types/agent.ts` § LocalOptions): a `shell` tool is
   * ALWAYS registered on a local agent, including when `tools: []` is passed. Withholding is the only
   * mechanism that removes it, so a withholding that does not survive delegation leaves no other way
   * for a child to be without a shell.
   *
   * ## The union rule
   *
   * A child's own list is UNIONED with this one, never substituted for it — see
   * {@link buildChildWithheldBuiltins}. Every other field on this interface lets the role's own value
   * win, and copying that here would let a child un-withhold what its parent revoked: the bug,
   * reintroduced by its own fix.
   */
  readonly withheldBuiltinTools?: readonly BuiltinToolName[];
}

const credentialsStore = new AsyncLocalStorage<InheritedCredentials>();

/**
 * Run `fn` with `credentials` published as the delegation credentials of the current run.
 *
 * Nested scopes shadow the outer one and the outer is restored on return, so a delegated child that
 * itself delegates hands down ITS credentials, not its parent's.
 *
 * @internal
 */
export async function withInheritedSubAgentCredentials<T>(
  credentials: InheritedCredentials,
  fn: () => Promise<T>,
): Promise<T> {
  return credentialsStore.run(credentials, fn);
}

/**
 * The delegation credentials of the current run, or `undefined` outside a run scope.
 *
 * `undefined` is deliberately NOT a fallback to some previous run's value: a subagent dispatched
 * with no parent context must create its child without an inherited key rather than reuse a
 * credential that belonged to someone else.
 *
 * @internal
 */
export function currentInheritedSubAgentCredentials(): InheritedCredentials | undefined {
  return credentialsStore.getStore();
}
