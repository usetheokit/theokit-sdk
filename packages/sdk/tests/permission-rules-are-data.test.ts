import { describe, expect, it } from "vitest";

import { PermissionEngine } from "../src/permission-engine.js";
import { parsePermissionRules } from "../src/permission-rules.js";

/**
 * A permission policy could only be a compiled-in function, so nobody could ship, review or diff one.
 *
 * Measured: `allowedTools` and `disallowedTools` returned 0 files in the agents layer, and the
 * closest facility was `CommandPolicy = (command: string) => string | null` — a CODE PREDICATE. The
 * spec's rule language had no counterpart: `Bash(` 0/0, `domain:` 1/0 and that one in prose.
 *
 * The consequence is not a missing convenience. Every policy was a function, so it could not be
 * audited, diffed, reviewed in a pull request, or varied per environment — and `Read(./.env)`, the
 * spec's own paste-ready secret-exclusion example, could not be expressed at all.
 *
 * ## The grammar, decided as a whole
 *
 * One shape, `Tool` or `Tool(specifier)`, and the specifier says how to read itself rather than the
 * tool deciding by magic:
 *
 * | Written | Matches |
 * |---|---|
 * | `Bash` | every call to `Bash` |
 * | `Bash(npm run test:*)` | the primary argument STARTS WITH `npm run test:` |
 * | `Read(path:./.env)` | the primary argument, read as a path, matches the glob |
 * | `WebFetch(domain:example.com)` | the primary argument's HOST equals `example.com` |
 * | `Bash(npm audit)` | the primary argument EQUALS `npm audit` |
 *
 * A prefixed specifier (`path:`, `domain:`) was chosen over per-tool magic because the alternative —
 * knowing that `Read` means a path and `WebFetch` means a URL — cannot work in a runtime where the
 * consumer brings their own tools. A rule naming a tool this SDK has never heard of must still be
 * readable, and it is: the grammar says what to do, not the tool's name.
 *
 * "The primary argument" is the one part that cannot be derived, so it is DECLARED: the conventional
 * names in order (`command`, `file_path`, `path`, `url`, `query`), then the single string argument
 * when a call has exactly one. A call that matches neither does not match the rule — never a throw,
 * and never a match by default, because a rule that cannot find its argument has not been satisfied.
 */
function verdict(rules: string[], tool: string, args: Record<string, unknown>) {
  const engine = new PermissionEngine(parsePermissionRules({ deny: rules }), {
    defaultAction: "allow",
  });
  return engine.evaluate(tool, args);
}

