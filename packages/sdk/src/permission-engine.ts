/**
 * `PermissionEngine` — first-match permission rules for tool invocations.
 *
 * Evaluates a tool name (and optional arguments, #55) against an ordered list
 * of rules. First matching rule wins; when no rule matches the `defaultAction`
 * is returned. #55 — the default is now `"ask"` (FAIL-CLOSED): a permission
 * engine that cannot positively allow must not silently allow. Opt back into
 * the previous fail-open behavior with `{ defaultAction: "allow" }`.
 */

import { ConfigurationError } from "./errors.js";

export type PermissionAction = "allow" | "deny" | "ask";

/**
 * SE1 — a per-run permission MODE that adjusts the rule-engine verdict globally.
 * A PURE post-processor of the verdict (no tool-safety metadata needed, so it fits
 * a bring-your-own-tools runtime). Grounded in a peer project (plan agent = deny-all,
 * `dangerously-skip-permissions`) + Codex (`AskForApproval`: `OnRequest` default,
 * `Never`, `UnlessTrusted`). See {@link applyMode} for the exact table.
 *
 * - `default` — verdict as-is (rules decide; unmatched ⇒ `ask`, fail-closed).
 * - `plan` — read-only: `allow` rules pass, everything else ⇒ `deny` (mutations blocked).
 *   NOTE: `plan` gates on the resolved verdict, so an engine configured with
 *   `{ defaultAction: "allow" }` still yields `allow` for UNMATCHED calls under
 *   `plan` — pair `plan` with the default fail-closed engine (`defaultAction: "ask"`)
 *   for full read-only behavior.
 * - `acceptEdits` — auto-approve the UNMATCHED verdict, but STILL honor an explicit
 *   `ask` rule (a caller gates a risky tool with an ask rule). Codex `UnlessTrusted`.
 * - `bypass` (alias `bypassPermissions`, the Anthropic-exact name) — everything ⇒
 *   `allow` EXCEPT an explicit `deny` rule. Never asks. a peer project
 *   `dangerously-skip-permissions` / Codex `Never` / Anthropic `bypassPermissions`.
 */
import type { PermissionMode } from "./types/agent-prims.js";

export type { PermissionMode };

/**
 * SE1 — apply a {@link PermissionMode} to a rule-engine verdict. Pure.
 *
 * `explicit` is `true` when the verdict came from a rule that matched by name (and
 * args), `false` when it is the fail-closed default for an unmatched call. The flag
 * is load-bearing for `acceptEdits`, which auto-approves the unmatched default but
 * keeps honoring an explicit `ask` rule (unlike `bypass`, which allows even that).
 *
 * INVARIANT (both a peer project + Codex): an explicit `deny` is immune to EVERY
 * auto-approve mode — `bypass`/`acceptEdits` never un-deny.
 */
export function applyMode(
  verdict: PermissionAction,
  mode: PermissionMode,
  explicit: boolean,
): PermissionAction {
  // (a) explicit deny is terminal under every mode — fail-closed.
  if (verdict === "deny") return "deny";
  switch (mode) {
    case "default":
      return verdict;
    case "plan":
      // read-only: only allow rules pass; ask + unmatched ⇒ deny.
      return verdict === "allow" ? "allow" : "deny";
    case "acceptEdits":
      // (b) auto-approve the unmatched default; honor an explicit ask rule.
      if (verdict === "ask") return explicit ? "ask" : "allow";
      return verdict; // allow stays allow
    case "bypass":
    case "bypassPermissions":
      // everything that survived the deny check ⇒ allow (never asks).
      return "allow";
  }
}

/**
 * #55 — an argument matcher. A rule with `args` gates on the tool's argument
 * VALUES, not just its name: an exact string, a RegExp (tested against the
 * stringified value), or a predicate. Every declared arg must match for the
 * rule to apply — so `{ tool: "shell", args: { command: /rm\s+-rf/ } }` denies
 * a destructive shell call while leaving `ls` to fall through.
 */
