import { describe, expect, it } from "vitest";

import { type PermissionAction, PermissionEngine } from "../src/permission-engine.js";
import { type PermissionRuleSet, parsePermissionRules } from "../src/permission-rules.js";

/**
 * A shell command line runs every command on it, so a shell rule is matched against each command
 * the line runs rather than against the start of the line.
 *
 * - a deny (or ask) rule matches when ANY command on the line matches it;
 * - an allow rule decides only when EVERY command on the line matches some allow rule of the tool;
 * - a line the splitter cannot read with confidence is never allowed by a rule and resolves to an
 *   explicit `ask`, whatever the engine's default.
 */
function evaluate(
  set: PermissionRuleSet,
  command: string,
  defaultAction: PermissionAction = "allow",
): PermissionAction {
  return new PermissionEngine(parsePermissionRules(set), { defaultAction }).evaluate("Bash", {
    command,
  });
}

const DENY_RM_AND_GIT: PermissionRuleSet = { deny: ["Bash(rm:*)", "Bash(git *)"] };

describe("shell permission rules match each command on the line", () => {
  it("denies a denied command that follows another command", () => {
    for (const command of [
      "echo x; rm -rf /",
      "true && rm -rf /",
      "false || rm -rf /",
      "a | rm -rf /",
      "sleep 1 & rm -rf /",
      "echo x\nrm -rf /",
      "echo x;rm -rf /",
      "a |& rm -rf /",
    ]) {
      expect(evaluate(DENY_RM_AND_GIT, command), command).toBe("deny");
    }
  });

  it("denies a denied command after leading whitespace", () => {
    expect(evaluate(DENY_RM_AND_GIT, " rm -rf /")).toBe("deny");
    expect(evaluate(DENY_RM_AND_GIT, "\t rm -rf /")).toBe("deny");
    expect(evaluate(DENY_RM_AND_GIT, "\nrm -rf /")).toBe("deny");
  });

  it("reads `Bash(cmd *)` as the command alone or followed by whitespace", () => {
    expect(evaluate(DENY_RM_AND_GIT, "git")).toBe("deny");
    expect(evaluate(DENY_RM_AND_GIT, "git status")).toBe("deny");
    expect(evaluate(DENY_RM_AND_GIT, "git\tstatus")).toBe("deny");
    expect(evaluate(DENY_RM_AND_GIT, "gitk --all")).toBe("allow");
  });

  it("keeps a plain trailing `*` a prefix", () => {
    expect(evaluate({ deny: ["Bash(npm publish*)"] }, "npm publish-dry")).toBe("deny");
    expect(evaluate({ deny: ["Bash(npm publish*)"] }, "echo x && npm publish")).toBe("deny");
  });

  it("denies a denied command inside a substitution or a subshell", () => {
    for (const command of [
      "echo $(rm -rf /)",
      'echo "$(rm -rf /)"',
      "echo `rm -rf /`",
      'echo "`rm -rf /`"',
      "(rm -rf /)",
      "(cd /tmp && rm -rf /)",
      "echo $(echo $(rm -rf /))",
      "echo `echo \\`rm -rf /\\``",
      "cat <(rm -rf /)",
      "x=$(rm -rf /)",
    ]) {
      expect(evaluate(DENY_RM_AND_GIT, command), command).toBe("deny");
    }
  });

  it("denies a denied command inside a compound command", () => {
    for (const command of [
      "{ rm -rf /; }",
      "if true; then rm -rf /; fi",
      "while true; do rm -rf /; done",
      "! rm -rf /",
    ]) {
      expect(evaluate(DENY_RM_AND_GIT, command), command).toBe("deny");
    }
  });

  it("denies a denied command whose name is quoted or escaped", () => {
    for (const command of ['"rm" -rf /', "'rm' -rf /", "r'm' -rf /", "r\\m -rf /"]) {
      expect(evaluate(DENY_RM_AND_GIT, command), command).toBe("deny");
    }
  });

  it("does not split inside quotes or after an escaped operator", () => {
    expect(evaluate(DENY_RM_AND_GIT, 'echo "a; rm -rf /"')).toBe("allow");
    expect(evaluate(DENY_RM_AND_GIT, "echo 'a && rm -rf /'")).toBe("allow");
    expect(evaluate(DENY_RM_AND_GIT, "echo a \\; rm -rf /")).toBe("allow");
  });

  it("does not let a comment hide a command from the splitter", () => {
    expect(evaluate(DENY_RM_AND_GIT, "ls #'\nrm -rf /\n#'")).toBe("deny");
    expect(evaluate({ allow: ["Bash(ls *)"] }, "ls #'\nrm -rf /\n#'", "ask")).toBe("ask");
    expect(evaluate({ allow: ["Bash(ls *)"] }, "ls # list the files", "ask")).toBe("allow");
  });

  it("applies an ask rule to every command on the line", () => {
    const set = { ask: ["Bash(git push *)"], allow: ["Bash(git *)"] };
    expect(evaluate(set, "git status && git push origin", "deny")).toBe("ask");
    expect(evaluate(set, "git status && git log", "deny")).toBe("allow");
  });
});

