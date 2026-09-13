import { describe, expect, it } from "vitest";

import {
  adapterForConfigPath,
  CLAUDE_CODE_SOURCE,
  NATIVE_SOURCE,
  undefinedVariablesIn,
} from "../../../../src/internal/runtime/compat/foreign-config-sources.js";

/**
 * The dialect registry, tested where it is a decision rather than an integration.
 *
 * `tests/internal/runtime/hooks/foreign-hook-runtime-contract.test.ts` proves the WIRING — that a
 * hook read from `.claude/settings.json` actually receives the contract. These cover the rules that
 * wiring consults, including the ones an integration test cannot reach: a path that merely contains
 * the substring `.claude`, and the shell forms the variable scan must not misread.
 */
describe("adapterForConfigPath", () => {
  it("recognises each registered dialect by its directory", () => {
    expect(adapterForConfigPath("/w/.claude/settings.json")).toBe(CLAUDE_CODE_SOURCE);
    expect(adapterForConfigPath("/w/.theokit/hooks.json")).toBe(NATIVE_SOURCE);
  });

  it("matches a path SEGMENT, not a substring", () => {
    // A workspace under `~/.claude-backups/repo` is not a Claude Code source, and an `includes`
    // check would say it is — then hand its hooks a variable pointing at the wrong tree.
    expect(adapterForConfigPath("/home/me/.claude-backups/repo/.theokit/hooks.json")).toBe(
      NATIVE_SOURCE,
    );
    expect(adapterForConfigPath("/home/me/claude/settings.json")).toBeUndefined();
  });

  it("returns undefined for a path under no registered dialect", () => {
    expect(adapterForConfigPath("/w/.codex/config.toml")).toBeUndefined();
  });

  it("gives each dialect a project directory under its own name, and nothing else", () => {
    // This used to assert `{}` for the native source, on the reasoning that native hooks "are
    // written against THIS runtime and inherit it". That is true of the runtime's BEHAVIOUR and not
    // of a project PATH: nothing in the inherited environment says where the project is, so a
    // native hook had to depend on the process cwd — the exact dependency #522 removed for the
    // foreign side. Fixing one dialect and leaving the other different was the half-fix.
    //
    // The SPELLINGS differ on purpose: a ported script reaches for the name its own docs use.
    //
    // What is unchanged is the refusal to invent: a value this SDK would have to make up for
    // `$CLAUDE_PLUGIN_ROOT` sends a script somewhere real and wrong, where an unset one fails
    // loudly.
    expect(NATIVE_SOURCE.runtimeEnv("/w")).toEqual({ THEOKIT_PROJECT_DIR: "/w" });
    expect(CLAUDE_CODE_SOURCE.runtimeEnv("/w")).toEqual({ CLAUDE_PROJECT_DIR: "/w" });
  });
});

describe("undefinedVariablesIn", () => {
  const NO_ENV: Record<string, string | undefined> = {};

  it("finds a variable neither the dialect nor the environment defines", () => {
    expect(undefinedVariablesIn('bash "$CLAUDE_PLUGIN_ROOT/x.sh"', {}, NO_ENV)).toEqual([
      "CLAUDE_PLUGIN_ROOT",
    ]);
  });

  it("stays silent about one the dialect supplies", () => {
    expect(
      undefinedVariablesIn('bash "$CLAUDE_PROJECT_DIR/x.sh"', { CLAUDE_PROJECT_DIR: "/w" }, NO_ENV),
    ).toEqual([]);
  });

  it("stays silent about one the environment already has", () => {
    expect(undefinedVariablesIn('test -d "$HOME"', {}, { HOME: "/home/me" })).toEqual([]);
  });

  it("reads the braced form", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: `${NAME}` is SHELL syntax here, and it is the input under test — a template string would change what is being parsed.
    expect(undefinedVariablesIn('bash "${PLUGIN_ROOT}/x.sh"', {}, NO_ENV)).toEqual(["PLUGIN_ROOT"]);
  });

  it("ignores a single-quoted span, which sh treats as literal", () => {
    // `echo '$FOO'` prints the dollar sign. Reporting it would deny a hook that works.
    expect(undefinedVariablesIn("echo '$NOT_A_VAR'", {}, NO_ENV)).toEqual([]);
  });

  it("reports each name once however often it appears", () => {
    expect(undefinedVariablesIn('cp "$ROOT/a" "$ROOT/b"', {}, NO_ENV)).toEqual(["ROOT"]);
  });

  it("says nothing about a command with no variables at all", () => {
    expect(undefinedVariablesIn("./scripts/guard.sh", {}, NO_ENV)).toEqual([]);
  });

  it("errs toward silence on a default-valued expansion", () => {
    // `${NAME:-fallback}` makes the variable optional, so it is not a missing one. Documented as a
    // known false negative rather than guessed at: the cost is the old confusing message, where a
    // false POSITIVE would deny a hook that would have run.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell syntax, as above.
    expect(undefinedVariablesIn('echo "${MAYBE:-ok}"', {}, NO_ENV)).toEqual([]);
  });
});
