/**
 * `AgentOptions.modelFallback` — rerun a turn on another model when it fails before any output.
 *
 * The caller holds ONE `Run` (a {@link FallbackRun}) whose stream continues with the fallback's
 * items. Each attempt is dispatched on the same agent with `SendOptions.model` set to the next
 * fallback, so the user message (appended once by the send path) is in the transcript once.
 *
 * @internal
 */

import {
  ConfigurationError,
  ModelFallbackExhaustedError,
  type TheokitAgentError,
} from "../../errors.js";
import type { ModelSelection } from "../../types/agent.js";
import type { ConversationTurn } from "../../types/conversation.js";
import type { SDKMessage } from "../../types/messages.js";
import type {
  ModelAttempt,
  Run,
  RunOperation,
  RunResult,
  RunStatus,
  RunTimelineEvent,
  SendOptions,
} from "../../types/run.js";
import { generateRunId } from "../ids.js";

/** Error codes of a provider or network failure: the only ones a fallback model can cure. */
const FALLBACK_CODES = new Set([
  "rate_limit",
  "auth_failed",
  "timeout",
  "server_error",
  "model_unavailable",
  "network",
  "quota_exceeded",
  "invalid_model",
  "provider_unreachable",
  "credential_pool_exhausted",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

interface Failure {
  code: string;
  cause: unknown;
}

function codesOf(err: unknown): string[] {
  if (typeof err !== "object" || err === null) return [];
  const e = err as { code?: unknown; metadata?: { code?: unknown } };
  return [e.metadata?.code, e.code].filter((c): c is string => typeof c === "string");
}

/**
 * Classifies a failure along its cause chain. `undefined` means "do not fall over": a
 * `ConfigurationError` anywhere in the chain, an abort, or no provider/network code at all.
 */
function classifyFailure(err: unknown): Failure | undefined {
  let current: unknown = err;
  let found: string | undefined;
  for (let depth = 0; depth < 6 && current !== undefined && current !== null; depth++) {
    if (current instanceof ConfigurationError) return undefined;
    const codes = codesOf(current);
    if (codes.includes("aborted")) return undefined;
    found ??= codes.find((c) => FALLBACK_CODES.has(c));
    current = (current as { cause?: unknown }).cause;
  }
  return found === undefined ? undefined : { code: found, cause: err };
}

function failureCode(err: unknown): string {
  return codesOf(err)[0] ?? "unknown";
}

function isOutputMessage(m: SDKMessage): boolean {
  if (m.type === "tool_call") return true;
  if (m.type !== "assistant") return false;
  return m.message.content.some((b) => b.type === "tool_use" || b.text.length > 0);
}

function isOutputEvent(ev: RunTimelineEvent): boolean {
  if (ev.kind === "message") return isOutputMessage(ev.message);
  const t = ev.update.type;
  return t === "text-delta" || t.startsWith("tool-call") || t === "partial-tool-call";
}

type Dispatch = (options: SendOptions) => Promise<Run>;

type AttemptOutcome =
  | { kind: "done"; result: RunResult }
  | { kind: "failed"; failure: Failure; result?: RunResult };

export interface FallbackRunInit {
  dispatch: Dispatch;
  options: SendOptions;
  models: readonly string[];
  primaryModel: string;
  /** The primary's already-dispatched run, or the eligible error its dispatch rejected with. */
  first: { run: Run } | { error: Failure };
}

class FallbackRun implements Run {
  readonly id: string;
  readonly agentId: string;
  private current: Run | undefined;
  private final: RunResult | undefined;
  private cancelled = false;
  private readonly merged: RunTimelineEvent[] = [];
  private wake: { promise: Promise<void>; resolve: () => void } = makeWake();
  private readonly listeners = new Set<(s: RunStatus) => void>();
  private readonly attempts: ModelAttempt[] = [];
  private readonly done: Promise<RunResult>;
  private sawOutput = false;

  constructor(private readonly init: FallbackRunInit) {
    const firstRun = "run" in init.first ? init.first.run : undefined;
    this.id = firstRun?.id ?? generateRunId();
    this.agentId = firstRun?.agentId ?? "";
    this.current = firstRun;
    this.done = this.drive().then((r) => this.finish(r));
  }

  get status(): RunStatus {
    return this.final?.status ?? "running";
  }
  get result(): string | undefined {
    return this.final?.result;
  }
  get model(): ModelSelection | undefined {
    return this.current?.model;
  }
  get durationMs(): number | undefined {
    return this.final?.durationMs;
  }
  get createdAt(): number | undefined {
    return this.current?.createdAt;
  }

  wait(): Promise<RunResult> {
    return this.done;
  }

  async cancel(): Promise<void> {
    if (this.final !== undefined) return;
    this.cancelled = true;
    await this.current?.cancel();
  }

  async conversation(): Promise<ConversationTurn[]> {
    await this.done;
    return this.current?.conversation() ?? [];
  }

  supports(op: RunOperation): boolean {
    return this.current?.supports(op) ?? false;
  }

  unsupportedReason(op: RunOperation): string | undefined {
    return this.current?.unsupportedReason(op);
  }

  onDidChangeStatus(listener: (status: RunStatus) => void): () => void {
    this.listeners.add(listener);
    safeNotify(listener, this.status);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async *events(): AsyncGenerator<RunTimelineEvent, void> {
    let index = 0;
    for (;;) {
      while (index < this.merged.length) yield this.merged[index++] as RunTimelineEvent;
      if (this.final !== undefined) return;
      await this.wake.promise;
    }
  }

  async *stream(): AsyncGenerator<SDKMessage, void> {
    for await (const ev of this.events()) if (ev.kind === "message") yield ev.message;
  }

  private publish(ev: RunTimelineEvent): void {
    this.merged.push(ev);
    this.signal();
  }

  private signal(): void {
    const w = this.wake;
    this.wake = makeWake();
    w.resolve();
  }

  private finish(result: RunResult): RunResult {
    this.final = result;
    for (const l of this.listeners) safeNotify(l, result.status);
    this.signal();
    return result;
  }

  private async drive(): Promise<RunResult> {
    try {
      return await this.runAttempts();
    } catch (cause) {
      return errorResult({
        id: this.id,
        attempts: this.attempts,
        message: String(cause),
        code: failureCode(cause),
        cause,
      });
    }
  }

  private async runAttempts(): Promise<RunResult> {
    const ids = [this.init.primaryModel, ...this.init.models];
    const failures: Array<Failure & { model: string }> = [];
    let last: RunResult | undefined;
    for (let i = 0; i < ids.length; i++) {
      if (this.cancelled) return { id: this.id, status: "cancelled", modelAttempts: this.attempts };
      const model = ids[i] as string;
      const outcome = await this.attempt(i, model, i === ids.length - 1);
      if (outcome.kind === "done") return this.withAttempts(outcome.result, model);
      this.attempts.push({ model, outcome: "failed", errorCode: outcome.failure.code });
      failures.push({ ...outcome.failure, model });
      last = outcome.result;
    }
    return this.exhausted(failures, last);
  }

  private withAttempts(result: RunResult, model: string): RunResult {
    const entry: ModelAttempt =
      result.status === "error"
        ? { model, outcome: "failed", errorCode: failureCode(result.error?.cause ?? result.error) }
        : { model, outcome: "finished" };
    return { ...result, modelAttempts: [...this.attempts, entry] };
  }

  private exhausted(failures: Array<Failure & { model: string }>, last?: RunResult): RunResult {
    const err = new ModelFallbackExhaustedError(
      failures.map((f) => ({ model: f.model, errorCode: f.code })),
      { cause: failures[0]?.cause },
    );
    const base = last ?? { id: this.id, status: "error" as const };
    return {
      ...base,
      status: "error",
      modelAttempts: this.attempts,
      error: { message: err.message, code: "model_fallback_exhausted", cause: err },
    };
  }

  private async attempt(index: number, model: string, isLast: boolean): Promise<AttemptOutcome> {
    let run: Run;
    if (index === 0) {
      if ("error" in this.init.first) return { kind: "failed", failure: this.init.first.error };
      run = this.init.first.run;
    } else {
      const dispatched = await this.dispatchFallback(model);
      if ("failure" in dispatched) return { kind: "failed", failure: dispatched.failure };
      run = dispatched.run;
    }
    this.current = run;
    const result = await this.pump(run, isLast);
    const failure = this.classifyResult(result);
    if (failure !== undefined && !this.sawOutput) return { kind: "failed", failure, result };
    return { kind: "done", result };
  }

  private classifyResult(result: RunResult): Failure | undefined {
    if (result.status !== "error" || this.cancelled || this.init.options.signal?.aborted) {
      return undefined;
    }
    if (result.error === undefined) return undefined;
    const f = classifyFailure(result.error.cause ?? result.error);
    return f ?? classifyFailure({ code: result.error.code });
  }

  private async dispatchFallback(model: string): Promise<{ run: Run } | { failure: Failure }> {
    try {
      const run = await this.init.dispatch(this.attemptOptions(model));
      return { run };
    } catch (cause) {
      const failure = classifyFailure(cause);
      if (failure === undefined) throw cause;
      return { failure };
    }
  }

  private attemptOptions(model: string): SendOptions {
    return { ...this.init.options, model };
  }

  /** Forward the attempt's timeline, holding everything back until the first real output. */
  private async pump(run: Run, flushOnEnd: boolean): Promise<RunResult> {
    this.sawOutput = false;
    const held: RunTimelineEvent[] = [];
    for await (const ev of run.events()) this.forward(ev, held);
    const result = await run.wait();
    if ((result.result ?? "").length > 0) this.sawOutput = true;
    const discard = !this.sawOutput && !flushOnEnd && this.classifyResult(result) !== undefined;
    if (!discard) for (const h of held) this.publish(h);
    return result;
  }

  private forward(ev: RunTimelineEvent, held: RunTimelineEvent[]): void {
    if (isOutputEvent(ev)) this.sawOutput = true;
    if (!this.sawOutput) {
      held.push(ev);
      return;
    }
    for (const h of held.splice(0)) this.publish(h);
    this.publish(ev);
  }
}

function errorResult(args: {
  id: string;
  attempts: ModelAttempt[];
  message: string;
  code: string;
  cause: unknown;
}): RunResult {
  return {
    id: args.id,
    status: "error",
    modelAttempts: args.attempts,
    error: { message: args.message, code: args.code, cause: args.cause as TheokitAgentError },
  };
}

function makeWake(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function safeNotify(listener: (s: RunStatus) => void, status: RunStatus): void {
  try {
    listener(status);
  } catch {
    // listeners are user code; never propagate
  }
}

/**
 * Dispatches the primary attempt, then returns the stable fallback `Run`. A send that rejects with
 * anything but a provider/network error rejects as before.
 */
export async function dispatchWithModelFallback(args: {
  dispatch: Dispatch;
  options: SendOptions;
  models: readonly string[];
  primaryModel: string;
}): Promise<Run> {
  let first: FallbackRunInit["first"];
  try {
    first = { run: await args.dispatch(args.options) };
  } catch (cause) {
    const failure = classifyFailure(cause);
    if (failure === undefined) throw cause;
    first = { error: failure };
  }
  return new FallbackRun({ ...args, first });
}
