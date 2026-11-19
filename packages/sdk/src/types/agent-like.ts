/**
 * Owner: `src/` (0 importers besides the `src/index.ts` barrel; consumers are external wrappers
 * and test doubles). Narrow ports over `SDKAgent` and `Run`.
 */
import type { SDKMessage } from "./messages.js";
import type { RunResult, RunStatus, SDKUserMessage, SendOptions } from "./run.js";

/**
 * Narrow run port: the part of {@link import("./run.js").Run} a wrapper, fake or
 * decorator needs. `Run` satisfies it with no cast. Uses the SDK's own
 * `RunStatus` and `RunResult`, never `string`.
 *
 * @public
 */
export interface RunLike {
  readonly status: RunStatus;
  stream(): AsyncIterable<SDKMessage>;
  wait(): Promise<RunResult>;
  cancel(): Promise<void>;
}

/**
 * Narrow agent port: the part of `SDKAgent` a wrapper, test double or failover
 * decorator needs. `SDKAgent` satisfies it with no cast.
 *
 * @public
 */
export interface AgentLike {
  readonly agentId: string;
  send(message: string | SDKUserMessage, options?: SendOptions): Promise<RunLike>;
  dispose?(): Promise<void>;
}
