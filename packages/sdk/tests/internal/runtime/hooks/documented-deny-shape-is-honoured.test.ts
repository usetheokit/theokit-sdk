import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { HooksExecutor } from "../../../../src/internal/runtime/hooks/hooks-executor.js";
import { removeTempDirRobustSync } from "../../../helpers/temp-workspace.js";

/**
 * A hook emitting the shape Claude Code DOCUMENTS was parsed as `allow`.
 *
 * `hooks-source.ts` advertises a config shape "identical to Claude Code's `settings.json` hooks", so
 * a consumer writes the guard that documentation specifies:
 *
 *     {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",…}}
 *
 * `parseDecisionFromStdout` read only a TOP-LEVEL `decision` and accepted only `deny`/`feedback`/
 * `allow`; every other shape fell through to a final `return { decision: "allow" }`. The JSON parses,
 * nothing warns, and the tool call proceeds.
 *
 * The direction is what makes it worth pinning. A missing hook event is discoverable — the user sees
 * nothing happen and investigates. A veto that silently does not fire is indistinguishable from a
 * veto that fired and approved.
 *
 * Three shapes are covered, because they fail for the same reason and a fix that closes one can
 * leave the others open.
 */
function projectWithHook(stdout: string): string {
  const dir = mkdtempSync(join(tmpdir(), "theokit-deny-shape-"));
  onTestFinished(() => {
    removeTempDirRobustSync(dir);
  });
  mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
  writeFileSync(
    join(dir, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                type: "command",
                command: 'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/g.sh"',
              },
            ],
          },
        ],
      },
    }),
  );
  // `exit 0` on purpose: the refusal must come from the DECISION it prints, not from its exit code.
  // A non-zero exit already denies through `decisionFromFailure`, which would pass this test for the
  // wrong reason and leave the parser untested.
  writeFileSync(
    join(dir, ".claude", "hooks", "g.sh"),
    `#!/usr/bin/env bash\ncat <<'JSON'\n${stdout}\nJSON\nexit 0\n`,
    { mode: 0o755 },
  );
  return dir;
}

async function decide(stdout: string): Promise<{ blocked: boolean; reason?: string }> {
  const hooks = new HooksExecutor(projectWithHook(stdout), ["claude-code"]);
  await hooks.initialize(true);
  return hooks.run({ event: "preToolUse", tool: "shell", input: {} });
}

describe("a hook emitting a documented deny shape is honoured", () => {
  it("denies on hookSpecificOutput.permissionDecision, the shape the docs instruct", async () => {
    const decision = await decide(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "blocked by policy",
        },
      }),
    );
    expect(
      decision.blocked,
      "the documented deny shape parsed as allow — the guard the operator wrote did nothing",
    ).toBe(true);
  });

  it("denies on the deprecated top-level block, which the docs still describe", async () => {
    const decision = await decide(JSON.stringify({ decision: "block", reason: "no" }));
    expect(decision.blocked).toBe(true);
  });

  it("keeps honouring this runtime's own deny dialect", async () => {
    // The control. If this one ever goes red the fix broke the path that already worked.
    const decision = await decide(JSON.stringify({ decision: "deny", reason: "no" }));
    expect(decision.blocked).toBe(true);
  });

  it("still allows when the hook says so", async () => {
    const decision = await decide(JSON.stringify({ decision: "allow" }));
    expect(decision.blocked).toBe(false);
  });
});
