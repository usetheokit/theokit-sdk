/**
 * `@theokit/sdk/context` — the sanctioned public barrel for context assembly.
 *
 * Plan: `sdk-context-public-barrel` (B-103). The measurement behind it found three capabilities
 * implemented inside `internal/runtime/context/` and reachable by nobody: 30 subpaths are declared,
 * none covers the tree, and every deep import answers `ERR_PACKAGE_PATH_NOT_EXPORTED`.
 *
 * The second case is the one that matters most. `resolveImports` takes `projectRoot` as an OPTIONAL
 * field — correct for the internal callers that predate 4.41.1, and wrong as a public contract: the
 * obvious call omits it and silently gets the un-contained behaviour 4.41.1 patched. Publishing that
 * signature would ship the patched vulnerability back out as a semver-guaranteed API, with the
 * unsafe form as the path of least resistance. The public surface therefore REQUIRES the root.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as contextBarrel from "../src/context/index.js";
import {
  type ResolveContextImportsOptions,
  resolveContextImports,
  runDiscovery,
} from "../src/context/index.js";

/** Exactly what the barrel promises. A new symbol here is a deliberate public-surface decision. */
const DECLARED_SYMBOLS = [
  "DEFAULT_DISCOVERY_SPECS",
  "parseRules",
  "resolveContextImports",
  "runDiscovery",
  "shouldActivateRule",
  "withheldSpecs",
] as const;

let root: string;
let repo: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "theokit-context-barrel-"));
  repo = join(root, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(root, "outside.txt"), "SENTINEL-OUTSIDE", "utf8");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the context barrel is a curated public surface", () => {
  it("test_the_context_barrel_exports_the_declared_symbols", () => {
    // Value exports only — types erase at runtime and cannot be asserted here.
    expect(Object.keys(contextBarrel).sort()).toEqual([...DECLARED_SYMBOLS]);
  });

  it("test_the_public_import_resolver_requires_a_root", async () => {
    const base = join(repo, "CLAUDE.md");

    // `projectRoot` is REQUIRED on the public surface. If this stops being a type error, the barrel
    // has started publishing the un-contained call as the easy one (EC-1).
    //
    // Asserted on a typed BINDING rather than on the call: TS reports a missing property against
    // the whole argument expression, so a directive inside the object literal suppresses nothing
    // and is itself reported unused. A binding puts the error on the line the directive precedes.
    // @ts-expect-error — omitting `projectRoot` must not compile.
    const optionsWithoutRoot: ResolveContextImportsOptions = { maxBytesPerFile: 64_000 };
    expect(optionsWithoutRoot.maxBytesPerFile).toBe(64_000);

    const out = await resolveContextImports(`@${join(root, "outside.txt")}`, base, {
      projectRoot: repo,
      maxBytesPerFile: 64_000,
    });
    expect(out).not.toContain("SENTINEL-OUTSIDE");
    expect(out).toContain("refused");
  });

  it("test_the_default_specs_are_reachable_so_custom_specs_can_extend_them", async () => {
    // REVIEW F1 — `runDiscovery` does `opts.specs ?? DEFAULT_DISCOVERY_SPECS`, so passing `specs`
    // REPLACES the built-in conventions. Without the constant on the public surface a consumer
    // registering one convention of its own silently loses AGENTS.md, CLAUDE.md and the rules
    // globs, and the loss is invisible: discovery just returns fewer sources.
    const { DEFAULT_DISCOVERY_SPECS } = await import("../src/context/index.js");

    expect(DEFAULT_DISCOVERY_SPECS.length).toBeGreaterThan(0);
    expect(DEFAULT_DISCOVERY_SPECS.map((s) => s.id)).toContain("AGENTS.md");
    // The spread a consumer is expected to write must type-check and preserve the built-ins.
    const extended = [...DEFAULT_DISCOVERY_SPECS];
    expect(extended.length).toBe(DEFAULT_DISCOVERY_SPECS.length);
  });

  it("test_public_run_discovery_refuses_an_import_outside_the_repository", async () => {
    // EC-2: the runner defaults its root to `gitRoot ?? cwd`, so the default IS safe. This case is
    // what keeps it safe now that the function is public and someone could change that default.
    writeFileSync(join(repo, "CLAUDE.md"), `# Repo\n\n@${join(root, "outside.txt")}\n`, "utf8");

    const sources = await runDiscovery({ cwd: repo, maxBytesPerFile: 64_000 });
    const claude = sources.find((s) => s.id.startsWith("CLAUDE.md"));

    expect(
      claude,
      "CLAUDE.md was not discovered — the assertion below would be vacuous",
    ).toBeDefined();
    expect(claude?.content).not.toContain("SENTINEL-OUTSIDE");
  });
});
