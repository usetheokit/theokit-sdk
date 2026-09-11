import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PermissionEngine } from "../src/permission-engine.js";
import { permissionFloorReason } from "../src/permission-floors.js";
import { parsePermissionRules } from "../src/permission-rules.js";

/**
 * Two tiers the spec makes un-overridable did not exist, so nothing survived a permissive setup.
 *
 * Measured: `protectedPath` 0 files here and 0 in the SDK dist; `criticalPath` the same, against a
 * control of 31/72 on the word `hooks`.
 *
 * **Protected paths** are the circuit breaker that stops an agent editing its own configuration, the
 * git hooks or the shell rc files — `.git`, `.claude`, ssh-adjacent dotfiles, `.envrc`, `.npmrc`,
 * `.mcp.json`, `.pre-commit-config.yaml`. An `allow`-broad setup wrote all of them freely and the
 * operator had no way to express the exception, because the concept was absent.
 *
 * **Critical paths** are destructive operations on `/`, `~`, the cwd and its parents. The nearest
 * analogue was `catastrophicShellReason` in `@theokit/sdk-tools`, reached through an opt-in
 * `denyCatastrophicCommands()` — and an opt-in guard is not a floor. The whole point of this tier is
 * that nothing overrides it; a function a consumer may forget to call makes the guarantee a
 * convention.
 *
 * ## Why a floor and not a deny rule
 *
 * A deny rule is ordered, and order is defeasible: it can be shadowed, reordered, or simply not
 * shipped. The floor is consulted BEFORE any verdict is honoured and has no rule that can reach it —
 * which is the difference between "we recommend denying this" and "this cannot be approved".
 *
 * Each test below pairs the refusal with an explicit `allow` rule for the same call, because the
 * point is not that the operation is refused: it is that the RULE LOSES.
 */
const CWD = "/work/app";

function floor(tool: string, args: Record<string, unknown>): string | undefined {
  return permissionFloorReason(tool, args, { cwd: CWD, home: "/home/me" });
}

/** An engine configured as permissively as it can be: allow everything, never ask. */
function permissive() {
  return new PermissionEngine(parsePermissionRules({ allow: ["Write", "Bash", "Edit"] }), {
    defaultAction: "allow",
  });
}

