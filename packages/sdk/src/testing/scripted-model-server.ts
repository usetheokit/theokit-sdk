import type { ServerResponse } from "node:http";

import { TheokitAgentError } from "../errors-base.js";
import {
  type FakeModelRequest,
  type FakeModelServer,
  startModelServer,
  writeAnswer,
} from "./fake-model-server.js";

/** One scripted model turn. Each model request consumes the next step. */
export type ScriptedStep =
  | { readonly text: string }
  | {
      readonly toolCalls: ReadonlyArray<{
        readonly name: string;
        readonly input: Record<string, unknown>;
        /** Ignored on the `"ollama"` wire, whose parser numbers tool calls itself. */
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

/** A running scripted server; see {@link startScriptedModelServer}. */
export interface ScriptedModelServer extends FakeModelServer {
  /** Throws UnconsumedModelStepsError when steps remain, or the first UnexpectedModelCallError recorded. */
  assertConsumed(): void;
}

/**
 * The loop made a model call after the last scripted step.
 *
 * @public
 */
export class UnexpectedModelCallError extends TheokitAgentError {
  override readonly name: string = "UnexpectedModelCallError";
  override readonly code = "unexpected_model_call" as const;
  /** One-based index of the call that had no step. */
  readonly callIndex: number;

  constructor(callIndex: number, stepCount: number) {
    super(
      `Unexpected model call ${callIndex}: the script has only ${stepCount} step${stepCount === 1 ? "" : "s"}.`,
    );
    this.callIndex = callIndex;
  }
}

/**
 * The run ended with scripted steps never requested.
 *
 * @public
 */
export class UnconsumedModelStepsError extends TheokitAgentError {
  override readonly name: string = "UnconsumedModelStepsError";
  override readonly code = "unconsumed_model_steps" as const;
  /** How many steps were never requested. */
  readonly remaining: number;

  constructor(remaining: number) {
    super(`${remaining} scripted model step${remaining === 1 ? "" : "s"} remain unconsumed.`);
    this.remaining = remaining;
  }
}

function writeError(
  res: ServerResponse,
  error: { status: number; body?: unknown; retryAfterSeconds?: number },
): void {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (error.retryAfterSeconds !== undefined) {
    headers["retry-after"] = String(error.retryAfterSeconds);
  }
  res.writeHead(error.status, headers);
  res.end(JSON.stringify(error.body ?? { error: { message: `scripted error ${error.status}` } }));
}

function answerStep(
  wire: "openai" | "ollama",
  res: ServerResponse,
  request: FakeModelRequest,
  step: ScriptedStep,
): void {
  if ("error" in step) writeError(res, step.error);
  else writeAnswer(wire, res, request, step);
}

/**
 * Start a fake model server that answers a fixed sequence of turns: text, tool calls or an HTTP
 * error. A call with no step left answers 500 and is reported by `assertConsumed()`.
 *
 * @example
 * const server = await startScriptedModelServer({
 *   steps: [{ toolCalls: [{ name: "add", input: { a: 1, b: 2 } }] }, { text: "3" }],
 * });
 * // ... run the agent against server.model ...
 * server.assertConsumed();
 * await server.close();
 */
export async function startScriptedModelServer(options: {
  steps: readonly ScriptedStep[];
  wire?: "openai" | "ollama";
}): Promise<ScriptedModelServer> {
  const wire = options.wire ?? "openai";
  const steps = options.steps;
  let calls = 0;
  let unexpected: UnexpectedModelCallError | undefined;

  const server = await startModelServer(
    "startScriptedModelServer",
    wire,
    "127.0.0.1",
    (request, res) => {
      const step = steps[calls];
      calls += 1;
      if (step === undefined) {
        unexpected ??= new UnexpectedModelCallError(calls, steps.length);
        writeError(res, {
          status: 500,
          body: { error: { message: "no scripted model step left" } },
        });
        return;
      }
      answerStep(wire, res, request, step);
    },
  );

  return {
    ...server,
    assertConsumed() {
      if (unexpected !== undefined) throw unexpected;
      if (calls < steps.length) throw new UnconsumedModelStepsError(steps.length - calls);
    },
  };
}