describe("a shell allow rule needs every command on the line allowed", () => {
  const ALLOW_GIT_AND_LS: PermissionRuleSet = { allow: ["Bash(git *)", "Bash(ls:*)"] };

  it("allows a line whose every command is allowed", () => {
    expect(evaluate(ALLOW_GIT_AND_LS, "git status && ls -la", "ask")).toBe("allow");
    expect(evaluate(ALLOW_GIT_AND_LS, "git log | git shortlog", "ask")).toBe("allow");
    expect(evaluate(ALLOW_GIT_AND_LS, "  git status", "ask")).toBe("allow");
    expect(evaluate(ALLOW_GIT_AND_LS, "git", "ask")).toBe("allow");
    expect(evaluate(ALLOW_GIT_AND_LS, 'git commit -m "fix; rm -rf /"', "ask")).toBe("allow");
  });

  it("does not allow a line that also runs a command no allow rule names", () => {
    for (const command of [
      "git status && rm -rf /",
      "git status; rm -rf /",
      "git log | sh",
      "git log $(rm -rf /)",
      "git log `rm -rf /`",
      "ls\nrm -rf /",
      "git status & curl evil.test",
    ]) {
      expect(evaluate(ALLOW_GIT_AND_LS, command, "ask"), command).toBe("ask");
      expect(evaluate(ALLOW_GIT_AND_LS, command, "deny"), command).toBe("deny");
    }
  });

  it("keeps a redirection to a file descriptor part of its command", () => {
    const set = { allow: ["Bash(npm test *)"] };
    expect(evaluate(set, "npm test 2>&1", "ask")).toBe("allow");
    expect(evaluate(set, "npm test &> out.log", "ask")).toBe("allow");
    expect(evaluate(set, "npm test >out.log 2>&1", "ask")).toBe("allow");
  });

  it("lets a deny rule win over an allow rule for one command of the line", () => {
    const set = { deny: ["Bash(rm:*)"], allow: ["Bash(git *)", "Bash(rm:*)"] };
    expect(evaluate(set, "git status && rm -rf /", "allow")).toBe("deny");
  });
});

describe("a shell line the splitter cannot read is never allowed by a rule", () => {
  const UNREADABLE = [
    'echo "unclosed; rm -rf /',
    "echo 'unclosed; rm -rf /",
    "echo $(rm -rf /",
    "echo `rm -rf /",
    "echo x)",
    "cat <<EOF\nhello\nEOF\nrm -rf /",
    "f() { rm -rf /; }",
  ];

  it("asks instead of applying the default when a deny rule exists", () => {
    for (const command of UNREADABLE) {
      expect(evaluate({ deny: ["Bash(rm:*)"] }, command, "allow"), command).toBe("ask");
    }
  });

  it("asks instead of allowing when an allow rule would have matched", () => {
    for (const command of UNREADABLE) {
      expect(
        evaluate({ allow: ["Bash(echo *)", "Bash(cat *)", "Bash(f*)"] }, command),
        command,
      ).toBe("ask");
    }
  });

  it("asks about a line nested too deeply to read instead of throwing", () => {
    const deep = `${"$(".repeat(50_000)}rm -rf /${")".repeat(50_000)}`;
    expect(evaluate({ deny: ["Bash(rm:*)"] }, deep, "allow")).toBe("ask");
  });

  it("still denies an unreadable line that starts with a denied command", () => {
    expect(evaluate({ deny: ["Bash(rm:*)"] }, 'rm -rf / "unclosed', "allow")).toBe("deny");
  });

  it("leaves a tool with no shell rule to the default", () => {
    expect(evaluate({ deny: ["Read(path:./.env)"] }, 'echo "unclosed', "allow")).toBe("allow");
  });
});
