import type { ModelSelection } from "../../../types/agent.js";
import type { ConversationTurn } from "../../../types/conversation.js";
import type { SDKMessage } from "../../../types/messages.js";
import type {
  Run,
  RunOperation,
  RunResult,
  RunStatus,
  RunTimelineEvent,
  SDKUserMessage,
} from "../../../types/run.js";
import { generateRunId } from "../../ids.js";
import { toTypedRunErrorDetail } from "../typed-run-error.js";
import { applyExtraRunFields } from "./fixture-responder.js";
import type { FixtureScript } from "./types.js";

/**
 * Shared bootstrap state extracted from `createLocalRun` / `createCloudRun`.
 * Keeps the body of each factory readable while avoiding a tiny duplicated
 * preamble.
 *
 * @internal
 */
export function prepareRunContext(message: string | SDKUserMessage): {
  userText: string;
  userImages: SDKUserMessage["images"];
  id: string;
  startTime: number;
} {
  // M35 (multimodal) — carry a structured message's images alongside its text so the agent loop can
  // attach them as image content blocks. A plain-string message has no images.
  const userText = typeof message === "string" ? message : message.text;
  const userImages = typeof message === "string" ? undefined : message.images;
  return { userText, userImages, id: generateRunId(), startTime: Date.now() };
}

/**
 * Shared state machine backing both `LocalRun` and `CloudRun`. Subclasses
 * override `bootstrap()` and `extendRunResult()` to inject runtime-specific
 * lifecycle behavior (async beforeComplete, git metadata) without
 * duplicating the surrounding plumbing.
 *
 * @internal
 */
export interface FixtureRunBaseOptions {
  id: string;
  agentId: string;
  model: ModelSelection | undefined;
  script: FixtureScript;
  supportedOps: Set<RunOperation>;
  startTime: number;
}

export abstract class FixtureRunBase implements Run {
  readonly id: string;
  readonly agentId: string;
  status: RunStatus = "running";
  result?: string;
  model?: ModelSelection;
  durationMs?: number;
  createdAt?: number;

  protected readonly script: FixtureScript;
  protected readonly startTime: number;
  protected readonly supportedOps: Set<RunOperation>;
  protected readonly listeners = new Set<(status: RunStatus) => void>();
  protected readonly terminationPromise: Promise<RunResult>;
  protected resolveTermination!: (value: RunResult) => void;
  protected terminated = false;
  private eventNotifier: { promise: Promise<void>; resolve: () => void };

  /**
   * theokit#140 - the run's single ordered timeline: structural events and live token/tool deltas,
   * in the order they actually occurred.
   *
   * Kept alongside `script.events` rather than replacing it. `stream()` is the SDKMessage view and
   * stays byte-identical for every existing consumer; this is the complete view, and a consumer
   * picks one. Merging them would have changed `stream()`'s element type - a breaking change for
   * an additive feature.
   */
  protected readonly timeline: RunTimelineEvent[] = [];

  constructor(options: FixtureRunBaseOptions) {
    this.id = options.id;
    this.agentId = options.agentId;
    if (options.model !== undefined) this.model = options.model;
    this.script = options.script;
    this.supportedOps = options.supportedOps;
    this.startTime = options.startTime;
    this.createdAt = options.startTime;
    this.terminationPromise = new Promise<RunResult>((resolve) => {
      this.resolveTermination = resolve;
    });
    this.eventNotifier = makeNotifier();
  }

  abstract bootstrap(): void;

  /**
   * Subclasses driving real (non-fixture) runtimes should call this after
   * pushing a new event into `this.script.events` so that already-awaiting
   * consumers of `stream()` wake up and yield it.
   */
  protected notifyNewEvents(): void {
    const current = this.eventNotifier;
    this.eventNotifier = makeNotifier();
    current.resolve();
  }

  /**
   * theokit#140 - every event of this run, in true order, from ONE source.
   *
   * ## The defect this replaces
   *
   * A consumer that needed tool calls interleaved with tokens had to fuse two surfaces by hand:
   * `stream()`, which was batched and post-completion, and `SendOptions.onDelta`, which was live.
   * Neither was complete alone - `onDelta` has no `run_started`/`system`, and `stream()` had no
   * token granularity - so the entire reconciliation, including its dedup, lived in the consumer.
   * `@theokit/agents` carried ~200 lines of exactly that, and it is the documented root of its
   * ordering bug (theokit#47), its namespace-dedup bug (#138) and its missing terminal frame (#142).
   *
   * The ordering is not reconstructed here. Both kinds are appended by the loop AS THEY HAPPEN, so
   * arrival order IS model order - there is nothing to sort, and no timestamp heuristic to get
   * wrong.
   *
   * `callId` is whatever the SDK's own `tool_call` events carry, so a consumer no longer holds two
   * id namespaces and no longer has to correlate them.
   */
  async *events(): AsyncGenerator<RunTimelineEvent, void> {
    let index = 0;
    while (!this.terminated) {
      while (index < this.timeline.length) {
        yield this.timeline[index++] as RunTimelineEvent;
      }
      if (this.terminated) break;
      await Promise.race([this.eventNotifier.promise, this.terminationPromise]);
    }
    // Drain what landed between the last wake-up and termination. Without this, the final events of
    // a fast run are silently lost - the same shape of bug as the missing terminal frame (#142).
    while (index < this.timeline.length) {
      yield this.timeline[index++] as RunTimelineEvent;
    }
    for await (const message of this.terminalErrorEvent()) {
      yield { kind: "message", message };
    }
  }