export type ArgMatcher = string | RegExp | ((value: unknown) => boolean);

/**
 * One entry in a {@link PermissionEngine}'s ordered rule list.
 *
 * Order is the semantics. The engine walks the list and the first rule whose `tool` matches — and
 * whose `args` matchers all pass, when it declares any — decides; nothing after it is consulted. Put
 * the narrow rules first: a catch-all `tool` RegExp placed above a specific deny makes that deny
 * unreachable, and nothing warns you.
 *
 * `args` is what lets one tool name resolve differently depending on what it is asked to do —
 * `{ tool: "shell", args: { command: /rm\s+-rf/ }, action: "deny" }` blocks the destructive call and
 * leaves `ls` to fall through to a later rule. Every declared matcher must pass.
 *
 * **A rule that declares an argument the call did not supply does not match**, whatever form the
 * matcher takes — string, RegExp or predicate. The predicate is not invoked with `undefined`; the
 * guard runs first, for every matcher form. Evaluation continues to the next rule.
 *
 * That was not always true, and the fix is the reason this paragraph is explicit (#367). A predicate
 * used to be called anyway, so `(v) => v !== "prod"` returned true for a missing argument and an
 * ALLOW rule authorized a call that supplied nothing, while `(v) => v.includes("rm")` threw a
 * TypeError out of the permission gate. This docblock told consumers to guard every predicate by
 * hand for months after `argMatches` stopped needing it — you do not have to.
 *
 * A rule that matches yields an EXPLICIT verdict, and that is what makes it survive a permissive
 * `PermissionMode`: `acceptEdits` auto-approves the unmatched default but still honours an explicit
 * `ask` rule, and an explicit `deny` is immune to every mode, `bypass` included.
 */
export interface PermissionRule {
  /** Tool name (exact string) or pattern (RegExp). */
  tool: string | RegExp;
  /**
   * #55 — optional per-argument matchers. When present, the rule matches only
   * if the tool name matches AND every declared arg predicate matches the
   * corresponding call argument. A missing/undefined arg fails its predicate
   * (the rule does not match) — never throws.
   */
  args?: Record<string, ArgMatcher>;
  /** Action to take when rule matches. */
  action: PermissionAction;
}

/** Options for {@link PermissionEngine}. */
export interface PermissionEngineOptions {
  /**
   * Action when no rule matches. #55 — default is now `"ask"` (fail-closed): a
   * permission engine that cannot positively allow must not silently allow.
   * Pass `"allow"` to restore the previous fail-open behavior.
   */
  readonly defaultAction?: PermissionAction;
}

function argMatches(matcher: ArgMatcher, value: unknown): boolean {
  // The guard comes FIRST, for every matcher form including a predicate (#367). It used to sit
  // below the function branch, so a declared predicate was invoked with `undefined` — and both
  // directions of that were wrong:
  //
  //   allow rule  `(v) => v !== "prod"` returns true for undefined, so a call that supplied NO
  //               argument produced an EXPLICIT allow — a matcher written to narrow, widening.
  //   deny rule   `(v) => v.includes("rm")` raised TypeError out of the permission gate, which
  //               is not a denial but an unhandled failure on the path that decides authorization.
  //
  // A rule that declares an argument is a rule about that argument. A call that omitted it has
  // not satisfied the rule, whatever shape the matcher takes.
  if (value === undefined) return false;
  if (typeof matcher === "function") return matcher(value);
  if (matcher instanceof RegExp) {
    // Reset `lastIndex` so a global/sticky-flag regex (`/x/g`) does not carry
    // state across `.test()` calls — otherwise the same rule would alternate
    // verdicts on identical repeated calls (non-deterministic authorization).
    matcher.lastIndex = 0;
    return matcher.test(String(value));
  }
  return matcher === value;
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  return typeof value;
}

