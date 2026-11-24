/**
 * Custom-tool assembly for the real local run (extracted from `real-local-run.ts`
 * for the G8 LoC budget — SRP: everything that builds the effective tool catalog
 * for a run lives here).
 *
 * Merges, in order: caller/agent `tools`, declarative subagent delegation tools
 * (file-based + inline), plugin tools, and — SE37 — the internal `think` tool when
 * `reasoning: true` (guarded against a native reasoning model). Binds parent
 * credentials onto delegation tools and applies the personality whitelist.
 *
 * @internal
 */

import { subAgentToolsFromDefinitions } from "../../a2a/subagent.js";
import type {
  AgentDefinition,
  AgentOptions,
  BuiltinToolName,
  CustomTool,
  ModelSelection,
} from "../../types/agent.js";
import type { CustomToolSpec } from "../agent-loop/types.js";
import type { InheritedCredentials } from "../concurrency/subagent-credentials.js";
import { createThinkTool, reasoningActive } from "../runtime/system-prompt/native-reasoning.js";
import { applyPersonalityFilter } from "../tool-registry/personality-filter.js";

/**
 * Declarative subagents become delegation tools for the local runtime — each
 * child inherits the parent's apiKey/model (via the run's credential scope) and is
 * scoped to the whitelisted subset of the parent's tools. `agents` is the merged
 * set from `loadSubagents` (`.theokit/agents/*.md` + inline `agentOptions.agents`),
 * so a subagent defined only on disk is callable against a real model — not just
 * in fixture mode.
 */
function declarativeSubagentTools(
  agents: Record<string, AgentDefinition> | undefined,
  parentTools: ReadonlyArray<CustomTool>,
): CustomTool[] {
  if (agents === undefined || Object.keys(agents).length === 0) return [];
  return subAgentToolsFromDefinitions(agents, parentTools);
}

/**
 * The credentials a delegated child inherits from this parent: its apiKey (else `Agent.create`
 * throws "Missing API key"), its model, its plugins and its sandbox posture.
 *
 * theokit#148 — this used to be pushed onto each subagent tool OBJECT
 * (`inheritSubAgentCredentials`), which meant any layer that rebuilt the object dropped it and the
 * child failed with `provider_unresolved`. It is now published on the run's async scope by
 * `createRealLocalRun`, so the value travels with the CALL. This function only computes it; the
 * scope is established at the run boundary, which is also the correct lifetime for it.
 *
 * @internal
 */
export function resolveInheritedCredentials(agentOptions: AgentOptions): InheritedCredentials {
  // #55 — hand the parent's code-registered plugins (array form carries the
  // PermissionPlugin) down so the child runs under the same permission gate.
  const parentPlugins = Array.isArray(agentOptions.plugins) ? agentOptions.plugins : undefined;
  // M33 — hand down the parent's sandbox posture so a child of a sandboxed parent stays sandboxed unless
  // its role opts out. A role's own `sandbox` (spec.sandbox) overrides this in buildChildCreateOptions.
  const parentSandbox = agentOptions.local?.sandboxOptions?.enabled;
  // #578 — hand down the configuration surfaces the parent was declared to read, so a child can
  // resolve a role its parent can see. Without this a parent with `compatSources: ["claude-code"]`
  // read `.claude/agents/` and its child did not, which let a team delegate TO a role by name while
  // the child could not resolve the rest of the team.
  //
  // The direction is the opposite of every other field here: those hand down a RESTRICTION and the
  // hazard is a child escaping it, whereas the child is currently more restricted than its parent.
  // Inheriting therefore cannot widen — the child gets what the parent already resolved and runs in
  // the parent's cwd, so it reaches no directory the parent could not.
  const parentSettingSources = agentOptions.local?.settingSources;
  const parentCompatSources = agentOptions.local?.compatSources;
  // #580 — the builtins the parent removed from its catalog. Unlike the two above, this crossed no
  // carrier at all: a parent withholding `shell` produced a child that had `shell`, so delegation
  // WIDENED authority the operator revoked. It is a restriction, so it is handed down like the
  // sandbox posture rather than like a capability.
  const parentWithheld = agentOptions.withheldBuiltinTools;
  return {
    ...(agentOptions.apiKey !== undefined ? { apiKey: agentOptions.apiKey } : {}),
    ...(typeof agentOptions.model === "object" ? { model: agentOptions.model } : {}),
    ...(parentPlugins !== undefined ? { plugins: parentPlugins } : {}),
    ...(parentSandbox !== undefined ? { sandbox: parentSandbox } : {}),
    ...(parentSettingSources !== undefined ? { settingSources: parentSettingSources } : {}),
    ...(parentCompatSources !== undefined ? { compatSources: parentCompatSources } : {}),
    ...(parentWithheld !== undefined ? { withheldBuiltinTools: parentWithheld } : {}),
  };
}

/**
 * The `withheldBuiltinTools` slice of `AgentLoopInputs`, emitted only when the agent actually
 * withholds something (usetheokit/theokit-sdk#381). Its own function because the inline conditional
 * pushed {@link buildRunToolCatalogInput} past the project's cognitive-complexity ceiling — the same
 * reason `LocalAgent.#declaredWindow` exists.
 */
