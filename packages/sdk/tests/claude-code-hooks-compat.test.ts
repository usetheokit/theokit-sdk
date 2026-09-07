import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { loadHookConfig } from "../src/internal/runtime/hooks/hooks-source.js";
import { removeTempDirRobustSync } from "./helpers/temp-workspace.js";

/*
 * #524 — these suites declare `claude-code` explicitly, because the SDK no longer reads `.claude/`
 * unless a project asks for it. What they assert is unchanged: the formats are understood, and the
 * capability is intact. Only the trigger moved, from "the directory exists" to "the consumer said
 * so" — which is what makes this a default change rather than a removal.
 */
const CLAUDE_CODE = ["claude-code"] as const;

/*
 * Hook configuration under `.claude`.
 *
 * The format already agreed: `.theokit/hooks.json` is documented as "identical to Claude Code's
 * settings.json hooks" and was verified so on 2026-08-26. Only the location did not.
 *
 * Sources are MERGED rather than resolved to one winner. Hooks are unnamed lists, not named
 * declarations: two files defining `PreToolUse` are two sets of commands an operator wrote, and
 * taking only one silently drops the other — the same silent-gate class the loaders guard against
 * elsewhere. A named thing (an agent, a skill) collides and the first wins; an unnamed list does not
 * collide, it accumulates.
 *
 * Known limitation, not a defect: `SessionStart` and `PreCompact` have no firing point in this
 * runtime, so they are skipped with a warn. Four of the CLI's events map (`PreToolUse`,
 * `PostToolUse`, `UserPromptSubmit`, `Stop`).
 */
describe("hooks declared under .claude", () => {
  let cwd: string;

  const writeHooks = (root: string, command: string): void => {
    mkdirSync(join(cwd, root), { recursive: true });
    writeFileSync(
      join(cwd, root, "hooks.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "shell", hooks: [{ type: "command", command }] }],
        },
      }),
    );
  };

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "cc-hooks-compat-"));
    onTestFinished(() => {
      removeTempDirRobustSync(cwd);
    });
  });

  it("test_a_hooks_file_under_dot_claude_is_loaded", async () => {
    writeHooks(".claude", "echo do-claude");
    const config = await loadHookConfig(cwd, CLAUDE_CODE);
    expect(JSON.stringify(config)).toContain("echo do-claude");
  });

  it("test_hooks_from_both_files_all_run_rather_than_one_silently_losing", async () => {
    writeHooks(".theokit", "echo do-theokit");
    writeHooks(".claude", "echo do-claude");
    const config = await loadHookConfig(cwd, CLAUDE_CODE);
    expect(JSON.stringify(config)).toContain("echo do-theokit");
    expect(JSON.stringify(config)).toContain("echo do-claude");
  });

  it("test_hooks_written_in_the_cli_settings_file_are_loaded", async () => {
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(
      join(cwd, ".claude", "settings.json"),
      JSON.stringify({
        permissions: { allow: [] },
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", command: "echo from-settings" }] }],
        },
      }),
    );
    const config = await loadHookConfig(cwd, CLAUDE_CODE);
    expect(JSON.stringify(config)).toContain("echo from-settings");
  });

  it("test_a_personal_settings_override_is_loaded_beside_the_shared_one", async () => {
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    for (const [file, cmd] of [
      ["settings.json", "echo shared"],
      ["settings.local.json", "echo personal"],
    ] as const) {
      writeFileSync(
        join(cwd, ".claude", file),
        JSON.stringify({
          hooks: { Stop: [{ hooks: [{ type: "command", command: cmd }] }] },
        }),
      );
    }
    const config = await loadHookConfig(cwd, CLAUDE_CODE);
    expect(JSON.stringify(config)).toContain("echo shared");
    expect(JSON.stringify(config)).toContain("echo personal");
  });

  it("test_a_settings_file_carrying_no_hooks_block_contributes_nothing_and_does_not_fail", async () => {
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(
      join(cwd, ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow: ["Bash"] }, env: { A: "1" } }),
    );
    expect(await loadHookConfig(cwd, CLAUDE_CODE)).toEqual({});
  });

  // The accepted case (rules/testing.md § 4.2): a project with neither must still load cleanly,
  // or "no hooks" would have become an error rather than an empty config.
  it("test_a_project_with_no_hooks_file_anywhere_loads_an_empty_config", async () => {
    expect(await loadHookConfig(cwd, CLAUDE_CODE)).toEqual({});
  });
});

/**
 * #613 — the events this runtime does NOT fire are refused by name, and that refusal is asserted
 * rather than only described.
 *
 * `CLAUDE_CODE_EVENT_MAP` maps four of the CLI's events; `SessionStart`, `SubagentStop`,
 * `PreCompact`, `Notification` and `SessionEnd` have no firing point here and are skipped with a
 * warn. The docblock at the top of this file has said so since the compat work landed — and prose
 * was not enough. Two independent readers spent hours in 2026-09 concluding that a `SessionStart`
 * hook was silently broken, and one of them (me) filed a defect against this package for it. The
 * behaviour was correct and documented; what was missing was an executable answer for anyone who
 * greps before they read.
 *
 * The second case is the one that carries the claim. Without it, "SessionStart produced no hook" is
 * indistinguishable from "the file was never read" — which is exactly the ambiguity that made the
 * original investigation go wrong. Both events live in ONE file, so the control and the subject
 * share every variable except the event name.
 */
describe("a hook declared for an event this runtime does not fire", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "cc-hooks-unmapped-"));
    onTestFinished(() => {
      removeTempDirRobustSync(cwd);
    });
  });

  const writeBoth = (): void => {
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(
      join(cwd, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "echo on-session-start" }] }],
          PreToolUse: [{ hooks: [{ type: "command", command: "echo on-pre-tool-use" }] }],
        },
      }),
    );
  };

  it("test_an_unmapped_event_contributes_no_hook", async () => {
    writeBoth();
    const config = await loadHookConfig(cwd, CLAUDE_CODE);
    expect(JSON.stringify(config)).not.toContain("echo on-session-start");
  });

  it("test_CONTROL_a_mapped_event_in_the_same_file_is_loaded", async () => {
    writeBoth();
    const config = await loadHookConfig(cwd, CLAUDE_CODE);
    expect(JSON.stringify(config)).toContain("echo on-pre-tool-use");
  });

  /**
   * `SessionEnd`, not `SessionStart`, and the difference is not cosmetic. `warnOnce` dedupes per
   * process per event, so a test that reused `SessionStart` would pass or fail depending on whether
   * a sibling above it had already consumed the key — an order-dependent test, which
   * `rules/testing.md § 3` forbids. Giving this case its own unmapped event makes it independent,
   * and incidentally proves the refusal is a rule about the map rather than a special case for one
   * event name.
   */
  it("test_the_refusal_names_the_event_and_the_events_that_are_supported", async () => {
    const written: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        written.push(String(chunk));
        return true;
      });
    try {
      mkdirSync(join(cwd, ".claude"), { recursive: true });
      writeFileSync(
        join(cwd, ".claude", "settings.json"),
        JSON.stringify({
          hooks: {
            SessionEnd: [{ hooks: [{ type: "command", command: "echo on-session-end" }] }],
          },
        }),
      );
      await loadHookConfig(cwd, CLAUDE_CODE);
    } finally {
      spy.mockRestore();
    }
    const warn = written.join("");
    expect(warn).toContain("SessionEnd");
    expect(warn).toContain("is not fired by the SDK runtime");
    // The supported set is quoted back, so an operator can fix the file without reading our source.
    expect(warn).toContain("PreToolUse");
  });
});
