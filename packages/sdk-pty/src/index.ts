/**
 * `@theokit/sdk-pty` — the LOCAL, node-pty-backed implementation of
 * `@theokit/sdk`'s `InteractiveBackend`. Opt-in, terminal-surface only.
 * Inject a `PtyInteractiveBackend` into an interactive shell tool to drive
 * REPLs / prompting commands via a real pseudo-terminal.
 *
 * `node-pty` is this package's optional concern — never core / sdk-tools /
 * cluster / desktop. When it is unavailable the backend throws the SDK's typed
 * `InteractiveUnavailableError`.
 */

export {
  type ConfinedPtyBackendOptions,
  type ConfinementProbeResult,
  createConfinedPtyBackend,
  probeConfinement,
} from "./confined-pty-backend.js";
export {
  clampYield,
  MaxSessionsError,
  PtyInteractiveBackend,
  type PtyInteractiveBackendOptions,
  YIELD_MAX_MS,
  YIELD_MIN_MS,
} from "./pty-interactive-backend.js";