describe("a floor survives every allow rule", () => {
  it("refuses a write inside .git", () => {
    expect(floor("Write", { file_path: join(CWD, ".git", "hooks", "pre-commit") })).toMatch(
      /\.git/,
    );
  });

  it("refuses a write to the agent's own configuration", () => {
    expect(floor("Write", { file_path: join(CWD, ".claude", "settings.json") })).toMatch(
      /\.claude/,
    );
    expect(floor("Write", { file_path: join(CWD, ".mcp.json") })).toMatch(/\.mcp\.json/);
  });

  it("refuses a write to shell and package credentials", () => {
    for (const name of [".envrc", ".npmrc", ".pre-commit-config.yaml"]) {
      expect(floor("Write", { file_path: join(CWD, name) }), name).toBeDefined();
    }
    expect(floor("Write", { file_path: join("/home/me", ".ssh", "id_ed25519") })).toBeDefined();
  });

  it("tells a protected segment from a name that merely contains it", () => {
    // `.gitignore` is a file a project edits routinely and `.gitlab-ci.yml` is another. A substring
    // match would refuse both while claiming to protect `.git`, and the refusal message would name
    // a directory the operator is not editing.
    expect(floor("Write", { file_path: join(CWD, ".gitignore") })).toBeUndefined();
    expect(floor("Write", { file_path: join(CWD, ".gitlab-ci.yml") })).toBeUndefined();
    expect(floor("Write", { file_path: join(CWD, "src", "claude-helpers.ts") })).toBeUndefined();
    // And the real one still refuses, so this is not a test that passes by disabling the floor.
    expect(floor("Write", { file_path: join(CWD, ".git", "config") })).toBeDefined();
  });

  it("leaves an ordinary file alone", () => {
    // The control. A floor that refused everything would satisfy every test above and stop the agent
    // doing any work at all.
    expect(floor("Write", { file_path: join(CWD, "src", "index.ts") })).toBeUndefined();
  });

  it("does not refuse a READ of a protected path", () => {
    // The second control, and the boundary the spec draws: the tier is about WRITES. Refusing reads
    // would block an agent from inspecting the repository it was pointed at.
    expect(floor("Read", { file_path: join(CWD, ".git", "config") })).toBeUndefined();
  });

  it("refuses a destructive command on a critical root", () => {
    expect(floor("Bash", { command: "rm -rf /" })).toBeDefined();
    expect(floor("Bash", { command: "rm -rf ~" })).toBeDefined();
    expect(floor("Bash", { command: `rm -rf ${CWD}` })).toBeDefined();
    expect(floor("Bash", { command: "rm -rf /work" }), "a parent of cwd").toBeDefined();
  });

  it("sees through a substitution that hides the target", () => {
    // The spec calls these out by name, and they are why a literal comparison is not enough: the
    // dangerous argument is not present in the text being matched.
    expect(floor("Bash", { command: "rm -rf $(echo /)" })).toBeDefined();
    expect(floor("Bash", { command: 'rm -rf "$HOME"/*' })).toBeDefined();
  });

  it("is segment-aware rather than prefix-matching", () => {
    // The control that keeps the floor usable: `/workspace` is not `/work`, and a floor that could
    // not tell them apart would refuse ordinary work in a directory whose name starts the same way.
    expect(floor("Bash", { command: "rm -rf /workspace-other/tmp" })).toBeUndefined();
    expect(floor("Bash", { command: "rm -rf ./build" })).toBeUndefined();
  });

  it("loses to no allow rule — the rule loses", () => {
    // The assertion the item asks for by name. The engine says allow; the floor still refuses.
    const engine = permissive();
    expect(engine.evaluate("Write", { file_path: join(CWD, ".git", "config") })).toBe("allow");
    expect(
      floor("Write", { file_path: join(CWD, ".git", "config") }),
      "an allow rule reached a path the floor exists to make unreachable",
    ).toBeDefined();
  });

  it("holds under the most permissive mode", () => {
    // `bypass` allows everything except an explicit deny. The floor is not a rule, so there is
    // nothing for a mode to relax.
    const engine = permissive();
    expect(engine.evaluate("Bash", { command: "rm -rf /" }, "bypass")).toBe("allow");
    expect(floor("Bash", { command: "rm -rf /" })).toBeDefined();
  });

  it("resolves the real environment when given none", () => {
    // The production caller passes no context. A floor that only worked when configured would be
    // the opt-in guard this item exists to replace.
    expect(
      permissionFloorReason("Write", { file_path: join(homedir(), ".ssh", "id_rsa") }),
    ).toBeDefined();
  });
});

/**
 * B-068 — the read side has no floor, and this pins that it is a DECISION rather than a gap nobody
 * noticed.
 *
 * The write floor refuses `.ssh` under every allow rule. A READ of the same path is refused by
 * nothing, because there is no read-side tier at all: reads are governed by the rule language and by
 * nothing above it. That asymmetry is invisible from the module — `PROTECTED_SEGMENTS` reads like a
 * list of paths that are protected, and it is only half that.
 *
 * If a read fence is ever added, this file goes red and the docblock above `WRITING_TOOLS` must be
 * rewritten in the same commit. That is the point: the claim and the behaviour cannot drift apart
 * quietly, which is how "we decided not to" becomes "we forgot to" without anyone editing a word.
 */
describe("the read side has no floor, deliberately", () => {
  it("refuses a WRITE into .ssh and does not refuse a READ of the same path", () => {
    const target = { file_path: "/home/someone/.ssh/id_rsa" };

    expect(
      permissionFloorReason("Write", target),
      "the write floor stopped protecting .ssh",
    ).toBeDefined();

    expect(
      permissionFloorReason("Read", target),
      "a read floor appeared — update the WRITING_TOOLS docblock, which states there is none",
    ).toBeUndefined();
  });

  it("has no additionalDirectories concept to widen a fence that does not exist", () => {
    // The reference's key presupposes a fence. Asserting the absence keeps the reasoning attached to
    // something executable instead of to a paragraph nobody re-reads.
    expect(
      permissionFloorReason("Read", { path: "/etc/passwd" }),
      "reads outside the working directory are not fenced, so there is nothing to widen",
    ).toBeUndefined();
  });
});
