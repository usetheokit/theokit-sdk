import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { HooksExecutor } from "../../../../src/internal/runtime/hooks/hooks-executor.js";
import { removeTempDirRobustSync } from "../../../helpers/temp-workspace.js";

/**
 * A hook field this runtime does not implement was dropped in silence, and one of them inverts the
 * operator's intent when it disappears.
 *
 * `parseClaudeCodeCommand` reads `type`, `command` and `timeout`. Everything else on the entry —
 * `if`, `args`, `statusMessage`, `once`, `async`, `asyncRewake`, `shell` — was discarded with no
 * error and no warning. For most of those the loss is a missing convenience. For `if` it is the
 * opposite of what was written: an operator narrows a deny hook to one dangerous command shape, the
 * narrowing evaporates, and the hook vetoes every call of that tool. Nothing said so.
 *
 * The fix is refusal, not implementation, and the backlog item says why: "the rule generalises — a
 * strict allowlist that silently discards documented fields is the defect, not this one field."
 * Implementing `if` means adopting a condition language whose semantics nobody here has decided;
 * refusing the field costs one throw and cannot be wrong about what the operator meant.
 *
 * The direction matters more than the diagnosis. A dropped `if` fails OPEN — the guard applies more
 * widely than written. A refused `if` fails closed: the run stops, and the operator reads which
 * field stopped it. This is the same asymmetry that decided the sibling defect where a documented
 * deny shape parsed as allow.
 *
 * `packages/agents` already took this side — its own `hookSpecSchema` is `.strict()` and refuses an
 * unknown key loudly. Two layers reading the same file disagreed about whether a field was an
 * error, and the permissive one was the layer that actually ran the hook.
 */
function projectDeclaring(hook: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "theokit-hook-field-"));
  onTestFinished(() => {
    removeTempDirRobustSync(dir);
  });
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(
    join(dir, ".claude", "settings.json"),
    JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [hook] }] },
    }),
  );
  return dir;
}

async function loadFrom(hook: Record<string, unknown>): Promise<void> {
  const hooks = new HooksExecutor(projectDeclaring(hook), ["claude-code"]);
  await hooks.initialize(true);
}

describe("a declared hook field is refused rather than dropped", () => {
  it("refuses `if`, the field whose loss widens the guard", async () => {
    await expect(
      loadFrom({ type: "command", command: "echo hi", if: "tool_input.command =~ /rm/" }),
      "`if` was dropped, so a hook narrowed to one command now vetoes every call of the tool",
    ).rejects.toThrow(/"if" is a Claude Code hook field that this runtime does not implement/);
  });

  it("names the field and says it is a Claude Code field this runtime does not implement", async () => {
    // "unknown key" and "known key, not implemented here" are different facts, and an operator
    // migrating a `.claude/` tree needs the second one to stop hunting for a typo.
    await expect(loadFrom({ type: "command", command: "echo hi", once: true })).rejects.toThrow(
      /does not implement/i,
    );
  });

  it("still loads a hook that declares only supported fields", async () => {
    // The control. A change that refused everything would satisfy both tests above and break every
    // working configuration.
    await expect(
      loadFrom({ type: "command", command: "echo hi", timeout: 45 }),
    ).resolves.toBeUndefined();
  });

  it("still refuses a non-command type, and for its own reason", async () => {
    // The second control: the parser's existing refusals must not be swallowed by the new one.
    await expect(loadFrom({ type: "http", url: "https://example.invalid" })).rejects.toThrow(
      /type/i,
    );
  });
});
