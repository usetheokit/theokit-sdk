import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { setDiagnosticsSink } from "../../../../src/internal/diagnostics.js";
import { HooksExecutor } from "../../../../src/internal/runtime/hooks/hooks-executor.js";
import {
  _resetWarnOnceForTests,
  CLAUDE_CODE_EVENT_MAP,
} from "../../../../src/internal/runtime/hooks/hooks-source.js";
import { removeTempDirRobustSync } from "../../../helpers/temp-workspace.js";

/**
 * The loader advertised a shape "identical to Claude Code's `settings.json` hooks" and accepted four
 * of the thirty-three documented events.
 *
 * Measured by execution: a `hooks.json` declaring all thirty-three, through the shipped loader,
 * yielded `PreToolUse`, `PostToolUse`, `UserPromptSubmit` and `Stop`. Thirteen of the sixteen the
 * spec marks "Can block? Yes" were among the missing.
 *
 * ## Why the map is not simply grown
 *
 * Mapping a name the runtime does not FIRE is strictly worse than refusing it. Today an operator
 * declaring `PreCompact` gets a report saying it will not fire; with the name mapped they would get
 * silence and a guard that never runs — a declared veto that does not exist, which is the failure
 * this whole area keeps producing. The map grows when the seam exists, one event at a time, and each
 * one is its own piece of work.
 *
 * ## What this file enforces
 *
 * That the supported set stays STATED. A parity claim in a docblock drifts silently; a list the
 * runtime derives its own warning from cannot. If someone adds a seam and maps its event, the first
 * test goes red and is the place to record it.
 *
 * The blocking/observational split in the second test is the priority order the item asks for: an
 * unwired veto loses a capability, while an unwired observer loses a signal. They are listed here so
 * the next person picking one up does not re-derive which is which.
 */
const SUPPORTED = ["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop"] as const;

/** Documented events that CAN BLOCK and are not wired. Priority order for future work. */
const MISSING_BLOCKING = [
  "PermissionRequest",
  "PreModelSwitch",
  "PreCompact",
  "UserPromptExpansion",
  "PostToolBatch",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
  "ConfigChange",
  "TeammateIdle",
  "Elicitation",
  "ElicitationResult",
  "WorktreeCreate",
  "WorktreeRemove",
] as const;

let installed: Parameters<typeof setDiagnosticsSink>[0];

beforeEach(() => {
  // A consumer that never installed a sink — the condition under which a dropped hook used to be
  // completely silent.
  installed = undefined;
  setDiagnosticsSink(undefined);
});

afterEach(() => {
  setDiagnosticsSink(installed);
  _resetWarnOnceForTests();
  vi.restoreAllMocks();
});

function projectDeclaring(events: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "theokit-event-set-"));
  onTestFinished(() => {
    removeTempDirRobustSync(dir);
  });
  mkdirSync(join(dir, ".claude"), { recursive: true });
  const hooks: Record<string, unknown> = {};
  for (const event of events) {
    hooks[event] = [{ hooks: [{ type: "command", command: "echo hi" }] }];
  }
  writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ hooks }));
  return dir;
}

describe("the supported hook-event set is stated, not implied", () => {
  it("accepts exactly the events the runtime fires", () => {
    expect(
      Object.keys(CLAUDE_CODE_EVENT_MAP).sort(),
      "the map changed — a seam was added or removed, and the docblock claim goes with it",
    ).toEqual([...SUPPORTED].sort());
  });

  it("reports every unwired blocking event, with no sink installed", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const hooks = new HooksExecutor(projectDeclaring(MISSING_BLOCKING), ["claude-code"]);
    await hooks.initialize(true);

    const written = stderr.mock.calls.map((c) => String(c[0])).join("");
    for (const event of MISSING_BLOCKING) {
      expect(written, `${event} was dropped and the operator was never told`).toContain(event);
    }
  });

  it("stays quiet for the events it does fire", async () => {
    // The control. A change that reported everything would satisfy the test above and make every
    // ordinary run noisy.
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const hooks = new HooksExecutor(projectDeclaring(SUPPORTED), ["claude-code"]);
    await hooks.initialize(true);

    const written = stderr.mock.calls.map((c) => String(c[0])).join("");
    expect(written).not.toContain("is not fired by the SDK runtime");
  });
});
