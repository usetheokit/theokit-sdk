/**
 * The permission rule LANGUAGE — a policy an operator can ship, review and diff.
 *
 * A policy could previously only be a compiled-in function. Measured: `allowedTools` and
 * `disallowedTools` returned 0 files in the agents layer, and the closest facility was
 * `CommandPolicy = (command: string) => string | null` — a code predicate. So no policy could be
 * audited, diffed, reviewed in a pull request, or varied per environment, and `Read(./.env)` — the
 * spec's own paste-ready secret-exclusion example — could not be expressed at all.
 *
 * This turns the spec's rule strings into {@link PermissionRule}s the existing engine already
 * evaluates. The engine is unchanged: first-match, fail-closed by default, explicit deny immune to
 * every auto-approve mode.
 *
 * ## The grammar, decided as a whole rather than one specifier at a time
 *
 * | Written | Matches |
 * |---|---|
 * | `Bash` | every call to `Bash` |
 * | `Bash(npm run test:*)` | the primary argument IS `npm run test` or starts with it plus whitespace |
 * | `Bash(git *)` | the same reading as `Bash(git:*)`: `git` alone or followed by whitespace |
 * | `Bash(npm publish*)` | the primary argument STARTS WITH `npm publish` |
 * | `Read(path:./.env)` | the primary argument, read as a path, matches the glob |
 * | `WebFetch(domain:example.com)` | the primary argument's HOST equals `example.com` |
 * | `Bash(npm audit)` | the primary argument EQUALS `npm audit` |
 *
 * The specifier says how to read ITSELF. The alternative — knowing that `Read` means a path and
 * `WebFetch` means a URL — cannot work in a runtime where the consumer brings their own tools: a
 * rule naming a tool this SDK has never heard of must still be readable, and under a prefixed
 * grammar it is.
 *
 * WHICH argument a specifier reads is the one part that cannot be derived, so the set is DECLARED:
 * `command`, `file_path`, `path`, `url`, `query`. A tool whose argument is named something else
 * cannot be narrowed by specifier, and that limit is stated rather than guessed around. "Read
 * whichever argument is the only string" was the alternative, and it is worse: a rule would match an
 * argument the operator never named, widening an allow rule exactly as often as it narrows a deny
 * one. The escape that always works is a BARE tool name, which matches every call whatever its
 * shape.
 *
 * ## A `command` argument is a shell line, and a line runs several commands
 *
 * A specifier on the `command` argument is matched against EACH command the line runs, as read by
 * `readShellCommandLine`: the line is split outside quotes on `;`, `&&`, `||`, `|`, `&` and
 * newlines, and `$(...)`, backticks and `( ... )` subshells count as further commands.
 *
 * - A `deny` or `ask` rule matches when ANY command of the line matches it.
 * - An `allow` rule matches only when EVERY command of the line matches some `allow` rule of the
 *   same tool. `Bash(git *)` alone does not allow `git status && rm -rf build`.
 * - A line the reader cannot follow (an unbalanced quote or parenthesis, a heredoc) is never allowed
 *   by a rule. When the tool has any rule with a specifier, such a line resolves to an explicit
 *   `ask`, whatever the engine's `defaultAction`, after the deny rules have had their turn on the
 *   line as written.
 *
 * Shell rules are not a sandbox. The reader does not expand variables or aliases and does not look
 * inside a command that runs another one (`sudo`, `env`, `xargs`, `sh -c`, `eval`), so a deny rule
 * on `rm` does not stop `sudo rm`. Keep `defaultAction` at `ask` or `deny` when the rules guard a
 * shell.
 *
 * @public
 */

import { ConfigurationError } from "./errors.js";
import { globToRegex } from "./internal/runtime/context/context-glob.js";
import {
  readShellCommandLine,
  type ShellCommandLine,
} from "./internal/security/shell-command-line.js";
import type { PermissionAction, PermissionRule } from "./permission-engine.js";

/** A policy as an operator writes it: three lists of rule strings. */
export interface PermissionRuleSet {
  readonly deny?: readonly string[];
  readonly ask?: readonly string[];
  readonly allow?: readonly string[];
}

/**
 * Argument names a rule looks at, in order, before falling back to "the single string argument".
 *
 * DECLARED rather than derived, because "the primary argument" is the one part of the grammar that
 * cannot be computed: this runtime does not own the tools and cannot know which field carries the
 * command. These are the conventional names the ecosystem's own tools use.
 */
const PRIMARY_ARG_NAMES = ["command", "file_path", "path", "url", "query"] as const;

/**
 * Parse a rule set into engine rules, DENY first.
 *
 * The engine is first-match, so the order emitted here IS the precedence — and a narrow deny must
 * survive a broad allow, or `Read` + `Read(path:./.env)` would read the secret the second line
 * exists to protect. `ask` sits between them: it is a restriction on something otherwise allowed.
 *
 * @throws ConfigurationError on a rule this grammar cannot read. A policy line an operator wrote and
 *   this runtime silently ignored is the belief-in-an-absent-protection the whole tier removes.
 */
