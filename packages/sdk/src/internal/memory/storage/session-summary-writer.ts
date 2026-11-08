import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { replaceFileAtomic } from "../../persistence/atomic-write.js";
import { safeFilenameForId } from "../../security/path-guard.js";
import { redactSecrets } from "../types.js";
import type { MemoryRoot } from "./memory-root.js";

/**
 * Per-run session summary writer (ADR D20).
 *
 * After every finished run, write a markdown summary to
 * `.theokit/memory/sessions/<runId>.md`. IndexManager picks these up with
 * `source="sessions"` so `memory_search({ corpus: "sessions" })` can recall
 * past conversations.
 *
 * EC-9: only `status === "finished"` runs trigger a write. Cancelled/errored
 * runs would otherwise pollute the recall corpus with partial transcripts.
 *
 * Shared with `@theokit/sdk-memory` through the semver-exempt `internal/memory-store`
 * sub-path, so it carries no internal-visibility tag. `stripInternal` matches that tag as TEXT
 * anywhere in the block, so naming it here — even in backticks, even to say it is absent — deletes
 * this symbol from the published declarations and forces the satellite back onto a copy. Measured:
 * the first draft of this very note did exactly that. See #430 and #463.
 */

export interface SessionSummaryInput {
  /** The RESOLVED memory root, not a cwd — see `storage/memory-root.ts` (#463). */
  memoryRoot: MemoryRoot;
  runId: string;
  agentId: string;
  userText: string;
  assistantText: string;
  status: "finished" | "running" | "error" | "cancelled";
  at: number;
}

const MAX_TURN_CHARS = 2000;

/** `<memory root>/sessions`. Takes the RESOLVED ROOT — see `storage/memory-root.ts` (#463). */
export function sessionsDir(root: MemoryRoot): string {
  return join(root, "sessions");
}

/**
 * The file one run's summary occupies: `<memory root>/sessions/<safe-id>.md`.
 *
 * The id passes through `safeFilenameForId`, so a UUID keeps its own name and anything else gets a
 * deterministic `h-<16hex>` token. Deterministic matters more than readable here — a name that
 * varied per call would orphan the summary it names.
 */
export function sessionSummaryPath(root: MemoryRoot, runId: string): string {
  // M0-4: total id->filename helper. UUID runIds (the production case, from
  // randomUUID) pass through to the identical name; non-conforming ids get a
  // deterministic sha256 token instead of the old lossy replace-collapse.
  return join(sessionsDir(root), `${safeFilenameForId(runId, { maxLen: 128 })}.md`);
}

function truncate(text: string): string {
  if (text.length <= MAX_TURN_CHARS) return text;
  return `${text.slice(0, MAX_TURN_CHARS)}…`;
}

/**
 * Write a session summary file. EC-9: a non-finished status returns early
 * without touching disk. Secrets in both user and assistant text are
 * redacted via the shared `redactSecrets` pattern.
 *
 * Shared with `@theokit/sdk-memory` through the semver-exempt `internal/memory-store`
 * sub-path, so it carries no internal-visibility tag. `stripInternal` matches that tag as TEXT
 * anywhere in the block, so naming it here — even in backticks, even to say it is absent — deletes
 * this symbol from the published declarations and forces the satellite back onto a copy. Measured:
 * the first draft of this very note did exactly that. See #430 and #463.
 */
export async function writeSessionSummary(input: SessionSummaryInput): Promise<void> {
  if (input.status !== "finished") return;
  const path = sessionSummaryPath(input.memoryRoot, input.runId);
  await mkdir(sessionsDir(input.memoryRoot), { recursive: true });

  const safeUser = truncate(redactSecrets(input.userText));
  const safeAssistant = truncate(redactSecrets(input.assistantText));
  const iso = new Date(input.at).toISOString();

  const body = [
    "---",
    `runId: ${input.runId}`,
    `agentId: ${input.agentId}`,
    `at: ${iso}`,
    `status: ${input.status}`,
    "---",
    "",
    "## User",
    "",
    safeUser,
    "",
    "## Assistant",
    "",
    safeAssistant,
    "",
  ].join("\n");

  await replaceFileAtomic(path, body);
}