function withheldBuiltinsInput(agentOptions: AgentOptions): {
  withheldBuiltinTools?: ReadonlyArray<BuiltinToolName>;
} {
  const withheld = agentOptions.withheldBuiltinTools;
  if (withheld === undefined || withheld.length === 0) return {};
  return { withheldBuiltinTools: withheld };
}

/**
 * Resolve the tool-catalog slice of `AgentLoopInputs` for this run: which custom tools the loop
 * declares, and which SDK builtins it must NOT.
 *
 * Precedence for the custom half (matches the mcpServers semantics — "fully replaces, not merged"):
 *  - `sendOptions.tools === undefined` → fall back to `agentOptions.tools`
 *  - `sendOptions.tools = []`         → explicitly clear (no custom tools)
 *  - `sendOptions.tools = [t1, ...]`  → use exactly these for this run
 *
 * usetheokit/theokit-sdk#381 added the builtin half, and it is why this is no longer named for
 * custom tools alone. It rides here rather than at the call site because the withhold list is
 * part of the same answer — what this run declares to the model — and because a run that
 * withholds nothing must produce the same `AgentLoopInputs` it produced before the option existed,
 * which is easiest to guarantee where the rest of the catalog is already assembled.
 *
 * Note the two halves are independent: an agent with no custom tools at all can still withhold a
 * builtin, so the "no tools" early return carries the withhold list out with it.
 *
 * ONE options record rather than eight positional parameters. Five of the eight were optional or
 * nullable in adjacent slots — `ReadonlyArray<string> | undefined`, `string`, `string | undefined`,
 * `Record | undefined`, `ModelSelection | undefined` — compatible enough that transposing two of
 * them compiled. The single call site was already destructuring the same `CreateRealLocalRunOptions`
 * value field by field, so the parameter list was re-deriving a record the caller held.
 */
export interface RunToolCatalogInputs {
  readonly agentOptions: AgentOptions;
  readonly sendOptions: { tools?: CustomTool[] } | undefined;
  readonly pluginManager: import("../plugins/manager.js").PluginManager | undefined;
  readonly personalityToolWhitelist: ReadonlyArray<string> | undefined;
  readonly agentId: string;
  readonly personalityName: string | undefined;
  readonly subagents: Record<string, AgentDefinition> | undefined;
  /** The per-send override applied, NOT `agentOptions.model` — they differ on an override. */
  readonly effectiveModel: ModelSelection | undefined;
}

export function buildRunToolCatalogInput({
  agentOptions,
  sendOptions,
  pluginManager,
  personalityToolWhitelist,
  agentId,
  personalityName,
  subagents,
  effectiveModel,
}: RunToolCatalogInputs): {
  customTools?: ReadonlyArray<CustomToolSpec>;
  withheldBuiltinTools?: ReadonlyArray<BuiltinToolName>;
} {
  const builtins = withheldBuiltinsInput(agentOptions);
  const baseTools = sendOptions?.tools ?? agentOptions.tools ?? [];
  // Prefer the resolved set (file-based + inline) when present; fall back to the
  // inline `agentOptions.agents` for callers that don't thread resolvedSubagents.
  const agentsForTools =
    subagents !== undefined && Object.keys(subagents).length > 0 ? subagents : agentOptions.agents;
  const subagentTools = declarativeSubagentTools(agentsForTools, baseTools);
  // T4.1: concat plugin-registered tools onto the effective catalog. Plugin
  // tools are merged unconditionally (no override semantics — name collision
  // would be caught by the registry validator if used).
  const pluginTools = pluginManager?.aggregated.tools ?? [];
  // SE37 — `reasoning: true` auto-attaches the internal `think` tool, unless a
  // native reasoning model is configured (guard + one-time warn). Guards on the
  // EFFECTIVE model (per-send override applied), matching the preamble path in
  // local-assembly so both agree on native-vs-not (no split double-reasoning).
  const reasoningTools = reasoningActive(agentOptions.reasoning, effectiveModel)
    ? [createThinkTool()]
    : [];
  if (
    baseTools.length === 0 &&
    subagentTools.length === 0 &&
    pluginTools.length === 0 &&
    reasoningTools.length === 0
  ) {
    return builtins;
  }
  const allTools = [...baseTools, ...subagentTools, ...pluginTools, ...reasoningTools];
  // theokit#148 — note this very `map`: the SDK rebuilds each tool from four fields, so any
  // credential channel riding the tool object is dropped right here. It only used to survive
  // because the pre-rebuild sink mutated the original handler's closure. Credentials now travel on
  // the run's async scope, which this rebuild cannot touch.
  const merged: CustomToolSpec[] = allTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    handler: tool.handler,
  }));
  // Phase 4.1 / ADR D167 — advisory narrowing by active personality.
  const customTools = applyPersonalityFilter(merged, personalityToolWhitelist, {
    agentId,
    personalityName,
  }) as ReadonlyArray<CustomToolSpec>;
  if (customTools.length === 0 && personalityToolWhitelist === undefined) return builtins;
  return { customTools, ...builtins };
}
