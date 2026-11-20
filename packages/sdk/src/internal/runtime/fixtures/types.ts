import type { AgentDefinition, AgentOptions, ModelSelection } from "../../../types/agent.js";
import type { ConversationTurn } from "../../../types/conversation.js";
import type { SDKMessage } from "../../../types/messages.js";
import type { MessageOrigin, RunStatus, SendOptions } from "../../../types/run.js";
// From the declaring module, not the `internal/session/` barrel. That barrel reaches into local-agent
// through `compact-session.ts`, and the identical import in two other files was the return edge of two
// madge cycles this session.
import type { SessionMessage } from "../../../types/session-message.js";
import type { CostBreakdown, TokenUsage } from "../../../types/usage.js";
import type { MemoryFact } from "../memory-glue/memory-store.js";

/**
 * Pre-computed fixture script for a single Run. The local/cloud Run impls
 * play this back to consumers — events for `stream()`, finalStatus + result
 * for `wait()`, structured conversation for `run.conversation()`, and an
 * optional async hook for side effects (memory persistence, etc.).
 *
 * @internal
 */
export interface FixtureScript {
  events: SDKMessage[];
  finalStatus: RunStatus;
  result?: string;
  cancellable: boolean;
  conversation: ConversationTurn[];
  /** Extra fields surfaced on the RunResult (e.g. provider routing info). */
  extraRunFields?: Record<string, unknown>;
  /**
   * Structured error attached to the final RunResult when finalStatus is
   * `"error"`. Mirrors {@link RunResult.error} so callers that wait()
   * instead of stream() can still surface the cause.
   */
  errorDetail?: { message: string; code?: string; cause?: unknown };
  /**
   * Aggregated token usage observed during the run (ADR D376). Populated
   * by the real agent loop from `AgentLoopOutput.usage`; left undefined
   * by fixture responders unless they explicitly fabricate a value.
   */
  usage?: TokenUsage;
  /**
   * Cost breakdown matching `usage` (ADR D377). `cost.status` indicates
   * how to trust the figure (`estimated` / `unknown` / `included`).
   */
  cost?: CostBreakdown;
  /**
   * M1-2 (T2.2): true when the real agent loop stopped at its iteration
   * ceiling with tool work still pending (silent truncation). Copied from
   * `AgentLoopOutput.stoppedAtIterationLimit` onto `RunResult`.
   */
  stoppedAtIterationLimit?: boolean;
  /** Doom-loop guard: true when the loop stopped on identical-repeat tool calls. Copied from
   *  `AgentLoopOutput.stoppedByDoomLoop` onto `RunResult.stoppedByDoomLoop`. */
  stoppedByDoomLoop?: boolean;
  /** Tool calls a gate deferred; set with `finalStatus: "deferred"`. */
  deferredToolCalls?: readonly import("../../../types/run.js").DeferredToolCall[];
  /**
   * SE3 — provenance of the turn (captured from `SendOptions.origin` at run
   * construction). Copied onto `RunResult.origin` by `applyScriptMetrics`.
   */
  origin?: MessageOrigin;
  /** Optional async hook executed before the run terminates. */
  beforeComplete?: () => Promise<void>;
}

/**
 * Input the responder uses to pattern-match the user message and build the
 * appropriate script. Includes everything the responder needs to react to
 * the agent's configured capabilities.
 *
 * @internal
 */
export interface FixtureRequest {
  agentId: string;
  runId: string;
  model: ModelSelection;
  userMessage: string;
  runtime: "local" | "cloud";
  agentOptions: AgentOptions;
  sendOptions: SendOptions;
  workspaceCwd: string | undefined;
  subagents: Record<string, AgentDefinition>;
  settingSourcesIncludeProject: boolean;
  memoryFacts: MemoryFact[];
  sessionMessages: SessionMessage[];
  projectMcpServers: Record<string, unknown>;
  /** Async hook invoked when "Remember:" patterns persist a new fact. */
  persistMemoryFact?: (fact: MemoryFact) => Promise<void>;
}
