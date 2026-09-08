/**
 * #631 — a consumer can refuse a hook before this package spawns it.
 *
 * ## What was missing
 *
 * Nothing asked anyone. This package read hook commands from config files — its own root and any
 * foreign dialect the consumer imported — and spawned them. A consumer with its own approval
 * machinery could not apply it, because the decision point did not exist.
 *
 * Measured by `usetheoai-lab/TheoCode` with a real credential: a hook declared in a
 * `.theokit/settings.json` ran arbitrary shell, and that product's own
 * `hook not approved and will not run` never appeared — its gate was not bypassed, it was never
 * consulted. The same holds for `.claude/settings.json`, which is the case proposal A does not
 * reach: a consumer that wants that dialect's skills, agents and rules has no way to decline only
 * its hooks, because `settingSources` grants per SOURCE, not per surface.
 *
 * ## The two decisions this encodes
 *
 * **Absent means run.** Every existing consumer has no `approve`, and a gate that defaulted to
 * refusing would silently disable every hook in the ecosystem on a patch.
 *
 * **A refused hook does not deny the turn.** `preRun` and `preToolUse` hooks can block the
 * operation they attach to, so the tempting shape is to treat "not approved" as a denial. That
 * would make an unapproved hook *worse* than an absent one: the consumer asked for the command not
 * to run, not for the work to stop. A refused hook is treated as if it were not configured.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HooksExecutor } from "../src/internal/runtime/hooks/hooks-executor.js";

let cwd: string;
let marker: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "hook-gate-"));
  marker = join(cwd, "the-hook-ran");
  mkdirSync(join(cwd, ".theokit"), { recursive: true });
  writeFileSync(
    join(cwd, ".theokit", "hooks.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: `touch ${JSON.stringify(marker)}` }] }],
      },
    }),
  );
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

async function runOnce(
  approve?: (command: { command: string; sourcePath?: string }) => boolean | Promise<boolean>,
): Promise<{ ran: boolean; blocked: boolean }> {
  const executor = new HooksExecutor(cwd, [], approve === undefined ? undefined : { approve });
  await executor.initialize(true);
  const result = await executor.run({ event: "preToolUse", tool: "shell" });
  return { ran: existsSync(marker), blocked: result.blocked };
}

describe("a consumer's approval gate", () => {
  /**
   * CONTROL, and it carries the whole file: without it, "the hook did not run" in the refusing case
   * cannot be told from "this fixture never configured a hook that could run".
   */
  it("test_CONTROL_with_no_gate_the_hook_runs", async () => {
    expect((await runOnce()).ran).toBe(true);
  });

  it("test_a_refused_hook_does_not_run", async () => {
    expect((await runOnce(() => false)).ran).toBe(false);
  });

  it("test_an_approved_hook_runs", async () => {
    expect((await runOnce(() => true)).ran).toBe(true);
  });

  it("test_the_gate_may_be_async", async () => {
    expect((await runOnce(async () => false)).ran).toBe(false);
  });

  it("test_a_refused_hook_does_not_deny_the_operation", async () => {
    expect((await runOnce(() => false)).blocked).toBe(false);
  });

  /**
   * The gate is handed the command and where it was declared, because "should this run?" is not
   * answerable from the event alone — a consumer's fingerprint is over the command text, and which
   * file it came from is what separates its own configuration from a foreign dialect's.
   */
  it("test_the_gate_receives_the_command_and_its_source", async () => {
    const seen: Array<{ command: string; sourcePath?: string }> = [];
    await runOnce((c) => {
      seen.push(c);
      return false;
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.command).toContain("the-hook-ran");
    expect(seen[0]?.sourcePath).toContain(join(".theokit", "hooks.json"));
  });
});