describe("permission rules are data an operator can ship", () => {
  it("matches every call to a bare tool name", () => {
    expect(verdict(["Bash"], "Bash", { command: "ls" })).toBe("deny");
    expect(verdict(["Bash"], "Read", { file_path: "a.ts" })).toBe("allow");
  });

  it("matches a command prefix with a trailing wildcard", () => {
    expect(verdict(["Bash(npm run test:*)"], "Bash", { command: "npm run test:unit" })).toBe(
      "deny",
    );
    expect(verdict(["Bash(npm run test:*)"], "Bash", { command: "npm run build" })).toBe("allow");
  });

  it("matches an exact specifier without a wildcard", () => {
    // Without this, `Bash(npm audit)` would be a prefix and would also catch `npm audit fix`.
    expect(verdict(["Bash(npm audit)"], "Bash", { command: "npm audit" })).toBe("deny");
    expect(verdict(["Bash(npm audit)"], "Bash", { command: "npm audit fix" })).toBe("allow");
  });

  it("excludes a file by path — the spec's own secret-exclusion example", () => {
    expect(verdict(["Read(path:./.env)"], "Read", { file_path: "./.env" })).toBe("deny");
    expect(verdict(["Read(path:./.env)"], "Read", { file_path: "./README.md" })).toBe("allow");
  });

  it("matches a path glob across directories", () => {
    expect(verdict(["Read(path:src/**/*.key)"], "Read", { file_path: "src/a/b/id.key" })).toBe(
      "deny",
    );
    expect(verdict(["Read(path:src/**/*.key)"], "Read", { file_path: "src/a/b/id.ts" })).toBe(
      "allow",
    );
  });

  it("anchors a path glob at both ends", () => {
    // An unanchored glob matches anywhere in the string, which fails in both directions: a file
    // OUTSIDE the protected tree matches because the pattern appears in its path, and a file inside
    // escapes by having anything appended. Neither is visible from the happy-path assertions above.
    expect(verdict(["Read(path:src/**/*.key)"], "Read", { file_path: "vendor/src/a/id.key" })).toBe(
      "allow",
    );
    expect(verdict(["Read(path:src/**/*.key)"], "Read", { file_path: "src/a/id.key.bak" })).toBe(
      "allow",
    );
  });

  it("matches a URL by host, not by substring", () => {
    expect(
      verdict(["WebFetch(domain:example.com)"], "WebFetch", {
        url: "https://example.com/x",
      }),
    ).toBe("deny");
    // The control that matters: a host merely CONTAINING the domain is a different host, and a
    // substring match here would be an open redirect in policy form.
    expect(
      verdict(["WebFetch(domain:example.com)"], "WebFetch", {
        url: "https://example.com.evil.test/x",
      }),
    ).toBe("allow");
  });

  it("does not match when the primary argument cannot be found", () => {
    // A rule that cannot find its argument has not been satisfied. Matching by default would make
    // every malformed call take whatever action the rule declared — in both directions.
    expect(verdict(["Bash(npm run test:*)"], "Bash", { somethingElse: "npm run test:unit" })).toBe(
      "allow",
    );
  });

  it("does not reach an argument name outside the conventional set, and says what does", () => {
    // The limitation, pinned rather than papered over. A specifier targets one of the declared
    // names; a tool whose argument is called something else cannot be narrowed by specifier.
    //
    // Guessing "the single string argument" was the alternative and it is worse: a rule would then
    // match an argument the operator never named, which widens an allow rule exactly as often as it
    // narrows a deny one.
    expect(verdict(["Bash(npm run test:*)"], "Bash", { cmdline: "npm run test:unit" })).toBe(
      "allow",
    );
    // The escape that always works: a BARE tool name matches every call, whatever it is shaped like.
    expect(verdict(["Bash"], "Bash", { cmdline: "npm run test:unit" })).toBe("deny");
  });

  it("keeps deny, allow and ask as separate lists", () => {
    const engine = new PermissionEngine(
      parsePermissionRules({ allow: ["Read"], deny: ["Read(path:./.env)"], ask: ["Bash"] }),
      { defaultAction: "allow" },
    );
    // Deny is ordered FIRST by the parser, so a narrow deny survives a broad allow. The engine is
    // first-match, so the order the parser emits IS the precedence.
    expect(engine.evaluate("Read", { file_path: "./.env" })).toBe("deny");
    expect(engine.evaluate("Read", { file_path: "./a.ts" })).toBe("allow");
    expect(engine.evaluate("Bash", { command: "ls" })).toBe("ask");
  });

  it("reorders a file whose allow sits above its deny", () => {
    // B-038, pinned by the fixture the item asks for by name. The engine is FIRST-MATCH over an
    // array, while the format groups by category — so a ported file listing `allow` before `deny`
    // for the same tool would silently invert, and the narrower deny would never be reached.
    //
    // Decided in favour of the LOADER reordering, not the engine gaining category evaluation: the
    // engine's array semantics are what every existing consumer already built rules against, and
    // changing how it walks them would move ground under code nobody asked to change. The reorder
    // happens once, where the file is read, and the engine stays the piece that is already
    // fail-closed and already immune to un-deny.
    //
    // The object below deliberately writes `allow` first, which is the order that used to lose.
    const engine = new PermissionEngine(
      parsePermissionRules({ allow: ["Bash"], deny: ["Bash(npm publish*)"] }),
      { defaultAction: "allow" },
    );
    expect(
      engine.evaluate("Bash", { command: "npm publish --access public" }),
      "the allow rule was reached first and the deny below it never ran",
    ).toBe("deny");
    expect(engine.evaluate("Bash", { command: "npm test" })).toBe("allow");
  });

  it("matches an MCP tool written in the documented spelling", () => {
    // The documented name is `mcp__server__tool`, double underscore. This runtime names the same
    // tool `mcp_server_tool` — single, because the name is sanitised for the provider
    // (`loop-context-init.ts:303`). So every permission rule an operator copies from the docs misses
    // its target, silently, and a deny reads as configured while the tool runs.
    //
    // Normalised in the RULE, never in the runtime name. The runtime spelling is what the model sees
    // and what the provider validates; changing it would break every rule already written against it
    // and every consumer matching it. The operator writes the documented form and it matches.
    expect(verdict(["mcp__github__create_issue"], "mcp_github_create_issue", {})).toBe("deny");
  });

  it("leaves a tool name that is not MCP-shaped alone", () => {
    // The control. A blanket `__` → `_` rewrite would rename tools that have nothing to do with MCP
    // and are entitled to a double underscore in their own names.
    expect(verdict(["my__tool"], "my_tool", {})).toBe("allow");
    expect(verdict(["my__tool"], "my__tool", {})).toBe("deny");
  });

  it("refuses a rule it cannot parse rather than dropping it", () => {
    // A policy line an operator wrote and this runtime silently ignored is the belief-in-an-absent
    // protection this whole tier exists to remove.
    expect(() => parsePermissionRules({ deny: ["Bash(unclosed"] })).toThrow(/Bash\(unclosed/);
  });
});
