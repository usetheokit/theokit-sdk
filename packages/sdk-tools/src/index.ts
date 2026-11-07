/**
 * Built-in tools for `@theokit/sdk` agents (`@theokit/sdk/tools`).
 *
 * Each factory returns a `CustomTool` ready to drop into `Agent.create`
 * or `createAgentFactory({ tools: [...] })`. All five share three
 * design rules:
 *
 *   1. **Project-scoped**. Every factory takes `{ projectRoot }` and
 *      gates every I/O call against that boundary via the SDK's
 *      `safePathJoin` + `assertNoSymlinkEscape` primitives.
 *
 *   2. **Sensitive files refused**. `.env*` (except `.env.example`),
 *      `.git/`, `node_modules/`, `.theo/`, and lock files are blocked
 *      via `isForbiddenPath`.
 *
 *   3. **JSON returns, never throws on user mistakes**. Handlers return
 *      `{ ok: true, ... }` or `{ ok: false, error: '...' }`. Real
 *      exceptions are reserved for SDK-side bugs (input parse errors,
 *      unexpected fs failures).
 *
 * Consumers: TheoKit Studio (the embedded coding agent), `cli-bot`
 * (the SDK's reference example), and any future coding-agent built on
 * `@theokit/sdk`.
 */

export { type CreateApplyPatchToolOptions, createApplyPatchTool } from "./apply-patch.js";
// Agent workflow tools (moved from @theokit/theocode — SDK LEGO pieces)
export {
  createSessionArtifactStore,
  type SessionArtifactStore,
  type SessionArtifactStoreOptions,
} from "./artifact-store.js";
export {
  type CreateCurrentTimeToolOptions,
  createCurrentTimeTool,
} from "./current-time.js";
export { type CreateEditFileToolOptions, createEditFileTool } from "./edit-file.js";
// Output formatting utilities (moved from @theokit/theocode — SDK LEGO pieces)
export { formatCode, formatDiff, formatError, formatFileList } from "./formatter.js";
export { type CreateGitDiffToolOptions, createGitDiffTool } from "./git-diff.js";
export { type CreateGitStatusToolOptions, createGitStatusTool } from "./git-status.js";
export { type CreateGlobToolOptions, createGlobTool } from "./glob-files.js";
export {
  type CreateInteractiveShellToolOptions,
  createInteractiveShellTool,
  createWriteStdinTool,
} from "./interactive-shell.js";
export {
  type CommandPolicy,
  commandDenialReason,
  denyCatastrophicCommands,
  isCommandAllowed,
} from "./internal/command-policy.js";
export {
  ContextMatchError,
  type ContextMatchReason,
  replaceUnique,
} from "./internal/context-match.js";
export {
  isBlockedIp,
  RedirectBlockedError,
  type ResolveAndScreenOptions,
  resolveAndScreen,
  type ScreenedFetchOptions,
  SsrfBlockedError,
  screenedFetch,
} from "./internal/network-guard.js";
export {
  buildEnvContext,
  buildRepoMap,
  type EnvContextOptions,
  type RepoMapOptions,
} from "./internal/repo-map.js";
export { CatastrophicCommandError, catastrophicShellReason } from "./internal/shell-guard.js";
export { renderToolList, withDescription, withName } from "./internal/tool-aci.js";
export {
  DEFAULT_TOOL_GUIDANCE,
  injectGuidance,
  type ToolGuidanceMap,
  withDefaultGuidance,
  withShellExitGuidance,
  withToolResultGuidance,
} from "./internal/tool-guidance.js";
export { type CreateListDirToolOptions, createListDirTool } from "./list-dir.js";
export {
  createPlanModeTool,
  type PlanModeTool,
  type PlanModeToolOptions,
  type PlanModeToolWithStore,
} from "./plan-mode.js";
export { createQuestionTool, type QuestionTool, type QuestionToolOptions } from "./question.js";
export { type CreateReadFileToolOptions, createReadFileTool } from "./read-file.js";
// SE32 — read-before-write safety tracker (shared by read_file + write_file).
// Only `ReadTracker` is the consumer-facing API (instantiate + pass to both
// tools); `evaluateReadBeforeWrite`/`WriteDecision` stay internal (imported
// directly by write-file.ts + unit-tested via read-tracker.ts) — not re-exported.
export { ReadTracker } from "./read-tracker.js";
// SE37 — the public reasoning scratchpad toolkit (think + analyze).
export { ReasoningTools } from "./reasoning-tools.js";
export {
  type CreateRunVitestToolOptions,
  createRunVitestTool,
  type VitestSummary,
} from "./run-vitest.js";
export { type CreateSearchTextToolOptions, createSearchTextTool } from "./search-text.js";
export {
  type CreateSecretsToolOptions,
  createSecretsTool,
  type SecretsTool,
} from "./secrets.js";
export { type CreateShellToolOptions, createShellTool } from "./shell-exec.js";
export {
  type CreateTextToSpeechToolOptions,
  createTextToSpeechTool,
  DEFAULT_MAX_AUDIO_BYTES,
  DEFAULT_MAX_TEXT_CHARS,
  type SynthesizedAudio,
  type TextToSpeechCallback,
  type TextToSpeechResult,
} from "./text-to-speech.js";
export { type PlanNode, todoItemsToPlanNodes } from "./todo-plan-nodes.js";
export { createTodolistTool, type TodoItem, type TodolistTool } from "./todolist.js";
export {
  type TruncationMode,
  type TruncationOptions,
  type TruncationResult,
  truncateOutput,
} from "./truncation.js";
export { createUpdatePlanTool } from "./update-plan.js";
export {
  type CreateViewImageToolOptions,
  createViewImageTool,
  DEFAULT_MAX_IMAGE_BYTES,
} from "./view-image.js";
export { type CreateWebFetchToolOptions, createWebFetchTool } from "./web-fetch.js";
export {
  type CreateWebSearchToolOptions,
  createWebSearchTool,
  type WebSearchCallback,
  type WebSearchResult,
} from "./web-search.js";
export {
  type CreateBraveWebSearchAdapterOptions,
  createBraveWebSearchAdapter,
} from "./web-search-brave.js";
export {
  type CreateGenericHttpSearchAdapterOptions,
  createGenericHttpSearchAdapter,
} from "./web-search-http.js";
export { type CreateWriteFileToolOptions, createWriteFileTool } from "./write-file.js";
