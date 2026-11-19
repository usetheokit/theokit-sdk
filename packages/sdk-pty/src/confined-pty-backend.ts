/**
 * `createConfinedPtyBackend` / `probeConfinement` — an interactive shell that starts in a fixed root,
 * inside the OS sandbox, with a scrubbed environment, plus a runtime proof that the confinement
 * works on this host.
 */
import { existsSync, rmSync } from "node:fs";

import type {
  InteractiveBackend,
  StartInteractiveOptions,
  StartInteractiveResult,
  WriteStdinOptions,
  WriteStdinResult,
} from "@theokit/sdk/interactive";
import { interactiveWrapCommand, type SandboxMode } from "@theokit/sdk/sandbox";

import { PtyInteractiveBackend } from "./pty-interactive-backend.js";

const DEFAULT_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
];
const DEFAULT_MAX_SESSIONS = 4;
const DEFAULT_PROBE_TIMEOUT_MS = 3000;
const PROBE_SETTLE_MS = 300;
const PROBE_POLL_MS = 50;

export interface ConfinedPtyBackendOptions {
  /** Every session starts here; a cwd passed to startInteractive is ignored. */
  root: string;
  /** Sandbox mode handed to interactiveWrapCommand from @theokit/sdk/sandbox. */
  mode: SandboxMode;
  /** Variable names kept from `sourceEnv`. Default: PATH, USER, LOGNAME, LANG, LC_ALL, LC_CTYPE, TERM, TZ. HOME is always set to `root`. */
  envAllowlist?: readonly string[];
  /** Default `process.env`. */
  sourceEnv?: Readonly<Record<string, string | undefined>>;
  /** Default 4. */
  maxSessions?: number;
  /**
   * Test seam: builds the backend that actually spawns. Receives the sandbox wrap and the session
   * ceiling. Defaults to a `PtyInteractiveBackend`.
   */
  createInner?: (inner: {
    wrapCommand: (command: string, cwd: string) => string | null;
    maxSessions: number;
  }) => InteractiveBackend;
}

/** POSIX single-quote: the shell receives `value` unchanged. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function scrubbedCommand(command: string, options: ConfinedPtyBackendOptions): string {
  const source = options.sourceEnv ?? process.env;
  const kept: string[] = [];
  for (const name of options.envAllowlist ?? DEFAULT_ENV_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined && name !== "HOME") kept.push(`${name}=${shQuote(value)}`);
  }
  kept.push(`HOME=${shQuote(options.root)}`);
  return `/usr/bin/env -i ${kept.join(" ")} /bin/sh -c ${shQuote(command)}`;
}

class ConfinedPtyBackend implements InteractiveBackend {
  constructor(
    private readonly inner: InteractiveBackend,
    private readonly options: ConfinedPtyBackendOptions,
  ) {}

  startInteractive(
    command: string,
    opts?: StartInteractiveOptions,
  ): Promise<StartInteractiveResult> {
    return this.inner.startInteractive(scrubbedCommand(command, this.options), {
      ...opts,
      cwd: this.options.root,
    });
  }

  writeStdin(
    sessionId: string,
    chars: string,
    opts?: WriteStdinOptions,
  ): Promise<WriteStdinResult> {
    return this.inner.writeStdin(sessionId, chars, opts);
  }

  kill(sessionId: string): void {
    this.inner.kill(sessionId);
  }
}

/**
 * An {@link InteractiveBackend} whose every session starts in `root`, runs under
 * `interactiveWrapCommand({ mode })` and sees only the allowlisted environment (plus `HOME=root`).
 * Gate its use on {@link probeConfinement}: a sandbox that is unavailable wraps nothing.
 */
export function createConfinedPtyBackend(options: ConfinedPtyBackendOptions): InteractiveBackend {
  const config = {
    wrapCommand: interactiveWrapCommand({ mode: options.mode }),
    maxSessions: options.maxSessions ?? DEFAULT_MAX_SESSIONS,
  };
  const inner = options.createInner
    ? options.createInner(config)
    : new PtyInteractiveBackend(config);
  return new ConfinedPtyBackend(inner, options);
}

export type ConfinementProbeResult =
  | { confined: true }
  | {
      confined: false;
      reason: "cannot_write_inside" | "wrote_outside" | "start_failed";
      detail?: string;
    };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) return false;
    await sleep(PROBE_POLL_MS);
  }
  return true;
}

/**
 * Starts a real session that touches `paths.inside` (inside the root) and `paths.outside` (beside
 * it), and reports whether the confinement held. Both paths must be caller-owned, distinct and
 * disposable: they are removed afterwards. The session is always killed.
 *
 * `start_failed` means `startInteractive` rejected (no `node-pty`, no sandbox, spawn error) and
 * carries the message in `detail`. A spawn that succeeds but whose command then fails to run shows
 * up as `cannot_write_inside`.
 */
export async function probeConfinement(
  backend: InteractiveBackend,
  paths: { inside: string; outside: string },
  options?: { timeoutMs?: number },
): Promise<ConfinementProbeResult> {
  const command = `touch ${shQuote(paths.inside)}; touch ${shQuote(paths.outside)}`;
  let sessionId: string | undefined;
  try {
    sessionId = (await backend.startInteractive(command)).sessionId;
    const wrote = await waitForFile(paths.inside, options?.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
    await sleep(PROBE_SETTLE_MS);
    if (existsSync(paths.outside)) return { confined: false, reason: "wrote_outside" };
    return wrote ? { confined: true } : { confined: false, reason: "cannot_write_inside" };
  } catch (error) {
    return {
      confined: false,
      reason: "start_failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (sessionId !== undefined) killQuietly(backend, sessionId);
    rmSync(paths.inside, { force: true });
    rmSync(paths.outside, { force: true });
  }
}

function killQuietly(backend: InteractiveBackend, sessionId: string): void {
  try {
    backend.kill(sessionId);
  } catch {
    // best effort: the probe result matters more than a failed kill of a dead session
  }
}
