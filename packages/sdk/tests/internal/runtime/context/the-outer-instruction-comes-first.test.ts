import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { applyAggregateCap } from "../../../../src/internal/runtime/context/context-aggregator.js";
import { runDiscovery } from "../../../../src/internal/runtime/context/context-discovery-runner.js";
import { removeTempDirRobustSync } from "../../../helpers/temp-workspace.js";

/**
 * Nested instruction files reach the prompt outermost-first, and nothing said so.
 *
 * The spec orders root-down: the repository-wide `CLAUDE.md` is read before the one in the
 * subdirectory, so the nearer file refines the wider one rather than being buried under it. This
 * runtime produces that order — measured `walk=[DEEP,SUB,ROOT] prompt=[ROOT,SUB,DEEP]` — and
 * produces it **by accident**.
 *
 * `walkUpForFile` returns NEAREST-first: it starts at cwd and pushes as it climbs. The order that
 * reaches the model is not that one. `applyAggregateCap` re-sorts by priority, then breaks ties by
 * absolute source path lexicographically, and for files under a common root a shorter path sorts
 * first — so root-down falls out of a tie-break written for prompt-cache determinism (EC-J).
 *
 * That is the whole reason this test exists. The behaviour is correct and the mechanism producing it
 * is a coincidence: change the tie-break, rename a directory to something lexically smaller than its
 * parent, and precedence inverts with nothing to catch it. A repository-wide instruction would end
 * up read after the nested one that was meant to refine it.
 *
 * A survey claimed the opposite — "the SDK orders nearest-first, reversed precedence" — reading the
 * walk and stopping there. The walk IS nearest-first; it is not what the model sees.
 *
 * ## The divergence that is real
 *
 * The walk stops at the git root, while the spec continues to every directory above cwd. Kept, with
 * the reason: a `CLAUDE.md` in a home directory or in `/tmp` would silently apply to every
 * repository underneath it, and an instruction file nobody in the project wrote is the one case
 * where "found more" is worse than "found less". The operator-home question — `~/.claude/rules/` —
 * is a deliberate, separate decision rather than a side effect of how far a loop runs.
 */
function nestedProject(): string {
  const root = mkdtempSync(join(tmpdir(), "theokit-instr-order-"));
  onTestFinished(() => {
    removeTempDirRobustSync(root);
  });
  // A `.git` directory is what stops the walk, and what makes this a repository rather than a
  // directory that happens to be under /tmp.
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, "sub", "deep"), { recursive: true });
  writeFileSync(join(root, "CLAUDE.md"), "ROOTRULE\n");
  writeFileSync(join(root, "sub", "CLAUDE.md"), "SUBRULE\n");
  writeFileSync(join(root, "sub", "deep", "CLAUDE.md"), "DEEPRULE\n");
  return root;
}

function label(content: string): string {
  if (content.includes("DEEPRULE")) return "DEEP";
  if (content.includes("SUBRULE")) return "SUB";
  if (content.includes("ROOTRULE")) return "ROOT";
  return "?";
}

describe("the outer instruction file reaches the prompt first", () => {
  it("orders root-down, whatever order the walk returned", async () => {
    const root = nestedProject();
    const sources = await runDiscovery({ cwd: join(root, "sub", "deep"), maxBytesPerFile: 40_000 });

    expect(
      applyAggregateCap(sources, 100_000).kept.map((s) => label(s.content)),
      "a nested instruction was read before the repository-wide one it was meant to refine",
    ).toEqual(["ROOT", "SUB", "DEEP"]);
  });

  it("collects every level between cwd and the git root", async () => {
    const root = nestedProject();
    const sources = await runDiscovery({ cwd: join(root, "sub", "deep"), maxBytesPerFile: 40_000 });
    expect(sources.map((s) => label(s.content)).sort()).toEqual(["DEEP", "ROOT", "SUB"]);
  });

  it("stops at the git root rather than climbing out of the project", async () => {
    // The divergence from the spec, pinned rather than hidden. A `CLAUDE.md` above the repository
    // would apply to every repository underneath it, and an instruction nobody in the project wrote
    // is the one case where finding more is worse than finding less.
    const outer = mkdtempSync(join(tmpdir(), "theokit-instr-outer-"));
    onTestFinished(() => {
      removeTempDirRobustSync(outer);
    });
    const repo = join(outer, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(outer, "CLAUDE.md"), "OUTSIDERULE\n");
    writeFileSync(join(repo, "CLAUDE.md"), "ROOTRULE\n");

    const sources = await runDiscovery({ cwd: repo, maxBytesPerFile: 40_000 });

    expect(sources.map((s) => label(s.content))).toEqual(["ROOT"]);
    expect(JSON.stringify(sources)).not.toContain("OUTSIDERULE");
  });
});
