import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { setDiagnosticsSink } from "../../../../src/internal/diagnostics.js";
import { HooksExecutor } from "../../../../src/internal/runtime/hooks/hooks-executor.js";
import { _resetWarnOnceForTests } from "../../../../src/internal/runtime/hooks/hooks-source.js";
import { removeTempDirRobustSync } from "../../../helpers/temp-workspace.js";

/**
 * A hook event this runtime does not fire was dropped, and the report went nowhere.
 *
 * The loader maps four Claude Code event names and skips the rest. Skipping is honest — the runtime
 * genuinely does not fire them — but the notice went through `warnOnce` → `diag`, and `diag` is
 * silent with no sink installed. Measured: the same config produced 0 warnings by default and 29
 * with a sink installed. An operator declaring a `PreCompact` guard got nothing: no hook, no
 * message, and no way to learn either.
 *
 * `diagFailure` is the channel for exactly this, and its docblock records the precedent:
 * `theokit-sdk#189`, where an MCP server failed to start, the only report went to `diag()`, the
 * embedding UI never read it, and "the user saw an agent with missing tools and no reason given". A
 * dropped hook is that shape with a sharper edge — the missing thing is a guard.
 *
 * The asymmetry that decides it is quoted in that same docblock: "a corrupted frame is visible and
 * recoverable, while a silently dropped failure is neither."
 *
 * A sink still takes precedence when one is installed; this is about what happens when none is.
 *
 * ## Why this file removes the sink, and why that is not cheating
 *
 * `vitest.setup.ts` installs a diagnostics sink that forwards to stderr for the duration of every
 * test. That is deliberate and useful — it keeps existing `process.stderr.write` assertions real —
 * but it means the default path is the one shape this suite never exercises. Measured: with the
 * setup's sink in place the dropped-event notice DOES reach stderr, so a test written the obvious
 * way passes before the fix and proves nothing.
 *
 * Removing the sink is what reproduces a consumer: a library embedded in a program that never called
 * `setDiagnosticsSink`. It is restored in `afterEach`.
 */
let installed: Parameters<typeof setDiagnosticsSink>[0];

beforeEach(() => {
  // Stand in for a consumer that never installed one. `vitest.setup.ts` installs a stderr-forwarding
  // sink, which is exactly the condition that hides this defect.
  installed = undefined;
  setDiagnosticsSink(undefined);
});

afterEach(() => {
  setDiagnosticsSink(installed);
  _resetWarnOnceForTests();
  vi.restoreAllMocks();
});

function projectDeclaring(event: string): string {
  const dir = mkdtempSync(join(tmpdir(), "theokit-dropped-hook-"));
  onTestFinished(() => {
    removeTempDirRobustSync(dir);
  });
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(
    join(dir, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        [event]: [{ hooks: [{ type: "command", command: "echo hi" }] }],
      },
    }),
  );
  return dir;
}

describe("a dropped hook event is reported even with no sink installed", () => {
  it("reports an event the runtime does not fire", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const hooks = new HooksExecutor(projectDeclaring("PreCompact"), ["claude-code"]);
    await hooks.initialize(true);

    const written = stderr.mock.calls.map((c) => String(c[0])).join("");
    expect(
      written,
      "the event was dropped and nothing reached the operator — the guard they declared is simply absent",
    ).toContain("PreCompact");
  });

  it("stays quiet for an event the runtime does fire", async () => {
    // The control. A change that reported everything would satisfy the test above while making the
    // supported path noisy on every single run.
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const hooks = new HooksExecutor(projectDeclaring("PreToolUse"), ["claude-code"]);
    await hooks.initialize(true);

    const written = stderr.mock.calls.map((c) => String(c[0])).join("");
    expect(written).not.toContain("is not fired by the SDK runtime");
  });
});
