/**
 * Queue-mode state for `LocalAgent.send` (`SendOptions.queueMode`): the steer queue of the turn in
 * flight and the pending collect batch.
 *
 * @internal
 */

import type { Run, SDKUserMessage } from "../../types/run.js";
import type { SteerQueue } from "../agent-loop/types.js";

/** Steer queue of one turn. Refuses pushes once closed so a late message is never silently lost. */
export class TurnSteerQueue implements SteerQueue {
  private pending: string[] = [];
  private closed = false;

  /** @returns false when the turn can no longer pick the message up. */
  push(text: string): boolean {
    if (this.closed) return false;
    this.pending.push(text);
    return true;
  }

  drain(): string[] {
    const taken = this.pending;
    this.pending = [];
    return taken;
  }

  drainOrClose(): string[] {
    const taken = this.drain();
    if (taken.length === 0) this.closed = true;
    return taken;
  }

  /** Stop accepting and hand back what no loop iteration picked up. */
  closeAndTake(): string[] {
    this.closed = true;
    return this.drain();
  }
}

/** The turn currently holding the send lock. */
export interface ActiveTurn {
  readonly steer: TurnSteerQueue;
  readonly run: Promise<Run>;
}

/** Messages waiting to become one followup turn. */
export interface CollectBatch {
  readonly messages: Array<string | SDKUserMessage>;
  readonly run: Promise<Run>;
}

/** Join a collected batch into the single message the batched turn sends. */
export function joinCollected(
  messages: ReadonlyArray<string | SDKUserMessage>,
): string | SDKUserMessage {
  if (messages.length === 1) return messages[0] as string | SDKUserMessage;
  const texts = messages.map((m) => (typeof m === "string" ? m : m.text));
  const images = messages.flatMap((m) => (typeof m === "string" ? [] : (m.images ?? [])));
  const text = texts.join("\n\n");
  return images.length > 0 ? { text, images } : text;
}

export function hasImages(message: string | SDKUserMessage): boolean {
  return typeof message !== "string" && (message.images?.length ?? 0) > 0;
}
