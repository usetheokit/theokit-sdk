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
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

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

/** Splits a stdio chunk into complete JSON lines; returns the parsed events and the leftover. */
function parseLines(buffered: string): { events: MuseServerEvent[]; rest: string } {
  const lines = buffered.split("\n");
  const rest = lines.pop() ?? "";
  const events: MuseServerEvent[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    try {
      events.push(JSON.parse(line) as MuseServerEvent);
    } catch {
      // A non-JSON line is not protocol traffic; ignore it.
    }
  }
  return { events, rest };
}

/** An async queue fed by the child's stdout. */
class EventQueue {
  private readonly items: MuseServerEvent[] = [];
  private wake: (() => void) | undefined;
  private done = false;
  private failure: unknown;

  push(events: MuseServerEvent[]): void {
    this.items.push(...events);
    this.wake?.();
  }

  end(err?: unknown): void {
    this.done = true;
    if (err !== undefined) this.failure = err;
    this.wake?.();
  }

  async *drain(): AsyncGenerator<MuseServerEvent, void, void> {
    for (;;) {
      const next = this.items.shift();
      if (next !== undefined) {
        yield next;
      } else if (this.done) {
        if (this.failure !== undefined) throw this.failure;
        return;
      } else {
        await new Promise<void>((r) => {
          this.wake = r;
        });
      }
    }
  }
}

function attachSession(child: ReturnType<typeof spawn>): MuseSession {
  const queue = new EventQueue();
  let buf = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    const parsed = parseLines(buf + chunk);
    buf = parsed.rest;
    queue.push(parsed.events);
  });
  child.once("close", () => queue.end());
  return {
    send: (m) => {
      child.stdin?.write(`${JSON.stringify(m)}\n`);
    },
    close: () => {
      child.kill();
    },
    events: { [Symbol.asyncIterator]: () => queue.drain() },
  };
}

function isSafeExecutable(dir: string, file: string): boolean {
  try {
    // Group/world-writable directories let another user plant a lookalike binary.
    if (process.platform !== "win32" && (statSync(dir).mode & 0o022) !== 0) return false;
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves `command` to an absolute path. A command with a path separator is used as given; a bare
 * name is searched only in absolute, non-group/world-writable `PATH` entries, so `spawn` never
 * resolves a name through an attacker-influenced `PATH`.
 */
export function resolveMuseBinary(
  command: string,
  pathVar: string | undefined = process.env.PATH,
): string | undefined {
  if (isAbsolute(command)) return command;
  if (command.includes("/") || command.includes("\\")) return undefined;
  for (const dir of (pathVar ?? "").split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, command);
    if (isSafeExecutable(dir, candidate)) return candidate;
  }
  return undefined;
}

/** Default transport: spawns `muse serve` and speaks JSON lines on stdio. */
export function createStdioMuseTransport(command = "muse"): MuseTransport {
  return {
    open(signal) {
      return new Promise<MuseSession>((resolve, reject) => {
        const binary = resolveMuseBinary(command);
        if (binary === undefined) {
          reject(notInstalled());
          return;
        }
        const child = spawn(binary, ["serve"], { stdio: ["pipe", "pipe", "ignore"], signal });
        child.once("error", (err: NodeJS.ErrnoException) => {
          reject(err.code === "ENOENT" ? notInstalled(err) : err);
        });
        child.once("spawn", () => resolve(attachSession(child)));
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
      for await (const ev of session.events) {
        if (ev.type === "text_delta") {
          text += ev.text;
          yield { type: "text_delta", text: ev.text };
        } else if (ev.type === "turn_end") {
          const { inputTokens, outputTokens } = ev;
          return makeLlmFinish({
            stopReason: "end_turn",
            text,
            toolCalls: [],
            inputTokens,
            outputTokens,
          });
        } else {
          await this.handleControl(session, ev);
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

  /** Answers an approval request through the caller, or throws the mapped Muse error. */
  private async handleControl(
    session: MuseSession,
    ev: Exclude<MuseServerEvent, { type: "text_delta" | "turn_end" }>,
  ): Promise<void> {
    if (ev.type === "error") throw this.mapError(ev);
    const allow = this.options.onApproval === undefined ? false : await this.options.onApproval(ev);
    session.send({ type: "permission_response", id: ev.id, allow });
  }

  private mapError(ev: { code?: string; message: string }): Error {
    if (ev.code !== undefined && NOT_SIGNED_IN_CODES.has(ev.code)) return notSignedIn(ev.message);
    return new TheokitAgentError(`Muse error: ${ev.message}`, {
      code: ev.code === "billing_error" ? "quota_exceeded" : "server_error",
      isRetryable: false,
    });
  }
}
