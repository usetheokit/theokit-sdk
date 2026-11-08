/**
 * What one local run is built from.
 *
 * Its own module because `real-local-run.ts` and the two files split out of it —
 * `real-local-run-provider.ts` and `real-local-run-mcp.ts` — all take it, and having any of them own
 * it makes the other two import back into it. madge caught exactly that: the first version of the
 * split put the interface in `real-local-run.ts` and produced a `provider -> run -> provider` pair.
 *
 * A type-only cycle erases at compile and breaks no build, but it is the same design statement in
 * the wrong direction as any other, and this repo has a rule about it (`.dependency-cruiser.cjs`
 * G7a, and `types/agent-prims.ts`, which exists for the identical reason).
 *
 *
 * `SessionMessage` comes from `types/session-message.ts` and NOT from the `internal/session/` barrel:
 * that barrel reaches back here through `compact-session.ts`, and madge reported the loop the moment
 * this file existed. Importing the declaring module instead of the barrel is the cheaper half of the
 * same lesson `types/agent-prims.ts` records.
 *
 * NAMED `-options` RATHER THAN `-types`: `tests/lint/types-module-naming.test.ts` refuses a
 * `X-types.ts` in a folder with no bare `types.ts` to distinguish it from, on the grounds that the
 * prefix then carries no information. The gate caught this file on its first commit, which is what
 * it is for.
 *
 * @internal
 */

import type { AgentDefinition, AgentOptions, ModelSelection } from "../../types/agent.js";
import type { SDKUserMessage, SendOptions } from "../../types/run.js";
import type { SessionMessage } from "../../types/session-message.js";
import type { MemoryToolSpec } from "../agent-loop/types.js";
import type { HooksExecutor } from "../runtime/hooks/hooks-executor.js";

/**
 * Real local Run. When the local agent has a non-fixture API key plus at
 * least one provider env credential, the agent loop drives a real LLM and
 * dispatches real tools. The output is materialized into the same
 * `FixtureScript` shape used by the fixture runtime so the `Run` surface
 * stays uniform.
 *
 * @internal
 */

export interface CreateRealLocalRunOptions {
  agentId: string;
  model: ModelSelection | undefined;
  message: string | SDKUserMessage;
  agentOptions: AgentOptions;
  /**
   * File-based + inline subagents merged by `loadSubagents` (`.theokit/agents/*.md`
   * plus `agentOptions.agents`). When present, these — not just the inline
   * `agentOptions.agents` — become the delegation toolset, so a subagent defined
   * only on disk is callable against a real model (not fixture-only).
   */
  subagents?: Record<string, AgentDefinition>;
  sendOptions: SendOptions;
  workspaceCwd: string;
  hooks: HooksExecutor;
  /** T4.1 — PluginManager threaded from LocalAgent for plugin tools + pre_tool_call hooks. */
  pluginManager?: import("../plugins/manager.js").PluginManager;
  /** Takes the messages steered into this turn (`queueMode: "steer"`). */
  drainSteering?: () => string[];
  /** Pre-resolved system prompt threaded by `LocalAgent.send`. */
  systemPrompt?: string;
  onStep?: SendOptions["onStep"];
  onDelta?: SendOptions["onDelta"];
  /** Prior conversation history (excluding the current user message). */
  priorMessages?: ReadonlyArray<SessionMessage>;
  /** Memory tools to register with the LLM (Phase 6 of memory-system-peer-project-parity). */
  memoryTools?: ReadonlyArray<MemoryToolSpec>;
  /**
   * Active personality tool whitelist (T4.1, ADR D167). When defined,
   * `customTools` are filtered to this subset; missing entries log a
   * one-shot warn. Undefined = no filter.
   */
  personalityToolWhitelist?: ReadonlyArray<string>;
  /** Active personality slug — used in personality-filter warnings. */
  personalityName?: string;
}
