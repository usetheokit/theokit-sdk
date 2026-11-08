/**
 * Dispatch helpers extracted from `LocalAgent` to keep its file under
 * G8 (≤400 LoC). Builds the args for real-LLM and fixture run paths.
 *
 * @internal
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentDefinition, AgentOptions, ModelSelection } from "../../types/agent.js";
import type { Run, SDKUserMessage, SendOptions } from "../../types/run.js";
import type { MemoryToolSpec, SteerQueue } from "../agent-loop/types.js";
import { resolveApiKey } from "../env.js";
import { theokitConfigRoot } from "../persistence/paths.js";
import type { PersonalityPreset } from "../personality/types.js";
import type { PluginManager } from "../plugins/manager.js";
import { shouldUseRealLocalRuntime } from "../runtime/fixtures/fixture-mode.js";
import type { HooksExecutor } from "../runtime/hooks/hooks-executor.js";
import type { MemoryFact } from "../runtime/memory-glue/memory-store.js";
import { getSessionMessages } from "../session/index.js";
import { createLocalRun } from "./local-run.js";
import { createRealLocalRun } from "./real-local-run.js";

export interface DispatchInputs {
  agentId: string;
  model: ModelSelection | undefined;
  options: AgentOptions;
  workspaceCwd: string;
  hooksExecutor: HooksExecutor;
  pluginManager: PluginManager;
  resolvedSubagents: Record<string, AgentDefinition>;
  settingSourcesIncludeProject: boolean;
}

export function buildRealRunOptions(args: {
  inputs: DispatchInputs;
  message: string | SDKUserMessage;
  options: SendOptions;
  systemPrompt: string | undefined;
  priorMessages: ReadonlyArray<{ role: "user" | "assistant"; text: string }>;
  memoryTools: ReadonlyArray<MemoryToolSpec> | undefined;
  personalityToolWhitelist?: ReadonlyArray<string>;
  personalityName?: string;
  steerQueue?: SteerQueue;
}): Parameters<typeof createRealLocalRun>[0] {
  return {
    agentId: args.inputs.agentId,
    model: args.inputs.model,
    message: args.message,
    agentOptions: args.inputs.options,
    subagents: args.inputs.resolvedSubagents,
    sendOptions: args.options,
    workspaceCwd: args.inputs.workspaceCwd,
    hooks: args.inputs.hooksExecutor,
    pluginManager: args.inputs.pluginManager,
    ...(args.systemPrompt !== undefined ? { systemPrompt: args.systemPrompt } : {}),
    ...(args.options.onStep !== undefined ? { onStep: args.options.onStep } : {}),
    ...(args.options.onDelta !== undefined ? { onDelta: args.options.onDelta } : {}),
    ...(args.priorMessages.length > 0 ? { priorMessages: args.priorMessages } : {}),
    ...(args.memoryTools !== undefined && args.memoryTools.length > 0
      ? { memoryTools: args.memoryTools }
      : {}),
    ...(args.personalityToolWhitelist !== undefined
      ? { personalityToolWhitelist: args.personalityToolWhitelist }
      : {}),
    ...(args.personalityName !== undefined ? { personalityName: args.personalityName } : {}),
    ...(args.steerQueue !== undefined ? { steerQueue: args.steerQueue } : {}),
  };
}

export async function createFixtureRunHelper(args: {
  inputs: DispatchInputs;
  message: string | SDKUserMessage;
  options: SendOptions;
  systemPrompt: string | undefined;
  memoryFacts: ReadonlyArray<MemoryFact>;
}): Promise<Run> {
  const sessionMessages = getSessionMessages(args.inputs.agentId);
  const projectMcpServers = args.inputs.settingSourcesIncludeProject
    ? await readProjectMcpServers(args.inputs.workspaceCwd)
    : {};
  return createLocalRun({
    agentId: args.inputs.agentId,
    model: args.inputs.model,
    message: args.message,
    agentOptions: args.inputs.options,
    sendOptions: args.options,
    workspaceCwd: args.inputs.workspaceCwd,
    subagents: args.inputs.resolvedSubagents,
    settingSourcesIncludeProject: args.inputs.settingSourcesIncludeProject,
    memoryFacts: [...args.memoryFacts],
    sessionMessages,
    projectMcpServers,
    ...(args.systemPrompt !== undefined ? { systemPrompt: args.systemPrompt } : {}),
  });
}

export async function dispatchLocalRun(args: {
  inputs: DispatchInputs;
  message: string | SDKUserMessage;
  sendOptions: SendOptions;
  systemPrompt: string | undefined;
  memoryFacts: ReadonlyArray<MemoryFact>;
  priorMessages: ReadonlyArray<{ role: "user" | "assistant"; text: string }>;
  memoryTools: ReadonlyArray<MemoryToolSpec> | undefined;
  activePreset: PersonalityPreset | undefined;
  steerQueue?: SteerQueue;
}): Promise<Run> {
  const apiKey = resolveApiKey(args.inputs.options.apiKey);
  if (shouldUseRealLocalRuntime(apiKey)) {
    return createRealLocalRun(
      buildRealRunOptions({
        inputs: args.inputs,
        message: args.message,
        options: args.sendOptions,
        systemPrompt: args.systemPrompt,
        priorMessages: args.priorMessages,
        memoryTools: args.memoryTools,
        ...(args.steerQueue !== undefined ? { steerQueue: args.steerQueue } : {}),
        ...(args.activePreset?.tools !== undefined
          ? { personalityToolWhitelist: args.activePreset.tools }
          : {}),
        ...(args.activePreset !== undefined ? { personalityName: args.activePreset.name } : {}),
      }),
    );
  }
  return createFixtureRunHelper({
    inputs: args.inputs,
    message: args.message,
    options: args.sendOptions,
    systemPrompt: args.systemPrompt,
    memoryFacts: args.memoryFacts,
  });
}

async function readProjectMcpServers(cwd: string): Promise<Record<string, unknown>> {
  const path = join(theokitConfigRoot(cwd), "mcp.json");
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as { servers?: Record<string, unknown> };
    return parsed.servers ?? {};
  } catch {
    return {};
  }
}