function validateRules(rules: unknown): void {
  if (!Array.isArray(rules)) {
    throw new ConfigurationError(
      `PermissionEngine expects an array of rules as its first argument, got ${describeValue(rules)}. Did you mean new PermissionEngine([...rules], options)?`,
      { code: "permission_rules_not_array" },
    );
  }
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i] as Partial<PermissionRule> | null | undefined;
    const toolOk =
      rule != null && (typeof rule.tool === "string" || rule.tool instanceof RegExp);
    const actionOk =
      rule != null && (rule.action === "allow" || rule.action === "deny" || rule.action === "ask");
    if (!toolOk || !actionOk) {
      throw new ConfigurationError(
        `PermissionEngine rule at index ${i} is invalid: "tool" must be a string or RegExp and "action" must be "allow", "deny" or "ask".`,
        { code: "permission_rule_invalid" },
      );
    }
  }
}

/**
 * Ordered first-match permission rules for tool invocations — the policy object you hand to
 * `PermissionPlugin.create()` to have it enforced.
 *
 * On its own it enforces nothing. `evaluate(toolName, args, mode)` is a pure function returning
 * `"allow" | "deny" | "ask"`, and no part of the SDK calls it until the engine is wrapped in a plugin
 * and that plugin is registered on an agent. The plugin is where a verdict becomes behaviour: `deny`
 * blocks the tool call, `allow` passes it through, and `ask` is routed to the host's `canUseTool`
 * gate — with no gate configured, `ask` blocks. So constructing an engine and never registering it
 * is a policy that does nothing, which is the mistake worth knowing about first.
 *
 * It is fail-closed by default: a call no rule matches resolves to `"ask"`, not `"allow"`, so a tool
 * the rules never mention needs a human — or an explicit `{ defaultAction: "allow" }` — before it
 * runs. Keep that default if you intend to use `PermissionMode: "plan"` for read-only behaviour,
 * because `plan` gates on the RESOLVED verdict: an engine built with `defaultAction: "allow"` still
 * allows every unmatched call under `plan`.
 *
 * The rules array is stored by reference and walked afresh on every `evaluate` call. Mutating the
 * array you passed in therefore changes the policy of a live engine; build a new engine when you
 * want a policy change to be a deliberate, visible event.
 */
export class PermissionEngine {
  private readonly defaultAction: PermissionAction;

  constructor(
    private readonly rules: PermissionRule[],
    options: PermissionEngineOptions = {},
  ) {
    validateRules(rules);
    // #55 — fail-closed by default.
    this.defaultAction = options.defaultAction ?? "ask";
  }

  /**
   * Evaluate a tool name (and optional arguments) against the rules. First
   * match wins; falls back to the configured `defaultAction` (default `"ask"`,
   * fail-closed) when no rule matches. #55 — a rule with `args` gates on the
   * argument values, so the same tool name can resolve to different actions
   * depending on what it is asked to do.
   */
  evaluate(
    toolName: string,
    args?: Record<string, unknown>,
    mode: PermissionMode = "default",
  ): PermissionAction {
    for (const rule of this.rules) {
      const nameMatches =
        typeof rule.tool === "string" ? rule.tool === toolName : rule.tool.test(toolName);
      if (!nameMatches) continue;
      if (rule.args !== undefined && !this.#argsMatch(rule.args, args)) continue;
      // SE1 — a matched rule is an EXPLICIT verdict; apply the mode with explicit=true.
      return applyMode(rule.action, mode, true);
    }
    // SE1 — no rule matched: the default is NOT explicit (explicit=false), so
    // `acceptEdits` auto-approves it while still honoring explicit `ask` rules above.
    return applyMode(this.defaultAction, mode, false);
  }

  #argsMatch(
    matchers: Record<string, ArgMatcher>,
    args: Record<string, unknown> | undefined,
  ): boolean {
    const call = args ?? {};
    for (const [key, matcher] of Object.entries(matchers)) {
      if (!argMatches(matcher, call[key])) return false;
    }
    return true;
  }
}
