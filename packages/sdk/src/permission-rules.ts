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
 * | `Bash(npm run test:*)` | the primary argument STARTS WITH `npm run test:` |
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
 * @public
 */

import { ConfigurationError } from "./errors.js";
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
  return [
    ...(set.deny ?? []).flatMap((r) => parseOne(r, "deny")),
    ...(set.ask ?? []).flatMap((r) => parseOne(r, "ask")),
    ...(set.allow ?? []).flatMap((r) => parseOne(r, "allow")),
  ];
}

function parseOne(rule: string, action: PermissionAction): PermissionRule[] {
  const trimmed = rule.trim();
  const open = trimmed.indexOf("(");
  if (open === -1) {
    if (trimmed.length === 0) {
      throw new ConfigurationError("permission rule is empty", { code: "permission_rule_invalid" });
    }
    return [{ tool: normaliseToolName(trimmed), action }];
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
  if (specifier === "*") return [{ tool: normaliseToolName(tool), action }];

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
  const test = predicateFor(specifier);
  const name = normaliseToolName(tool);
  return PRIMARY_ARG_NAMES.map((arg) => ({ tool: name, action, args: { [arg]: test } }));
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

function predicateFor(specifier: string): (value: unknown) => boolean {
  if (specifier.startsWith("path:")) {
    const re = globToRegExp(specifier.slice("path:".length));
    return (v) => typeof v === "string" && re.test(v);
  }
  if (specifier.startsWith("domain:")) {
    const host = specifier.slice("domain:".length).toLowerCase();
    return (v) => typeof v === "string" && hostOf(v) === host;
  }
  if (specifier.endsWith("*")) {
    const prefix = specifier.slice(0, -1);
    return (v) => typeof v === "string" && v.startsWith(prefix);
  }
  return (v) => v === specifier;
}

/** The HOST, never a substring — `example.com.evil.test` is a different host, not a match. */
function hostOf(value: string): string | undefined {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * A path glob: `*` within one segment, `**` across any depth, `?` one character.
 *
 * Built from the literal, never taken from it — every metacharacter outside the three is escaped, so
 * a policy line cannot smuggle a regular expression into the matcher.
 */
/**
 * One glob character as its regex, and how many extra characters it consumed.
 *
 * Split from the loop because the loop was a switch with three nested lookaheads and reached a
 * cognitive complexity of 13 against this repository's limit of 10. The split is not cosmetic: it
 * puts each rule where it can be read on its own, and `**` consuming a following `/` — so
 * `src/**\/*.key` matches `src/a.key` as well as `src/a/b.key` — stops being a side effect of loop
 * bookkeeping.
 */
function translateGlobChar(glob: string, i: number): { pattern: string; consumed: number } {
  const c = glob[i] ?? "";
  if (c === "?") return { pattern: "[^/]", consumed: 0 };
  if (c !== "*") return { pattern: c.replace(/[.+^${}()|[\]\\]/g, "\\$&"), consumed: 0 };
  if (glob[i + 1] !== "*") return { pattern: "[^/]*", consumed: 0 };
  // `**` spans any depth INCLUDING zero, so it swallows the separator that would otherwise be
  // required after it.
  return { pattern: ".*", consumed: glob[i + 2] === "/" ? 2 : 1 };
}

function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const piece = translateGlobChar(glob, i);
    out += piece.pattern;
    i += piece.consumed;
  }
  // eslint-disable-next-line security/detect-non-literal-regexp
  return new RegExp(`^${out}$`);
}
