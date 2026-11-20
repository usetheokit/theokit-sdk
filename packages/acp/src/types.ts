/**
 * Public types for `@theokit/acp` (ADRs D349-D360).
 *
 * @public
 */

import type { AgentLike } from "@theokit/sdk";

/**
 * Builds the agent that will serve one ACP session.
 *
 * Called once per `session/new`, with a freshly generated UUID, and awaited. Returning a NEW agent
 * per call is what gives each session its own conversation state (D351); returning the same instance
 * every time is the shared-state shape described on {@link AgentOrFactory}.
 *
 * A throw or rejection here is reported to the host as JSON-RPC `-32603`, message
 * `agent factory threw: <your message>`, and no session is created.
 *
 * @public
 */
export type AgentFactory = (sessionId: string) => AgentLike | Promise<AgentLike>;

/**
 * What `serveAcp({ agent })` accepts.
 *
 * - {@link AgentFactory} — one agent per session. Recommended.
 * - `AgentLike` (an `SDKAgent` qualifies) — one agent for the whole process. Legal, but every ACP session then appends to the
 *   SAME conversation; `serveAcp` writes a one-time warning through its `log` and carries on.
 *
 * Anything else (a plain object, `null`, a string) makes `serveAcp` fail with an
 * `InvalidAgentError` before a single byte of protocol is read. `serveAcp` is `async`, so that
 * arrives as a REJECTED PROMISE, never as a synchronous throw — `try { serveAcp(...) } catch` around
 * the call alone catches nothing. The class is not exported either (see {@link serveAcp}); match on
 * `err.name`. The duck-test is narrow: an object qualifies only when it has a string `agentId` and a
 * callable `send`.
 *
 * @public
 */
export type AgentOrFactory = AgentFactory | AgentLike;

/**
 * How tool calls are gated before they execute (D355).
 *
 * - `"ask"` (default) — every tool call except the ones named in `trustedTools` round-trips through
 *   the host's `session/request_permission`. A `deny` choice, a cancelled request, a transport
 *   failure, or `permissionTimeoutMs` elapsing all BLOCK the call.
 * - `"auto"` — no gating whatsoever: the veto plugin is never installed, so `trustedTools` AND
 *   `permissionTimeoutMs` are silently ignored in this mode.
 * - `"deny"` — blocks every tool call without asking the host. `trustedTools` does NOT exempt
 *   anything here: the deny branch is evaluated before the trusted-tool check.
 *
 * `"ask"` and `"deny"` fail closed. When the runtime has no plugin manager to hang the veto on (a
 * cloud-backed agent, for instance), the prompt is refused with `-32603` rather than executed
 * ungated — a security control that cannot be installed must not silently degrade to `"auto"`.
 *
 * @public
 */
export type PermissionMode = "ask" | "auto" | "deny";

/**
 * Overrides for the capabilities advertised in the ACP `initialize` handshake.
 *
 * `loadSession` and the three `prompt` flags reach the wire; they are the only session-shaped
 * capabilities `AgentCapabilities` has a slot for at `@agentclientprotocol/sdk@0.22.1`.
 *
 * `forkSession` and `listSessions` were removed in #350. The protocol has nowhere to advertise
 * them — neither name appears in its generated schema — and neither gated anything here:
 * `session/fork` is refused unconditionally and `session/list` is answered from the in-memory
 * store regardless. They were accepted, typed, documented, and inert.
 *
 * @public
 */
export interface AcpCapabilities {
  /** Advertise `session/load`. Default `true`. The handler needs the SDK to be able to resume that id. */
  loadSession?: boolean;
  /** Prompt content the host may send. Anything disabled here is a hint to the host, not a guard. */
  prompt?: {
    /** Default `false`. Audio blocks are still accepted and counted against `maxPromptBytes`. */
    audio?: boolean;
    /** Default `true`. */
    embeddedContext?: boolean;
    /** Default `true`. Images are accepted but only the TEXT blocks of a prompt reach the agent. */
    image?: boolean;
  };
}

