/**
 * ACP prompt handler — extracts user text, installs the permission veto, drives `agent.send`,
 * translates the stream via `translator.ts`, and answers with a `PromptResponse` stop reason.
 *
 * Order matters and is load-bearing: the prompt is validated and the veto is installed BEFORE the
 * run starts, so a prompt that cannot be gated never reaches a tool.
 *
 * @internal
 */

import type * as acp from "@agentclientprotocol/sdk";
import type { Run } from "@theokit/sdk";
import { ACP_ERR, type AcpError } from "./lifecycle.js";
import { installPermissionPlugin } from "./permission-plugin.js";
import { extractPrompt } from "./prompt-extract.js";
import { type AcpSession, armTurn, type SessionStore } from "./session-store.js";
import { translateStream } from "./translator.js";
import type { PermissionMode } from "./types.js";

interface HandlePromptDeps {
  store: SessionStore;
  conn: acp.AgentSideConnection;
  maxPromptBytes: number;
  permissionMode: PermissionMode;
  permissionTimeoutMs: number;
  trustedTools: Set<string>;
  log: (msg: string) => void;
}

/**
 * B-125 — an unmapped error code used to fall through to `"end_turn"`, so an
 * errored run was reported to the ACP client as ordinary success. `undefined`
 * now means "no mapping" and MUST NOT be treated as `end_turn` by the caller —
 * `StopReason` has no "error" value, so an unmapped status has to surface
 * through the protocol's `{ error: AcpError }` channel instead (see
 * `runPrompt`).
 */
function mapStopReason(runStatus: string, errorCode?: string): acp.StopReason | undefined {
  if (errorCode === "aborted" || runStatus === "cancelled") return "cancelled";
  if (errorCode === "safety_blocked") return "refusal";
  if (errorCode === "context_length_exceeded" || errorCode === "max_tokens") return "max_tokens";
  if (errorCode === "max_iterations") return "max_turn_requests";
  if (runStatus === "finished") return "end_turn";
  return undefined;
}

/** Thrown by `runPrompt` when a run ends in a status/error-code combination
 * `mapStopReason` cannot place. Caught by `handlePrompt`'s existing failure
 * path and turned into a JSON-RPC `{ error: AcpError }`, never into a
 * fabricated `end_turn`. */
class UnmappedRunStatusError extends Error {
  constructor(runStatus: string, errorCode: string, detail: string | undefined) {
    super(
      `run ended in status "${runStatus}" with unmapped error code "${errorCode}"${
        detail !== undefined ? `: ${detail}` : ""
      }`,
    );
    this.name = "UnmappedRunStatusError";
  }
}

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "AbortError" || err.message.includes("aborted");
}

/**
 * B-498 — a consumer's agent created with `throwOnError: true` rejects `run.wait()` on a failed
 * run. That rejection is mapped as a resolved error run would be, so the ACP client still gets a
 * stop reason or a JSON-RPC error. It is recognised by the run's own status: any other rejection
 * (an abort, a run that did not fail) propagates to `handlePrompt` unchanged.
 */
async function waitOrMapThrowOnError(
  run: Run,
): Promise<{ status: string; error?: { message: string; code?: string } }> {
  try {
    return await run.wait();
  } catch (err) {
    if (run.status !== "error") throw err;
    return {
      status: "error",
      error: {
        message: err instanceof Error ? err.message : String(err),
        code: canonicalCode(err),
      },
    };
  }
}

/**
 * The canonical code of a rejected SDK error, read by shape as the SDK's `registerLoopError` reads
 * it (`metadata.code`, else `code`), so an error from a second copy of the SDK still maps.
 */
function canonicalCode(err: unknown): string {
  const metaCode = (err as { metadata?: { code?: unknown } } | null)?.metadata?.code;
  const rawCode = (err as { code?: unknown } | null)?.code;
  return typeof metaCode === "string" ? metaCode : typeof rawCode === "string" ? rawCode : "";
}

type ExtractOutcome = { ok: true; text: string } | { ok: false; error: AcpError };

