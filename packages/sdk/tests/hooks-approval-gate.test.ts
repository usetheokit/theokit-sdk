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
import type { HookApprovalRequest } from "../src/types/hooks.js";

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

/**
 * #637 — the request must carry enough for a consumer to recompute the identity it stored.
 *
 * ## What was missing
 *
 * `local.hooks.approve` (#631) let a consumer refuse a hook. It did not let one APPROVE a
 * particular hook, because the two sides could not compute the same fingerprint. Measured at the
 * boundary by `usetheoai-lab/TheoCode`, which stores a hash over `command` + `event` + `matcher` +
 * `timeoutMs` and therefore had to refuse everything that reached the gate — honest, and not the
 * policy anyone wanted.
 *
 * Two independent mismatches, either one sufficient:
 *
 * 1. **No timeout.** The request never carried one, so a stored fingerprint including it could not
 *    be reproduced.
 * 2. **A different event vocabulary.** The request reported the runtime's `preToolUse`; the
 *    approval had been taken against the config file's `PreToolUse`.
 *
 * ## Why both fields are REQUIRED rather than optional
 *
 * `parseClaudeCodeCommand` is the only producer of a `HookCommand` in this package — verified, not
 * assumed — so every hook that reaches the gate came from a config file and has both. Making them
 * optional would hand every consumer a fallback branch for a case that cannot occur, and each such
 * branch is a second answer to a security question. If an in-memory producer is ever added, the
 * required field is what forces it to supply one instead of inheriting a silent `undefined`.
 *
 * ## Why the EFFECTIVE timeout, not the declared one
 *
 * A config that omits `timeout` still runs under a timeout — 30s. Reporting `undefined` there would
 * make the consumer reimplement this package's default to compute the same hash, and a default
 * duplicated across a boundary is a default that drifts.
 */
describe("#637 — the approval request carries the identity the consumer stored", () => {
  interface CcHook {
    readonly type: "command";
    readonly command: string;
    readonly timeout?: number;
  }

  function writeHooks(event: string, hooks: readonly CcHook[], matcher?: string): void {
    writeFileSync(
      join(cwd, ".theokit", "hooks.json"),
      JSON.stringify({
        hooks: { [event]: [{ ...(matcher === undefined ? {} : { matcher }), hooks }] },
      }),
    );
  }

  async function capture(): Promise<HookApprovalRequest[]> {
    const seen: HookApprovalRequest[] = [];
    const executor = new HooksExecutor(cwd, [], {
      approve: (r) => {
        seen.push(r);
        return false;
      },
    });
    await executor.initialize(true);
    await executor.run({ event: "preToolUse", tool: "shell" });
    return seen;
  }

  it("test_the_request_names_the_event_the_config_file_used", async () => {
    writeHooks("PreToolUse", [{ type: "command", command: "true" }]);
    const [request] = await capture();
    expect(request?.sourceEvent).toBe("PreToolUse");
  });

  /**
   * CONTROL for the test above: without it, `sourceEvent === "PreToolUse"` could be a renamed
   * `event` rather than the file's own key, and the whole point is that the two DIFFER.
   */
  it("test_CONTROL_the_runtime_event_is_still_the_runtime_vocabulary", async () => {
    writeHooks("PreToolUse", [{ type: "command", command: "true" }]);
    const [request] = await capture();
    expect(request?.event).toBe("preToolUse");
  });

  it("test_the_request_carries_the_declared_timeout_in_milliseconds", async () => {
    writeHooks("PreToolUse", [{ type: "command", command: "true", timeout: 5 }]);
    const [request] = await capture();
    expect(request?.timeoutMs).toBe(5000);
  });

  it("test_the_request_carries_the_default_timeout_when_the_config_omits_one", async () => {
    writeHooks("PreToolUse", [{ type: "command", command: "true" }]);
    const [request] = await capture();
    expect(request?.timeoutMs).toBe(30_000);
  });

  /**
   * The claim is not "a number is present" but "the number the runtime will APPLY". Proven by
   * letting an approved hook exceed it: the runtime's own timeout message must name the same
   * figure the gate was shown. Nothing else distinguishes a reported timeout from a decorative one.
   */
  it("test_the_reported_timeout_is_the_one_the_runtime_enforces", async () => {
    writeHooks("PreToolUse", [{ type: "command", command: "sleep 5", timeout: 0.25 }]);
    let shown: number | undefined;
    const executor = new HooksExecutor(cwd, [], {
      approve: (r) => {
        shown = r.timeoutMs;
        return true;
      },
    });
    await executor.initialize(true);
    const result = await executor.run({ event: "preToolUse", tool: "shell" });
    expect(shown).toBe(250);
    expect(result.reason).toContain("250ms");
  });

  it("test_the_command_and_matcher_still_reach_the_gate", async () => {
    writeHooks("PreToolUse", [{ type: "command", command: "echo marker" }], "shell");
    const [request] = await capture();
    expect(request?.command).toBe("echo marker");
    expect(request?.matcher).toBe("shell");
    expect(request?.sourcePath).toContain(join(".theokit", "hooks.json"));
  });
});
