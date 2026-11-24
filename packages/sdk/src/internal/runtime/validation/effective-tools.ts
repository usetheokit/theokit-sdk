/**
 * #583 — what tool names an agent built from these options will actually offer the model.
 *
 * ## The gap this closes
 *
 * `Agent.describe()` was the only reflection surface, and it builds its catalog as
 * `(agent.options.tools ?? [])` — literally the array the caller passed. The SDK's own builtins were
 * never in it. So the two states that matter most were indistinguishable:
 *
 *     Agent.create({ tools: [] })                       describe().tools = []   (holds a shell)
 *     the same, withheldBuiltinTools: ["shell"]         describe().tools = []   (holds nothing)
 *
 * A consumer trying to confirm that a role declared read-only really is one had no instrument. What
 * they had to do instead — measured, in a real session — was ask the agent to enumerate its own
 * catalog: needs a credential, needs the network, and returns the list the MODEL decided to write
 * rather than the one the runtime holds. The same session recorded a subagent answering *"I can't
 * run shell commands in this environment"* while its catalog listed `shell`. An attempt measures the
 * model's disposition; the catalog measures its authority.
 *
 * ## Why it takes options rather than an agent id
 *
 * The asked-for shape, and it is the right one: synchronous, credential-free, and answerable BEFORE
 * the agent runs — so a test can compare what it declared against what the runtime will declare.
 * `describe()` needs a registered agent and answers too late for that.
 *
 * ## Why it does not return a bare array
 *
 * Because a bare array reads as complete, and completeness is exactly what this cannot promise: MCP
 * tools need a live connection, plugin tools and the reasoning `think` tool are assembled per run.
 * Returning `string[]` would rebuild the defect one function over. `unresolved` names the sources
 * that were configured and could not be enumerated — and is EMPTY when none were, which is when the
 * list is genuinely the whole catalog.
 *
 * @public
 */

import { ConfigurationError } from "../../../errors.js";
import type { AgentOptions, BuiltinToolName } from "../../../types/agent.js";

/** The builtins this SDK registers, and the option that governs each. */
const ALWAYS_REGISTERED: readonly BuiltinToolName[] = ["shell"];
const MEMORY_BUILTINS: readonly BuiltinToolName[] = ["memory_search", "memory_get"];

/** A tool source that is configured but cannot be enumerated without running the agent. */
export type UnresolvedToolSource = "mcp" | "plugins" | "reasoning";

/** The result of {@link effectiveToolNames}. */
export interface EffectiveToolCatalog {
  /**
   * Every tool name resolvable from the options alone: the builtins still registered after
   * withholding, plus the names of the custom tools declared.
   */
  readonly names: readonly string[];
  /**
   * Sources that ARE configured and could not be enumerated here. Empty means `names` is the
   * complete catalog — which is the only condition under which it may be read as one.
   */
  readonly unresolved: readonly UnresolvedToolSource[];
}

/**
 * The tool names an agent created with `options` will offer the model, as far as the options can say.
 *
 * Pure and synchronous: no credential, no network, no registration. Intended for a test that asserts
 * a role is as narrow as it claims.
 *
 * ```ts
 * const { names, unresolved } = effectiveToolNames({ tools: [], withheldBuiltinTools: ["shell"] });
 * expect(names).toEqual([]);          // and `shell` is genuinely gone
 * expect(unresolved).toEqual([]);     // nothing else could contribute, so [] is the whole catalog
 * ```
 */
export function effectiveToolNames(options: AgentOptions): EffectiveToolCatalog {
  refuseCreatedTool(options);
  return { names: resolvableNames(options), unresolved: unresolvableSources(options) };
}

/**
 * Refuse a created tool where options were expected.
 *
 * Every field on `AgentOptions` is optional, so `SubAgent.create()`'s return — a `CustomTool`,
 * `{ name, description, inputSchema, handler }` — satisfies the type **by vacuity**, with no cast.
 * Measured: `@ts-expect-error` on that call is reported unused (`TS2578`), so the compiler genuinely
 * does not refuse it.
 *
 * What came back was worse than a wrong number: `{ names: ["shell"], unresolved: [] }` — the empty
 * `unresolved` claiming COMPLETENESS about an object the function never understood. A caller reads
 * that as "this subagent still announces a shell" and either disbelieves a fix that worked, or
 * "fixes" something on the strength of it. That is the #583 defect one function further on, and the
 * same argument that made this return `{ names, unresolved }` instead of a bare array forbids it.
 *
 * The detection is exact rather than heuristic: `AgentOptions` declares neither `handler` nor
 * `inputSchema`, so an object carrying both is a tool, not options. Throwing rather than answering,
 * because a wrong argument is a programming error and any answer here would be a second half-truth.
 *
 * Reported by the `theocode` session, against advice of mine that was wrong — I told them the
 * workaround of keeping the spec separate was no longer needed. It is.
 */
function refuseCreatedTool(options: AgentOptions): void {
  const candidate = options as { handler?: unknown; inputSchema?: unknown; name?: unknown };
  if (candidate.handler === undefined || candidate.inputSchema === undefined) return;
  throw new ConfigurationError(
    `effectiveToolNames received a created tool${typeof candidate.name === "string" ? ` ("${candidate.name}")` : ""}, not AgentOptions. ` +
      "`SubAgent.create()` returns a CustomTool and closes its spec inside the handler, so the spec " +
      "cannot be recovered from it. Pass the spec you built it from — keep it in a variable, or " +
      "extract it into a function the test can call.",
    { code: "effective_tools_expected_options" },
  );
}

/**
 * The names the options DO determine: builtins surviving the withholding, plus declared custom tools.
 */
function resolvableNames(options: AgentOptions): readonly string[] {
  const withheld = new Set<BuiltinToolName>(options.withheldBuiltinTools ?? []);
  // Memory builtins are registered only when memory is on. Reporting them unconditionally would
  // overstate the catalog; omitting them when it IS on would understate it. Both are this defect.
  const builtins = [
    ...ALWAYS_REGISTERED,
    ...(options.memory?.enabled === true ? MEMORY_BUILTINS : []),
  ];
  return [
    ...builtins.filter((builtin) => !withheld.has(builtin)),
    ...(options.tools ?? []).map((tool) => tool.name),
  ];
}

/**
 * The sources that ARE configured and cannot be enumerated without running the agent.
 *
 * Split from the names deliberately: this half is the honesty of the answer, and folding it into the
 * same function is what let the caller's complexity ceiling object to the pair rather than to either.
 */
function unresolvableSources(options: AgentOptions): readonly UnresolvedToolSource[] {
  const unresolved: UnresolvedToolSource[] = [];
  if (options.mcpServers !== undefined && Object.keys(options.mcpServers).length > 0) {
    unresolved.push("mcp");
  }
  if (hasPlugins(options.plugins)) unresolved.push("plugins");
  if (options.reasoning === true) unresolved.push("reasoning");
  return unresolved;
}

/**
 * `plugins` is a union — a settings object or an array of registered plugins — and both shapes can be
 * present-but-empty, which contributes nothing and must not be reported as unresolved.
 */
function hasPlugins(plugins: AgentOptions["plugins"]): boolean {
  if (plugins === undefined) return false;
  if (Array.isArray(plugins)) return plugins.length > 0;
  const enabled = (plugins as { enabled?: readonly string[] }).enabled;
  return enabled === undefined || enabled.length > 0;
}
