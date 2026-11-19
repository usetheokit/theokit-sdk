/**
 * A2A (Agent-to-Agent) sub-path barrel (T20.1, ADR D453).
 * Exported via `@theokit/sdk/a2a`.
 * @public
 */

export type { ToolContextMessage } from "../types/agent-prims.js";
export { AgentMailbox } from "./agent-mailbox.js";
export {
  A2APeerNotRegisteredError,
  A2ARemoteRequestUnsupportedError,
  A2ARequestTimeoutError,
  MessageBus,
  type RequestOptions,
} from "./message-bus.js";
export {
  type DelegationCompleteContext,
  type DelegationCompleteDecision,
  type DelegationStartContext,
  type DelegationStartDecision,
  MaxDelegationDepthError,
  type MessageFilterArgs,
  SubAgent,
  type SubAgentSpec,
} from "./subagent.js";
export { type A2ATransport, inMemoryTransport } from "./transport.js";
export type { A2AMessage, MessageHandler } from "./types.js";
