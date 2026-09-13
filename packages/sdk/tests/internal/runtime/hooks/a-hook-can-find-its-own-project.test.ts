import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import {
  CLAUDE_CODE_SOURCE,
  NATIVE_SOURCE,
} from "../../../../src/internal/runtime/compat/foreign-config-sources.js";
import { HooksExecutor } from "../../../../src/internal/runtime/hooks/hooks-executor.js";
import { removeTempDirRobustSync } from "../../../helpers/temp-workspace.js";

/**
 * A hook could not locate a project file, and a ported hook script read `undefined` for everything
 * it was written against.
 *
 * ## The project directory
 *
 * `CLAUDE_PROJECT_DIR` was supplied to commands imported from Claude Code (#522, after a hook
 * written the documented way expanded to a leading `/` and denied every turn). The NATIVE dialect
 * got `{}`, on the reasoning that a `.theokit/` hook "is written against THIS runtime and inherits
 * it already" — which is true of the runtime's behaviour and not of a project path. Nothing in the
 * inherited environment says where the project is, so a native hook had to depend on the process
 * cwd, which is the exact dependency the foreign fix removed.
 *
 * Fixing one dialect and leaving the other different is the half-fix this closes.
 *
 * ## The payload
 *
 * The stdin payload used this runtime's own field names. A script ported from Claude Code reads
 * `tool_name`, `tool_input`, `tool_response`, `hook_event_name` and `cwd`, got `undefined` for
 * every one, and RAN — deciding on nothing while looking like a working guard.
 *
 * The documented names are added ALONGSIDE the existing ones rather than replacing them: both
 * dialects execute through this one path, and renaming would break every native script to fix the
 * ported ones.
 *
 * Only the fields this runtime actually knows. `session_id`, `transcript_path`, `permission_mode`
 * and `prompt_id` are absent because their values would have to be invented, and an invented
 * session id is worse than a missing one — a script that branches on it would branch on a lie.
 */
function projectWithHook(dialect: "claude-code" | "theokit", command: string): string {
  const dir = mkdtempSync(join(tmpdir(), "theokit-hook-env-"));
  onTestFinished(() => {
    removeTempDirRobustSync(dir);
  });
  const configDir = dialect === "claude-code" ? ".claude" : ".theokit";
  mkdirSync(join(dir, configDir), { recursive: true });
  writeFileSync(
    join(dir, configDir, "settings.json"),
    JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command }] }] },
    }),
  );
  return dir;
}

describe("a hook can find its own project, in either dialect", () => {
  it("gives the native dialect a project-directory variable", () => {
    expect(
      NATIVE_SOURCE.runtimeEnv("/work/app"),
      "a native hook had to depend on the process cwd — the exact dependency the foreign fix removed",
    ).toEqual({ THEOKIT_PROJECT_DIR: "/work/app" });
  });

  it("still gives the foreign dialect the name its own docs use", () => {
    // The control. The variable a ported script reaches for must keep its documented spelling.
    expect(CLAUDE_CODE_SOURCE.runtimeEnv("/work/app")).toEqual({
      CLAUDE_PROJECT_DIR: "/work/app",
    });
  });

  it("still invents nothing", () => {
    // The second control, and a decision this repeats rather than revisits: `CLAUDE_PLUGIN_ROOT`
    // and the rest stay unset, because an invented root sends a script somewhere real and wrong
    // where an unset one fails loudly.
    expect(Object.keys(CLAUDE_CODE_SOURCE.runtimeEnv("/w"))).toEqual(["CLAUDE_PROJECT_DIR"]);
  });

  it("sends a ported script the field names it was written against", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "theokit-hook-out-")), "seen.json");
    onTestFinished(() => {
      removeTempDirRobustSync(join(out, ".."));
    });
    const dir = projectWithHook("claude-code", `cat > ${out}`);

    const hooks = new HooksExecutor(dir, ["claude-code"]);
    await hooks.initialize(true);
    await hooks.run({ event: "preToolUse", tool: "shell", input: { command: "ls" } });

    const seen = JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>;
    expect(seen.tool_name, "a ported script read undefined and decided on nothing").toBe("shell");
    expect(seen.tool_input).toEqual({ command: "ls" });
    expect(seen.hook_event_name).toBe("PreToolUse");
    expect(seen.cwd).toBe(dir);
  });

  it("keeps the native field names beside them", async () => {
    // The control that stops this from being a rename. Both dialects execute through one path, so
    // replacing the names would break every native script to fix the ported ones.
    const out = join(mkdtempSync(join(tmpdir(), "theokit-hook-out2-")), "seen.json");
    onTestFinished(() => {
      removeTempDirRobustSync(join(out, ".."));
    });
    const dir = projectWithHook("theokit", `cat > ${out}`);

    const hooks = new HooksExecutor(dir, []);
    await hooks.initialize(true);
    await hooks.run({ event: "preToolUse", tool: "shell", input: { command: "ls" } });

    const seen = JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>;
    expect(seen.event).toBe("preToolUse");
    expect(seen.tool).toBe("shell");
  });
});