export function parsePermissionRules(set: PermissionRuleSet): PermissionRule[] {
  const deny = (set.deny ?? []).map(readRule);
  const ask = (set.ask ?? []).map(readRule);
  const allow = (set.allow ?? []).map(readRule);
  const allowedCommands = commandMatchersByTool(allow);
  const toParsed = (action: PermissionAction) => (rule: ReadRule) =>
    parseOne(rule, action, allowedCommands);
  return [
    ...deny.flatMap(toParsed("deny")),
    ...unreadableLineRules([...deny, ...ask, ...allow]),
    ...ask.flatMap(toParsed("ask")),
    ...allow.flatMap(toParsed("allow")),
  ];
}

/** A rule string split into its tool and, when it has one, its specifier. */
interface ReadRule {
  readonly tool: string;
  readonly specifier?: string;
}

/** The argument a shell line arrives in. */
const SHELL_COMMAND_ARG = "command";

function readRule(rule: string): ReadRule {
  const trimmed = rule.trim();
  const open = trimmed.indexOf("(");
  if (open === -1) {
    if (trimmed.length === 0) {
      throw new ConfigurationError("permission rule is empty", { code: "permission_rule_invalid" });
    }
    return { tool: normaliseToolName(trimmed) };
  }
  if (!trimmed.endsWith(")")) {
    throw new ConfigurationError(
      `permission rule "${rule}" opens a specifier and never closes it — expected Tool(specifier)`,
      { code: "permission_rule_invalid" },
    );
  }
  const tool = trimmed.slice(0, open).trim();
  const specifier = trimmed.slice(open + 1, -1);
  if (tool.length === 0) {
    throw new ConfigurationError(`permission rule "${rule}" names no tool`, {
      code: "permission_rule_invalid",
    });
  }
  if (specifier === "*") return { tool: normaliseToolName(tool) };
  return { tool: normaliseToolName(tool), specifier };
}

function parseOne(
  rule: ReadRule,
  action: PermissionAction,
  allowedCommands: ReadonlyMap<string, CommandMatcher[]>,
): PermissionRule[] {
  const { tool: name, specifier } = rule;
  if (specifier === undefined) return [{ tool: name, action }];

  // ONE rule per conventional argument name, rather than one rule with a matcher that inspects the
  // whole call.
  //
  // The engine's `ArgMatcher` receives a single VALUE, and its `#argsMatch` fails a matcher whose
  // argument is absent — an invariant with its own history (#367: a predicate invoked with
  // `undefined` widened an allow rule that was written to narrow). Keying on a synthetic
  // "whichever argument is primary" would never match, and widening `ArgMatcher` to see siblings
  // would trade that tested invariant for a parser.
  //
  // The engine is FIRST-MATCH and every rule here carries the same action, so whichever argument the
  // call actually supplies decides, and the rest fall through without effect.
  //
  // The `command` argument is a shell line and is read command by command; see the module docblock.
  const test = predicateFor(specifier);
  const command = commandMatcherFor(specifier);
  const shellTest =
    command === undefined ? test : shellLinePredicate(command, action, allowedCommands.get(name));
  return PRIMARY_ARG_NAMES.map((arg) => ({
    tool: name,
    action,
    args: { [arg]: arg === SHELL_COMMAND_ARG ? shellTest : test },
  }));
}

/** Tests ONE command of a shell line, or any other string argument. */
type CommandMatcher = (command: string) => boolean;

/**
 * The shell-line reading of a command specifier.
 *
 * `deny` and `ask` restrict, so ANY command of the line is enough. `allow` widens, so it needs EVERY
 * command of the line allowed by some `allow` rule of the tool, and this rule must be one of them.
 * Only the written spelling counts toward an allow; the unquoted one only ever adds a match to a
 * restriction (`"rm" -rf /` is `rm`).
 */
function shellLinePredicate(
  command: CommandMatcher,
  action: PermissionAction,
  allowed: readonly CommandMatcher[] = [],
): (value: unknown) => boolean {
  if (action !== "allow") {
    return (v) => {
      if (typeof v !== "string") return false;
      const line = readLine(v);
      if (!line.readable) return command(v.trim());
      return line.commands.some((c) => command(c.raw) || command(c.unquoted));
    };
  }
  return (v) => {
    if (typeof v !== "string") return false;
    const line = readLine(v);
    if (!line.readable) return false;
    const everyAllowed = line.commands.every((c) => allowed.some((m) => m(c.raw)));
    return everyAllowed && line.commands.some((c) => command(c.raw));
  };
}

