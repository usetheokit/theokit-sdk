/**
 * `AgentOptions.modelFallback` — one caller-visible {@link Run} that reruns the turn on the next
 * model while the failed attempt has produced no assistant output.
 *
 * Attempts are driven here, not by whoever consumes `stream()`, so `wait()` alone works. Each
 * attempt's events are held back until the attempt shows output (assistant text or a tool call);
 * from then on the turn stays on that model for good and its events flow straight through. A failed
 * attempt's held-back events are dropped, so the caller sees only the model that answered.
 *
 * @internal
 */

import { randomUUID } from "node:crypto";
import {
  AgentDisposedError,
  ConfigurationError,
  type ModelFallbackAttempt,
  ModelFallbackExhaustedError,
} from "../../errors.js";
import type { ModelSelection } from "../../types/agent.js";
import type { ConversationTurn } from "../../types/conversation.js";
import type { SDKMessage } from "../../types/messages.js";
import type { Run, RunOperation, RunResult, RunStatus, RunTimelineEvent } from "../../types/run.js";
import { normalizeModel } from "../runtime/model-selection.js";

export interface ModelFallbackArgs {
  /** Id of the model the primary attempt runs on (the agent's current model). */
  primaryModel: string;
  /** Fallback model ids, tried in order. */
  models: readonly string[];
  /** Dispatches one attempt; `undefined` means the agent's own model. */
  dispatch: (model: ModelSelection | undefined) => Promise<Run>;
  /** The turn's abort signal: an aborted turn never falls over. */
  signal?: AbortSignal | undefined;
}

type Settled = { run: Run } | { error: unknown };

async function settle(dispatch: () => Promise<Run>): Promise<Settled> {
  try {
    return { run: await dispatch() };
  } catch (error) {
    return { error };
  }
}

const isFatalDispatchError = (error: unknown): boolean =>
  error instanceof ConfigurationError || error instanceof AgentDisposedError;

/** Whether one SDK message is assistant output (text or a tool call). */
function messageIsOutput(message: SDKMessage): boolean {
  if (message.type === "tool_call") return true;
  if (message.type !== "assistant") return false;
  return message.message.content.some((b) => b.type !== "text" || b.text.length > 0);
}

const OUTPUT_DELTAS = new Set(["text-delta", "tool-call-started", "partial-tool-call"]);

function timelineIsOutput(event: RunTimelineEvent): boolean {
  if (event.kind === "message") return messageIsOutput(event.message);
  return OUTPUT_DELTAS.has(event.update.type);
}

function errorCodeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Events of one attempt, held back until it shows output. */
class AttemptGate {
  committed = false;
  private readonly messages: SDKMessage[] = [];
  private readonly timeline: RunTimelineEvent[] = [];

  constructor(private readonly sink: FallbackRun) {}

  onMessage(message: SDKMessage): void {
    if (messageIsOutput(message)) this.commit();
    if (this.committed) this.sink.pushMessage(message);
    else this.messages.push(message);
  }

  onTimeline(event: RunTimelineEvent): void {
    if (timelineIsOutput(event)) this.commit();
    if (this.committed) this.sink.pushTimeline(event);
    else this.timeline.push(event);
  }

  private commit(): void {
    if (this.committed) return;
    this.committed = true;
    this.flush();
  }

  /** Publish what was held back (the attempt is the turn's final one). */
  flush(): void {
    for (const m of this.messages.splice(0)) this.sink.pushMessage(m);
    for (const e of this.timeline.splice(0)) this.sink.pushTimeline(e);
  }
}

type AttemptEnd = { result: RunResult; gate: AttemptGate } | { error: unknown };

class FallbackRun implements Run {
  readonly id: string;
  readonly agentId: string;
  readonly createdAt = Date.now();
  private state: RunStatus = "running";
  private current: Run | undefined;
  private final: RunResult | undefined;
  private finalRun: Run | undefined;
  private cancelRequested = false;
  private readonly messages: SDKMessage[] = [];
  private readonly timelineLog: RunTimelineEvent[] = [];
  private wake: () => void = () => undefined;
  private wakeP: Promise<void>;
  private readonly listeners = new Set<(status: RunStatus) => void>();
  private resolveFinal: (r: RunResult) => void = () => undefined;
  private readonly finalP = new Promise<RunResult>((res) => {
    this.resolveFinal = res;
  });
  private readonly attempts: ModelFallbackAttempt[] = [];
  private readonly errors: unknown[] = [];

  constructor(
    private readonly args: ModelFallbackArgs,
    first: Settled,
  ) {
    this.id = "run" in first ? first.run.id : randomUUID();
    this.agentId = "run" in first ? first.run.agentId : "";
    this.wakeP = new Promise<void>((res) => {
      this.wake = res;
    });
    void this.drive(first);
  }

  get status(): RunStatus {
    return this.state;
  }
  get result(): string | undefined {
    return this.final?.result;
  }
  get model(): ModelSelection | undefined {
    return this.final?.model ?? this.current?.model;
  }
  get durationMs(): number | undefined {
    return this.final?.durationMs;
  }

  pushMessage(message: SDKMessage): void {
    this.messages.push(message);
    this.notify();
  }
  pushTimeline(event: RunTimelineEvent): void {
    this.timelineLog.push(event);
    this.notify();
  }
  private notify(): void {
    const w = this.wake;
    this.wakeP = new Promise<void>((res) => {
      this.wake = res;
    });
    w();
  }