  /** theokit#140 - append to the timeline and wake `events()`. */
  protected pushTimeline(event: RunTimelineEvent): void {
    this.timeline.push(event);
    this.notifyNewEvents();
  }

  async *stream(): AsyncGenerator<SDKMessage, void> {
    let index = 0;
    while (!this.terminated) {
      while (index < this.script.events.length) {
        yield this.script.events[index++] as SDKMessage;
      }
      if (this.terminated) break;
      await Promise.race([this.eventNotifier.promise, this.terminationPromise]);
    }
    while (index < this.script.events.length) {
      yield this.script.events[index++] as SDKMessage;
    }
    yield* this.terminalErrorEvent();
  }

  /**
   * theokit#101 — when the run ends in error, `stream()` has to SAY SO.
   *
   * The error always existed: the loop records it in `ctx.error` and `wait()` returns
   * `status: 'error'` with the message. Only `stream()` failed to mention it — it drains
   * `script.events` and stops. A provider failure (404 "No endpoints found", auth, timeout)
   * produced a turn that looked successful and empty, on EVERY surface consuming the
   * stream: HTTP web, MCP, stdio, TUI in-process.
   *
   * A silent error is the worst kind (Unbreakable Rule 8). And the asymmetry was what made it
   * hard to diagnose: anyone debugging via `wait()` saw the error and would not reproduce the
   * report of anyone debugging via the stream.
   *
   * It emits `SDKStatusMessage` with `status: "ERROR"` — the type ALREADY EXISTS in the `SDKMessage` union
   * and is already expected by consumers. A new type would be breaking for every consumer doing
   * an exhaustive switch; this one is additive, and a consumer ignoring `status` simply
   * behaves as before — never worse than today.
   */
  private *terminalErrorEvent(): Generator<SDKMessage> {
    if (this.status !== "error") return;
    const detail = this.script.errorDetail;
    yield {
      type: "status",
      agent_id: this.agentId,
      run_id: this.id,
      status: "ERROR",
      // Without a message, the consumer knows THAT it failed and not WHAT — which is half the defect.
      ...(detail?.message !== undefined ? { message: detail.message } : {}),
    } satisfies SDKMessage;
  }

  wait(): Promise<RunResult> {
    return this.terminationPromise;
  }

  cancel(): Promise<void> {
    if (this.terminated) return Promise.resolve();
    this.transitionTo("cancelled");
    return Promise.resolve();
  }

  conversation(): Promise<ConversationTurn[]> {
    return Promise.resolve(this.script.conversation);
  }

  supports(op: RunOperation): boolean {
    return this.supportedOps.has(op);
  }

  unsupportedReason(op: RunOperation): string | undefined {
    return this.supportedOps.has(op) ? undefined : `Operation ${op} is not supported`;
  }

  onDidChangeStatus(listener: (status: RunStatus) => void): () => void {
    this.listeners.add(listener);
    this.notifyListener(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  protected transitionTo(nextStatus: RunStatus): void {
    if (this.terminated) return;
    this.terminated = true;
    this.status = nextStatus;
    this.durationMs = Date.now() - this.startTime;
    if (nextStatus !== "cancelled" && this.script.result !== undefined) {
      this.result = this.script.result;
    }
    this.notifyAllListeners();
    this.eventNotifier.resolve();
    this.resolveTermination(this.buildResult(nextStatus));
  }

  protected buildResult(status: RunStatus): RunResult {
    const base: RunResult = {
      id: this.id,
      status: status === "running" ? "finished" : status,
      ...(this.model !== undefined ? { model: this.model } : {}),
      durationMs: this.durationMs ?? Date.now() - this.startTime,
    };
    if ((status === "finished" || status === "error") && this.script.result !== undefined) {
      base.result = this.script.result;
    }
    // Surface the script's errorDetail (set by emitErrorEvent) so wait()
    // callers see the cause without having to drain stream().
    if (status === "error" && this.script.errorDetail !== undefined) {
      base.error = toTypedRunErrorDetail(this.script.errorDetail);
    }
    applyScriptMetrics(base, this.script);
    return this.extendRunResult(applyExtraRunFields(base, this.script));
  }

  /** Subclasses override to attach runtime-specific fields (e.g. cloud git info). */
  protected extendRunResult(result: RunResult): RunResult {
    return result;
  }

  /** Whether `onDidChangeStatus` should fire immediately with the current status. */
  protected notifyImmediately(): boolean {
    return false;
  }

  private notifyListener(listener: (status: RunStatus) => void): void {
    if (!this.notifyImmediately()) return;
    try {
      listener(this.status);
    } catch {
      // listeners are user code; never propagate
    }
  }

  private notifyAllListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.status);
      } catch {
        // listeners are user code; never propagate
      }
    }
  }
}

function makeNotifier(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Copy the script's run-metric fields onto the result (D376/D377 usage + cost
 * regardless of status; M1-2 silent-truncation signal). Extracted from
 * `buildResult` to keep it under the cognitive-complexity cap.
 */
function applyScriptMetrics(base: RunResult, script: FixtureScript): void {
  if (script.usage !== undefined) base.usage = script.usage;
  if (script.cost !== undefined) base.cost = script.cost;
  if (script.stoppedAtIterationLimit === true) base.stoppedAtIterationLimit = true;
  if (script.stoppedByDoomLoop === true) base.stoppedByDoomLoop = true;
  // SE3 — forward the turn's provenance onto the run result.
  if (script.origin !== undefined) base.origin = script.origin;
}
