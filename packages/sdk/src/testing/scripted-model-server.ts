import { TheokitAgentError } from "../errors-base.js";
import {
  type FakeModelRequest,
  type FakeModelServer,
  type ModelAnswer,
  startModelServer,
} from "./fake-model-server.js";

/** One scripted model turn: text, tool calls (with optional text), or an HTTP error. */
export type ScriptedStep =
  | { readonly text: string }
  | {
      readonly toolCalls: ReadonlyArray<{
        readonly name: string;
        readonly input: Record<string, unknown>;
        readonly id?: string;
      }>;
      readonly text?: string;
    }
  | {
      readonly error: {
        readonly status: number;
        readonly body?: unknown;
        readonly retryAfterSeconds?: number;
      };
    };

/** A fake model server that answers a fixed sequence of steps; see {@link startScriptedModelServer}. */
export interface ScriptedModelServer extends FakeModelServer {
  /** Throws the first {@link UnexpectedModelCallError} recorded, or {@link UnconsumedModelStepsError} when steps remain. */
  assertConsumed(): void;
}

/** Options for {@link startScriptedModelServer}. */
export interface ScriptedModelServerOptions {
  steps: readonly ScriptedStep[];
  /** Default `"openai"`. */
  wire?: "openai" | "ollama";
}

/** The loop made a model call when no scripted step was left. */
export class UnexpectedModelCallError extends TheokitAgentError {
  override readonly name: string = "UnexpectedModelCallError";
  constructor(callIndex: number, stepCount: number) {
    super(
      `Unexpected model call ${callIndex}: the script has only ${stepCount} step${stepCount === 1 ? "" : "s"}.`,
      { code: "unexpected_model_call" },
    );
  }
}

/** The run ended with scripted steps still unused. */
export class UnconsumedModelStepsError extends TheokitAgentError {
  override readonly name: string = "UnconsumedModelStepsError";
  constructor(remaining: number) {
    super(`${remaining} scripted model step${remaining === 1 ? "" : "s"} remaining unconsumed.`, {
      code: "unconsumed_model_steps",
    });
  }
}

/**
 * Start a fake model server that answers each model request with the next scripted step, so a test
 * fails when the agent loop makes more or fewer model calls than expected.
 *
 * @example
 * const server = await startScriptedModelServer({
 *   steps: [{ toolCalls: [{ name: "add", input: { a: 1, b: 2 } }] }, { text: "3" }],
 * });
 */
export async function startScriptedModelServer(
  options: ScriptedModelServerOptions,
): Promise<ScriptedModelServer> {
  const steps = options.steps;
  let calls = 0;
  let firstUnexpected: UnexpectedModelCallError | undefined;
  const answer = (_request: FakeModelRequest): ModelAnswer => {
    calls += 1;
    const step = steps[calls - 1];
    if (step === undefined) {
      firstUnexpected ??= new UnexpectedModelCallError(calls, steps.length);
      return { error: { status: 500, body: { error: { message: firstUnexpected.message } } } };
    }
    return step;
  };
  const server = await startModelServer("startScriptedModelServer", options, answer);
  return {
    model: server.model,
    url: server.url,
    requests: server.requests,
    close: () => server.close(),
    assertConsumed() {
      if (firstUnexpected !== undefined) throw firstUnexpected;
      if (calls < steps.length) throw new UnconsumedModelStepsError(steps.length - calls);
    },
  };
}