  private async *replay<T>(log: T[]): AsyncGenerator<T, void> {
    let index = 0;
    while (this.final === undefined) {
      while (index < log.length) yield log[index++] as T;
      if (this.final !== undefined) break;
      await Promise.race([this.wakeP, this.finalP]);
    }
    while (index < log.length) yield log[index++] as T;
  }
  stream(): AsyncGenerator<SDKMessage, void> {
    return this.replay(this.messages);
  }
  events(): AsyncGenerator<RunTimelineEvent, void> {
    return this.replay(this.timelineLog);
  }
  wait(): Promise<RunResult> {
    return this.finalP;
  }

  async cancel(): Promise<void> {
    if (this.final !== undefined) return;
    this.cancelRequested = true;
    await this.current?.cancel();
  }

  async conversation(): Promise<ConversationTurn[]> {
    await this.finalP;
    return this.finalRun !== undefined ? this.finalRun.conversation() : [];
  }
  supports(op: RunOperation): boolean {
    return this.current?.supports(op) ?? false;
  }
  unsupportedReason(op: RunOperation): string | undefined {
    return this.current?.unsupportedReason(op);
  }
  onDidChangeStatus(listener: (status: RunStatus) => void): () => void {
    this.listeners.add(listener);
    try {
      listener(this.state);
    } catch {
      // listeners are user code; never propagate
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async drive(first: Settled): Promise<void> {
    const models = [this.args.primaryModel, ...this.args.models];
    for (let i = 0; i < models.length; i += 1) {
      const model = models[i] as string;
      const settled =
        i === 0 ? first : await settle(() => this.args.dispatch(normalizeModel(model)));
      const end = await this.attempt(settled);
      if (this.accept(end, model, i === models.length - 1)) return;
    }
  }

  /** Records a failed attempt and returns `false` to try the next model, else settles the run. */
  private accept(end: AttemptEnd, model: string, last: boolean): boolean {
    if (!this.shouldFallOver(end)) {
      this.settleWith(end);
      return true;
    }
    this.recordFailure(end, model);
    if (!last) return false;
    this.settleExhausted();
    return true;
  }

  private shouldFallOver(end: AttemptEnd): boolean {
    if (this.cancelRequested || this.args.signal?.aborted === true) return false;
    if ("error" in end) return !isFatalDispatchError(end.error);
    const { result, gate } = end;
    if (result.status !== "error" || gate.committed) return false;
    return !(result.error?.cause instanceof ConfigurationError);
  }

  private recordFailure(end: AttemptEnd, model: string): void {
    const error = "error" in end ? end.error : (end.result.error?.cause ?? end.result.error);
    const code =
      "error" in end ? errorCodeOf(end.error) : (end.result.error?.code ?? errorCodeOf(error));
    const message = "error" in end ? errorMessageOf(end.error) : end.result.error?.message;
    this.errors.push(error);
    this.attempts.push({
      model,
      ...(code !== undefined ? { errorCode: code } : {}),
      ...(message !== undefined ? { message } : {}),
    });
  }

  private async attempt(settled: Settled): Promise<AttemptEnd> {
    if ("error" in settled) return { error: settled.error };
    const run = settled.run;
    this.current = run;
    if (this.cancelRequested) await run.cancel();
    const gate = new AttemptGate(this);
    const pumps = [
      pump(run.stream(), (m) => gate.onMessage(m)),
      pump(run.events(), (e) => gate.onTimeline(e)),
    ];
    try {
      const result = await run.wait();
      await Promise.all(pumps);
      this.finalRun = run;
      return { result, gate };
    } catch (error) {
      return { error };
    }
  }

  private settleWith(end: AttemptEnd): void {
    if ("error" in end) {
      const detail = { message: errorMessageOf(end.error), ...codeField(errorCodeOf(end.error)) };
      this.finish(this.failedResult(detail));
      return;
    }
    end.gate.flush();
    this.finish(end.result);
  }

  private settleExhausted(): void {
    const exhausted = new ModelFallbackExhaustedError(this.attempts, this.errors[0]);
    const status = { type: "status", agent_id: this.agentId, run_id: this.id, status: "ERROR" };
    this.pushMessage({ ...status, message: exhausted.message } as SDKMessage);
    this.pushTimeline({
      kind: "message",
      message: { ...status, message: exhausted.message } as SDKMessage,
    });
    this.finish(
      this.failedResult({
        message: exhausted.message,
        code: "model_fallback_exhausted",
        cause: exhausted,
      }),
    );
  }

  private failedResult(error: NonNullable<RunResult["error"]>): RunResult {
    return { id: this.id, status: "error", durationMs: Date.now() - this.createdAt, error };
  }

  private finish(result: RunResult): void {
    const out: RunResult = {
      ...result,
      id: this.id,
      ...(this.attempts.length > 0 ? { modelFallbackAttempts: [...this.attempts] } : {}),
    };
    this.final = out;
    this.state = out.status;
    this.resolveFinal(out);
    this.notify();
    for (const l of this.listeners) {
      try {
        l(this.state);
      } catch {
        // listeners are user code; never propagate
      }
    }
  }
}

function codeField(code: string | undefined): { code?: string } {
  return code !== undefined ? { code } : {};
}

async function pump<T>(source: AsyncGenerator<T, void>, sink: (item: T) => void): Promise<void> {
  for await (const item of source) sink(item);
}

/**
 * Dispatch the primary attempt and wrap it. A `ConfigurationError` (or disposed agent) from the
 * primary dispatch rejects the send itself, as it does without a fallback.
 */
export async function runWithModelFallback(args: ModelFallbackArgs): Promise<Run> {
  const first = await settle(() => args.dispatch(undefined));
  if ("error" in first && isFatalDispatchError(first.error)) throw first.error;
  return new FallbackRun(args, first);
}
