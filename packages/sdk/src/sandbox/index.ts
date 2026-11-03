/**
 * Published as `@theokit/sdk/sandbox`.
 */
// M75 T2.1 — kernel confinement promoted from agent-builder. Additive: no existing consumer
// changes, and the subsystem protects itself by runtime detection (an honest fallback) rather than by
// platform gating at build time.
export {
  type BwrapArgvOptions,
  type BwrapDetection,
  type BwrapProbes,
  buildBwrapArgv,
  detectBwrap,
  detectBwrapMemoized,
  realProbeCount,
  realProbes,
  resetBwrapMemo,
  type SandboxMode,
  writableRootsFor,
} from "./bwrap.js";
// M75 T2.2 — the backend with kernel enforcement + the wrap + the posture. `wrapCommandForSandbox` is
// `resolveSandboxPosture` are PUBLIC API as required by M75 (T2.3): the first for whoever composes the
// wrap elsewhere (the interactive PTY), the second so the UI can answer "am I confined right now?".
// The two warn-latch resets are test seams that were re-exported here under plain camelCase, reading
// like ordinary API. They are `__…ForTests` at their definitions now, matching the 22 sibling seams in
// this package, and tests import them by explicit module path — the convention `internal/security/
// redact.ts` states: "NOT included in the index.ts barrel ... to discourage production callers".
//
// The old names stay as deprecated aliases rather than disappearing, because this is a published
// sub-path and removing an export is a major-version decision, not a cleanup. `resetBwrapMemo` is
// NOT here: it is genuinely public, being the only way to make a memoized bwrap probe re-run.
export {
  /** @deprecated Test seam, never intended as API. Removed in the next major; no replacement. */
  __resetInteractiveWarnLatchForTests as resetInteractiveWarnLatch,
  /** @deprecated Test seam, never intended as API. Removed in the next major; no replacement. */
  __resetSandboxWarnLatchForTests as resetSandboxWarnLatch,
  allowlistedEnv,
  type CreateSandboxBackendOptions,
  createSandboxBackend,
  type InteractiveWrapOptions,
  interactiveWrapCommand,
  LinuxSandbox,
  resolveSandboxPosture,
  restrictedSeccompPath,
  type SandboxPosture,
  seccompPathForArch,
  wrapCommandForSandbox,
} from "./linux-sandbox.js";
export { LocalSandbox } from "./local-sandbox.js";
export {
  type ProvisionRepoOptions,
  provisionRepo,
  RepoProvisionError,
} from "./provision.js";
export { buildSeccompFilter, type SeccompOptions } from "./seccomp.js";
export { shellEscapePosix } from "./shell-escape.js";
export {
  type ExecuteResult,
  resolveSandbox,
  SandboxBackend,
  type SandboxConfig,
  type SandboxNetworkPolicy,
  SandboxNotAvailableError,
  type SandboxProvider,
  SandboxSecurityError,
} from "./types.js";