function extractOrError(params: acp.PromptRequest, deps: HandlePromptDeps): ExtractOutcome {
  try {
    const result = extractPrompt(params.prompt, deps.maxPromptBytes);
    if (result.text.length === 0) {
      return { ok: false, error: { code: ACP_ERR.INVALID_REQUEST, message: "empty prompt" } };
    }
    return { ok: true, text: result.text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.log(`[acp] prompt extract rejected: ${msg}`);
    return { ok: false, error: { code: ACP_ERR.INVALID_REQUEST, message: msg } };
  }
}

async function runPrompt(
  session: AcpSession,
  text: string,
  params: acp.PromptRequest,
  deps: HandlePromptDeps,
): Promise<acp.StopReason> {
  // #349 — a fresh abort scope per turn. Both the send and the translator read THIS signal, so a
  // cancel of an earlier turn cannot reach into this one.
  const signal = armTurn(session);
  const run: Run = await session.agent.send(text, { signal });
  try {
    await translateStream({
      messages: run.stream(),
      conn: deps.conn,
      sessionId: params.sessionId,
      signal,
      log: deps.log,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.log(`[acp] translator threw mid-stream: ${msg}`);
  }
  const result = await waitOrMapThrowOnError(run);
  const errorCode =
    result.status === "error" && result.error !== undefined ? (result.error.code ?? "") : "";
  const stopReason = mapStopReason(result.status, errorCode);
  if (stopReason === undefined) {
    throw new UnmappedRunStatusError(result.status, errorCode, result.error?.message);
  }
  return stopReason;
}

/**
 * SEC-M0-03 — install the permission veto (fail-closed). Returns an AcpError to
 * REFUSE the prompt when the requested mode cannot be enforced on this runtime,
 * or `undefined` when installation succeeded (or mode is `auto`).
 */
async function installPermissionOrError(
  session: AcpSession,
  params: acp.PromptRequest,
  deps: HandlePromptDeps,
): Promise<AcpError | undefined> {
  if (deps.permissionMode === "auto") return undefined;
  try {
    await installPermissionPlugin(session.agent, {
      conn: deps.conn,
      sessionId: params.sessionId,
      mode: deps.permissionMode,
      trustedTools: deps.trustedTools,
      timeoutMs: deps.permissionTimeoutMs,
    });
    return undefined;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { code: ACP_ERR.INTERNAL_ERROR, message: msg };
  }
}

/**
 * Run one ACP `session/prompt` turn to completion and report why it stopped.
 *
 * Steps, each able to end the turn: look the session up, flatten the prompt to text, install the
 * permission plugin, `agent.send`, translate the stream, await the run, map its status.
 *
 * Errors returned (never thrown): `INVALID_SESSION` for an id this process has not loaded;
 * `INVALID_REQUEST` for a prompt with no text or one over `maxPromptBytes`; `INTERNAL_ERROR` when
 * the permission veto cannot be installed, when `agent.send` throws, or when the run ends in a
 * status/error-code pair ACP has no stop reason for.
 *
 * An abort — from `session/cancel` or from an already-aborted session — is NOT an error: it answers
 * `{ stopReason: "cancelled" }`. A mid-stream translator failure is logged and does not fail the
 * turn: the run is still awaited and its own status decides the stop reason.
 */
export async function handlePrompt(
  params: acp.PromptRequest,
  deps: HandlePromptDeps,
): Promise<{ response: acp.PromptResponse } | { error: AcpError }> {
  const session = deps.store.get(params.sessionId);
  if (session === undefined) {
    return {
      error: { code: ACP_ERR.INVALID_SESSION, message: `unknown session: ${params.sessionId}` },
    };
  }
  session.lastUsedAt = Date.now();

  const extracted = extractOrError(params, deps);
  if (!extracted.ok) return { error: extracted.error };

  const permError = await installPermissionOrError(session, params, deps);
  if (permError !== undefined) return { error: permError };

  try {
    const stopReason = await runPrompt(session, extracted.text, params, deps);
    return { response: { stopReason } };
  } catch (err) {
    if (isAbortError(err)) return { response: { stopReason: "cancelled" } };
    const msg = err instanceof Error ? err.message : String(err);
    const label = err instanceof UnmappedRunStatusError ? "run ended unmapped" : "agent.send threw";
    deps.log(`[acp] ${label}: ${msg}`);
    return { error: { code: ACP_ERR.INTERNAL_ERROR, message: msg } };
  }
}
