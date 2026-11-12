/**
 * Muse Code provider (`meta/*`, usetheokit/theokit-sdk#976).
 *
 * Drives `muse serve` over the Muse Session Protocol (MSP): newline-delimited JSON on stdio. Muse
 * owns the agent loop and the sandbox; the SDK caller keeps channels, approvals and transcript. The
 * wire shapes below are the SDK's own reading of the protocol and live behind {@link MuseTransport},
 * so the stdio transport can change without touching {@link MuseClient}.
 *
 * @internal
 */

import { spawn } from "node:child_process";

import { AuthenticationError, ConfigurationError, TheokitAgentError } from "../../errors.js";
import { collapseSystemText, makeLlmFinish } from "./finish.js";
import type { LlmClient, LlmEvent, LlmFinish, LlmRequest } from "./types.js";

/** A tool-permission request raised by Muse mid-turn. */
export interface MuseApprovalRequest {
  id: string;
  tool: string;
  input: Record<string, unknown>;
}

/** Events Muse sends to the SDK. */
export type MuseServerEvent =
  | { type: "text_delta"; text: string }
  | ({ type: "permission_request" } & MuseApprovalRequest)
  | { type: "turn_end"; inputTokens?: number; outputTokens?: number }
  | { type: "error"; code?: string; message: string };

/** Messages the SDK sends to Muse. */
export type MuseClientMessage =
  | { type: "turn"; model: string; system: string; prompt: string }
  | { type: "permission_response"; id: string; allow: boolean };

/** One open Muse session. */
export interface MuseSession {
  send(message: MuseClientMessage): void;
  readonly events: AsyncIterable<MuseServerEvent>;
  close(): void;
}

/** Opens sessions against Muse. Rejects with `ENOENT`-coded errors when `muse` is absent. */
export interface MuseTransport {
  open(signal: AbortSignal): Promise<MuseSession>;
}

export interface MuseClientOptions {
  transport?: MuseTransport;
  /** Decides a Muse tool-permission request. Absent ⇒ every request is denied. */
  onApproval?: (request: MuseApprovalRequest) => boolean | Promise<boolean>;
}

const NOT_SIGNED_IN_CODES = new Set(["not_signed_in", "unauthenticated", "auth_required"]);

function notInstalled(cause?: unknown): ConfigurationError {
  return new ConfigurationError(
    "The Muse Code CLI (`muse`) was not found on PATH. Install it and sign in, then retry a `meta/*` model.",
    { code: "muse_not_installed", cause },
  );
}

function notSignedIn(message: string): AuthenticationError {
  return new AuthenticationError(
    `Muse Code is not signed in (${message}). Sign in with the Muse CLI, then retry.`,
    { code: "muse_not_signed_in" },
  );
}

/** Default transport: spawns `muse serve` and speaks JSON lines on stdio. */
export function createStdioMuseTransport(command = "muse"): MuseTransport {
  return {
    open(signal) {
      return new Promise<MuseSession>((resolve, reject) => {
        const child = spawn(command, ["serve"], { stdio: ["pipe", "pipe", "ignore"], signal });
        const queue: MuseServerEvent[] = [];
        let wake: (() => void) | undefined;
        let done = false;
        let failure: unknown;
        const finish = (err?: unknown): void => {
          done = true;
          if (err !== undefined) failure = err;
          wake?.();
        };
        child.once("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT") {
            reject(notInstalled(err));
            return;
          }
          finish(err);
          reject(err);
        });
        child.once("spawn", () => {
          let buf = "";
          child.stdout.setEncoding("utf8");
          // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: line-buffered stdio reader is one cohesive block.
          child.stdout.on("data", (chunk: string) => {
            buf += chunk;
            let nl = buf.indexOf("\n");
            while (nl >= 0) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (line.length > 0) {
                try {
                  queue.push(JSON.parse(line) as MuseServerEvent);
                } catch {
                  // A non-JSON line is not protocol traffic; ignore it.
                }
              }
              nl = buf.indexOf("\n");
            }
            wake?.();
          });
          child.once("close", () => finish());
          resolve({
            send: (m) => {
              child.stdin.write(`${JSON.stringify(m)}\n`);
            },
            close: () => {
              child.kill();
            },
            events: {
              // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: line-buffered stdio reader is one cohesive block.
              async *[Symbol.asyncIterator]() {
                for (;;) {
                  const next = queue.shift();
                  if (next !== undefined) {
                    yield next;
                    continue;
                  }
                  if (done) {
                    if (failure !== undefined) throw failure;
                    return;
                  }
                  await new Promise<void>((r) => {
                    wake = r;
                  });
                }
              },
            },
          });
        });
      });
    },
  };
}

function lastUserText(request: LlmRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const m = request.messages[i];
    if (m?.role !== "user") continue;
    return m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
  }
  return "";
}

export class MuseClient implements LlmClient {
  readonly name = "meta";
  private readonly transport: MuseTransport;

  constructor(private readonly options: MuseClientOptions = {}) {
    this.transport = options.transport ?? createStdioMuseTransport();
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: line-buffered stdio reader is one cohesive block.
  async *stream(
    request: LlmRequest,
    signal: AbortSignal,
  ): AsyncGenerator<LlmEvent, LlmFinish, void> {
    const session = await this.transport.open(signal);
    try {
      session.send({
        type: "turn",
        model: request.model,
        system: collapseSystemText(request.system),
        prompt: lastUserText(request),
      });
      let text = "";
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      for await (const ev of session.events) {
        if (ev.type === "text_delta") {
          text += ev.text;
          yield { type: "text_delta", text: ev.text };
        } else if (ev.type === "permission_request") {
          const allow =
            this.options.onApproval === undefined ? false : await this.options.onApproval(ev);
          session.send({ type: "permission_response", id: ev.id, allow });
        } else if (ev.type === "error") {
          throw this.mapError(ev);
        } else {
          inputTokens = ev.inputTokens;
          outputTokens = ev.outputTokens;
          return makeLlmFinish({
            stopReason: "end_turn",
            text,
            toolCalls: [],
            inputTokens,
            outputTokens,
          });
        }
      }
      throw new TheokitAgentError("Muse closed the session before the turn ended.", {
        code: "provider_unreachable",
        isRetryable: true,
      });
    } finally {
      session.close();
    }
  }

  private mapError(ev: { code?: string; message: string }): Error {
    if (ev.code !== undefined && NOT_SIGNED_IN_CODES.has(ev.code)) return notSignedIn(ev.message);
    return new TheokitAgentError(`Muse error: ${ev.message}`, {
      code: ev.code === "billing_error" ? "quota_exceeded" : "server_error",
      isRetryable: false,
    });
  }
}