/** The command matchers of every `allow` rule, by tool, for the every-command check. */
function commandMatchersByTool(rules: readonly ReadRule[]): Map<string, CommandMatcher[]> {
  const byTool = new Map<string, CommandMatcher[]>();
  for (const rule of rules) {
    const matcher = rule.specifier === undefined ? undefined : commandMatcherFor(rule.specifier);
    if (matcher === undefined) continue;
    byTool.set(rule.tool, [...(byTool.get(rule.tool) ?? []), matcher]);
  }
  return byTool;
}

/**
 * One explicit `ask` per tool that has a command rule, for a shell line the reader cannot follow.
 *
 * Emitted after the deny rules, so a line that visibly starts with a denied command is still denied,
 * and before every allow rule, so no allow rule and no `defaultAction: "allow"` can let it through.
 */
function unreadableLineRules(rules: readonly ReadRule[]): PermissionRule[] {
  const tools = new Set(
    rules
      .filter((r) => r.specifier !== undefined && commandMatcherFor(r.specifier) !== undefined)
      .map((r) => r.tool),
  );
  return [...tools].map((tool) => ({
    tool,
    action: "ask",
    args: { [SHELL_COMMAND_ARG]: (v: unknown) => typeof v === "string" && !readLine(v).readable },
  }));
}

/**
 * One line is evaluated against every rule, five argument names each, so the last reading is kept.
 * The reader is pure, so the cache can only ever return what reading again would.
 */
let lastLine: { readonly text: string; readonly read: ShellCommandLine } | undefined;

function readLine(text: string): ShellCommandLine {
  if (lastLine?.text !== text) lastLine = { text, read: readShellCommandLine(text) };
  return lastLine.read;
}

/**
 * The runtime's spelling for a tool name an operator may legitimately write.
 *
 * The documented MCP tool name is `mcp__server__tool`, double underscore. This runtime names the
 * same tool `mcp_server_tool` — single, because the name is sanitised for the provider. So a
 * permission rule copied from the documentation misses its target SILENTLY: the deny reads as
 * configured and the tool runs.
 *
 * Normalised in the RULE, never in the runtime name. The runtime spelling is what the model sees and
 * what the provider validates; changing it would break every rule already written against it and
 * every consumer matching it, to fix a mismatch that costs one substitution here.
 *
 * Scoped to the `mcp__` prefix rather than rewriting every `__`: a tool outside MCP is entitled to a
 * double underscore in its own name, and a blanket rewrite would rename it.
 */
function normaliseToolName(tool: string): string {
  if (!tool.startsWith("mcp__")) return tool;
  return `mcp_${tool.slice("mcp__".length).replaceAll("__", "_")}`;
}

/**
 * The Claude Code command-prefix suffix. `Bash(ls:*)` matches the same commands as `Bash(ls *)`:
 * the command itself, or the command followed by whitespace and anything. Recognised only at the
 * end of a specifier; anywhere else the colon is literal text.
 */
const COMMAND_PREFIX_SUFFIX = ":*";

/** `Bash(git *)`: a `*` after whitespace reads like `:*`, the command alone or followed by more. */
const COMMAND_SPACE_SUFFIX = /\s+\*$/;

function predicateFor(specifier: string): (value: unknown) => boolean {
  if (specifier.startsWith("path:")) {
    const re = globToRegex(specifier.slice("path:".length));
    return (v) => typeof v === "string" && re.test(v);
  }
  if (specifier.startsWith("domain:")) {
    const host = specifier.slice("domain:".length).toLowerCase();
    return (v) => typeof v === "string" && hostOf(v) === host;
  }
  const command = commandMatcherFor(specifier) as CommandMatcher;
  return (v) => typeof v === "string" && command(v);
}

/** The matcher for a specifier that names a command, or `undefined` for `path:` and `domain:`. */
function commandMatcherFor(specifier: string): CommandMatcher | undefined {
  if (specifier.startsWith("path:") || specifier.startsWith("domain:")) return undefined;
  if (specifier.endsWith(COMMAND_PREFIX_SUFFIX)) {
    const command = specifier.slice(0, -COMMAND_PREFIX_SUFFIX.length);
    return (v) => isCommandOrItsInvocation(v, command);
  }
  if (COMMAND_SPACE_SUFFIX.test(specifier)) {
    const command = specifier.replace(COMMAND_SPACE_SUFFIX, "");
    return (v) => isCommandOrItsInvocation(v, command);
  }
  if (specifier.endsWith("*")) {
    const prefix = specifier.slice(0, -1);
    return (v) => v.startsWith(prefix);
  }
  return (v) => v === specifier;
}

/** `command` alone, or `command` followed by whitespace: `rm -rf /` is `rm`, `rmdir` is not. */
function isCommandOrItsInvocation(value: string, command: string): boolean {
  if (!value.startsWith(command)) return false;
  const next = value.charAt(command.length);
  return next === "" || /\s/.test(next);
}

/** The HOST, never a substring — `example.com.evil.test` is a different host, not a match. */
function hostOf(value: string): string | undefined {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}
