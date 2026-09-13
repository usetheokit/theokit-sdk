import type { AgentOptions, ModelSelection, SystemPromptContext } from "../../../types/agent.js";
import { resolveCompatSources } from "../compat/compat-config-file.js";
import type { FileContextManager } from "../context/context-manager.js";
import type { MemoryFact } from "../memory-glue/memory-store.js";
import { SkillsManager } from "../skills/skills-manager.js";
import { reasoningActive } from "./native-reasoning.js";
import type { SystemPromptPipeline } from "./pipeline.js";
import type { SystemPromptAssemblyContext } from "./types.js";

/**
 * Bundles the per-agent state that the assembly helpers need without forcing
 * LocalAgent to expose private fields. Extracted from LocalAgent so the parent
 * class stays under the G8 LoC budget.
 *
 * @internal
 */
export interface LocalAssemblyInputs {
  agentId: string;
  workspaceCwd: string;
  model: ModelSelection | undefined;
  options: AgentOptions;
  context: FileContextManager | undefined;
  skillsManager: SkillsManager | undefined;
  /** SE22 — needed to build the per-send transient manager when `options.skills` is a resolver. */
  settingSourcesIncludeProject: boolean;
  systemPromptPipeline: SystemPromptPipeline;
}

/**
 * SE22 — resolve the effective skills for THIS send. A static
 * `SkillsSettings` object uses the create-time (base) manager unchanged; a
 * {@link import("../../../types/agent.js").SkillsResolver} function is evaluated
 * with the per-send context and drives a fresh transient manager. A throwing
 * resolver propagates (fail-fast, no silent fallback — Rule 8).
 *
 * @internal
 */
export async function resolveSendSkills(
  inputs: LocalAssemblyInputs,
  userText: string,
  memoryFacts: ReadonlyArray<MemoryFact>,
): Promise<{ manager: SkillsManager | undefined; autoInject: boolean }> {
  const skills = inputs.options.skills;
  if (typeof skills !== "function") {
    return { manager: inputs.skillsManager, autoInject: skills?.autoInject ?? true };
  }
  const settings = await skills({
    agentId: inputs.agentId,
    cwd: inputs.workspaceCwd,
    model: inputs.model,
    userMessage: userText,
    memory: memoryFacts.map((fact) => ({ text: fact.text })),
  });
  const manager = new SkillsManager(
    inputs.workspaceCwd,
    settings.enabled,
    inputs.settingSourcesIncludeProject,
    settings.skillsDir,
    settings.inline,
    resolveCompatSources(inputs.options, inputs.workspaceCwd),
  );
  // `initialize()` skips the filesystem scan when project sources are off (fast
  // path — inline-only), so a per-send resolver is cheap for inline skills.
  await manager.initialize();
  return { manager, autoInject: settings.autoInject ?? true };
}

/**
 * Build the base {@link SystemPromptContext} surfaced to a resolver function.
 * Resolves skills lazily — never throws when the manager is absent. The
 * effective manager defaults to the base one; the assembly path passes the
 * per-send resolved manager (SE22).
 *
 * @internal
 */
export async function buildSystemPromptContext(
  inputs: LocalAssemblyInputs,
  userText: string,
  memoryFacts: ReadonlyArray<MemoryFact>,
  manager: SkillsManager | undefined = inputs.skillsManager,
): Promise<SystemPromptContext> {
  const skills = manager !== undefined ? await manager.list() : [];
  return {
    agentId: inputs.agentId,
    cwd: inputs.workspaceCwd,
    model: inputs.model,
    // This is the ONLY place the model learns which skills exist, which is what makes
    // `disable-model-invocation` enforceable rather than decorative. The scaffold had been writing
    // authorization frontmatter that the parser discarded, so the default was disclose-all.
    //
    // A disclosure rule, not an execution rule: `skills.get(name)` still resolves a hidden skill,
    // because a caller naming one has already made the decision this field keeps away from the
    // model. Widening it to execution would break the case the field is FOR — a side-effecting
    // skill a human may run and the model may not propose.
    skills: skills
      .filter((skill) => skill.disableModelInvocation !== true)
      .map((skill) => ({ name: skill.name, description: skill.description })),
    userMessage: userText,
    memory: memoryFacts.map((fact) => ({ text: fact.text })),
  };
}

/**
 * Build the full {@link SystemPromptAssemblyContext} that the pipeline
 * consumes, including the optional active-memory summary and context snapshot.
 *
 * @internal
 */
export interface AssemblyRequest {
  readonly inputs: LocalAssemblyInputs;
  readonly userText: string;
  readonly baseSystemPrompt: string | undefined;
  readonly memoryFacts: ReadonlyArray<MemoryFact>;
  readonly activeMemorySummary: string | undefined;
  /** T3 — the per-send in-scope file set that activates path-scoped rules. */
  readonly contextPaths?: readonly string[] | undefined;
}

export async function buildAssemblyContext({
  inputs,
  userText,
  baseSystemPrompt,
  memoryFacts,
  activeMemorySummary,
  contextPaths,
}: AssemblyRequest): Promise<SystemPromptAssemblyContext> {
  // SE22 — resolve skills ONCE per send; the resolver (if any) runs here, before
  // assembly. `buildSystemPromptContext` receives the resolved manager so the
  // <skills> block reflects the per-send resolution.
  const resolved = await resolveSendSkills(inputs, userText, memoryFacts);
  const baseCtx = await buildSystemPromptContext(inputs, userText, memoryFacts, resolved.manager);
  const assemblyCtx: SystemPromptAssemblyContext = {
    ...baseCtx,
    skillsAutoInject: resolved.autoInject,
    memoryAutoInject: inputs.options.memory?.autoInject ?? true,
  };
  if (baseSystemPrompt !== undefined) assemblyCtx.baseSystemPrompt = baseSystemPrompt;
  if (activeMemorySummary !== undefined && activeMemorySummary.length > 0) {
    assemblyCtx.activeMemorySummary = activeMemorySummary;
  }
  // SE37 — inject the reasoning preamble when `reasoning: true` and the model is
  // not already reasoning natively (guard + one-time warn inside reasoningActive).
  if (reasoningActive(inputs.options.reasoning, inputs.model)) {
    assemblyCtx.reasoning = true;
  }
  if (inputs.context !== undefined) {
    // T3 — apply the per-send in-scope file set so path-scoped rules
    // (`.theokit/rules/*.md`, `.cursor/rules/*.mdc` globs) activate for THIS
    // send. No-op when the scope is unchanged / never set (non-users pay nothing).
    await inputs.context.applyScope(contextPaths);
    const internal = inputs.context.internalAssemblySnapshot();
    assemblyCtx.contextSnapshot = { sources: internal.sources };
    if (internal.maxTokens !== undefined) assemblyCtx.contextMaxTokens = internal.maxTokens;
  }
  return assemblyCtx;
}

/**
 * Convenience wrapper: build the assembly context and run it through the
 * pipeline in one call. Returns the final system-prompt string (or undefined
 * if the pipeline produces no output).
 *
 * @internal
 */
export async function assembleSystemPromptForSend(
  request: AssemblyRequest,
): Promise<string | undefined> {
  const ctx = await buildAssemblyContext(request);
  return request.inputs.systemPromptPipeline.assemble(ctx);
}