/**
 * Display info for the agent in an ACP host UI.
 *
 * Sent as `InitializeResponse.agentInfo` when you supply it (#350 — it was accepted and read by
 * nothing). Omitted otherwise: defaulting to this package's own metadata would label every agent as
 * the adapter serving it, and a name that is confidently wrong is worse for a host to display than
 * one that is absent.
 *
 * @public
 */
export interface AcpAgentInfo {
  /** Machine-ish identifier, e.g. `"my-bot"`. */
  name: string;
  /** Human label preferred by a UI over `name`. */
  title?: string;
  /** Semver of the agent, not of this package. */
  version: string;
}

/**
 * Options for {@link serveAcp}. Every field but `agent` is optional and every default is listed
 * below — this object is the whole configuration surface, nothing is read from env or disk.
 *
 * @public
 */
export interface AcpServerOptions {
  /** The agent, or a per-session factory. Required; an unusable value throws before serving. */
  agent: AgentOrFactory;
  /** Name, title and version advertised as `agentInfo` in the `initialize` handshake. */
  info?: AcpAgentInfo;
  /** Handshake capability overrides. Only a subset is honoured — see {@link AcpCapabilities}. */
  capabilities?: AcpCapabilities;
  /** Default `"ask"`. Read {@link PermissionMode} before choosing: `"auto"` disables the two fields below. */
  permissionDefault?: PermissionMode;
  /**
   * How long to wait for the host to answer `session/request_permission` before BLOCKING the tool
   * call (fail-closed, EC-2). Default `60_000` ms. Ignored unless `permissionDefault` is `"ask"`.
   */
  permissionTimeoutMs?: number;
  /**
   * Tool names that skip the permission round-trip. Matched by exact tool name.
   *
   * Effective in `"ask"` mode ONLY: `"auto"` never installs the plugin, and `"deny"` blocks these
   * too.
   */
  trustedTools?: ReadonlyArray<string>;
  /**
   * Ceiling on the ACCUMULATED size of one prompt, in bytes. Default `2 * 1024 * 1024` (2 MiB), D360.
   *
   * Counted per block and summed: UTF-8 bytes for text, base64-DECODED bytes for image and audio,
   * the URI for a resource link, the JSON form for an embedded resource. Crossing it rejects the
   * whole prompt with `-32602` — see {@link PromptTooLargeError}.
   */
  maxPromptBytes?: number;
  /**
   * Sink for this package's diagnostics — one line per call, newline NOT included.
   *
   * Defaults to a write to `process.stderr` (D359). Never route this to stdout: stdout carries the
   * JSON-RPC frames.
   */
  log?: (msg: string) => void;
  /** Override the protocol input stream. Defaults to `process.stdin`. Test seam. */
  stdin?: NodeJS.ReadableStream;
  /** Override the protocol output stream. Defaults to `process.stdout`. Test seam. */
  stdout?: NodeJS.WritableStream;
}

/**
 * Raised when a prompt's accumulated size passes `maxPromptBytes` (D360).
 *
 * `size` is the running total AT the block that crossed the limit, not the size of the full prompt:
 * extraction stops at the first offending block, so blocks after it are never measured.
 *
 * Under {@link serveAcp} this never escapes to the caller — it is caught and returned to the ACP
 * host as JSON-RPC `-32602` carrying `message` verbatim (`prompt exceeds N bytes (got M)`). The
 * class is exported so that text has a named origin; the extractor that throws it is not part of the
 * public surface, so there is no supported call site where a consumer can `instanceof` it directly.
 *
 * @public
 */
export class PromptTooLargeError extends Error {
  override readonly name = "PromptTooLargeError";
  constructor(
    readonly size: number,
    readonly limit: number,
  ) {
    super(`prompt exceeds ${limit} bytes (got ${size})`);
  }
}
