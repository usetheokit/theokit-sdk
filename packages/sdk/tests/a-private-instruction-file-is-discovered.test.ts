import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import {
  DEFAULT_DISCOVERY_SPECS,
  type DiscoverySpec,
} from "../src/internal/runtime/context/context-discovery.js";
import { runDiscovery } from "../src/internal/runtime/context/context-discovery-runner.js";
import { removeTempDirRobustSync } from "./helpers/temp-workspace.js";

/**
 * The gitignored companion nobody discovered.
 *
 * `*.local.md` is where an operator keeps the standing corrections too personal or too situational
 * to commit. Measured 2026-09-12: a grep for the four `.local` spellings returned 0 files across
 * this package's source, against a control of 23 for `CLAUDE.md`. The file exists, it is named the
 * documented way, nothing loads it, and nothing complains — so the agent behaves exactly as it would
 * if the operator had written nothing, which from the outside is indistinguishable from the
 * instructions being wrong.
 *
 * This is the SDK half. `@theokit/agents`' `loadInstructionTree` is the other, and the item's
 * Definition of Done asks for both, because that primitive has a real consumer downstream while the
 * compiler path here is what an ordinary agent actually walks. Closing one would leave the operator
 * with a file that works through one door and not the other.
 */
function projectWith(files: Record<string, string>): string {
  const cwd = mkdtempSync(join(tmpdir(), "theokit-local-instructions-"));
  onTestFinished(() => removeTempDirRobustSync(cwd));
  for (const [rel, body] of Object.entries(files)) {
    const parts = rel.split("/");
    if (parts.length > 1) mkdirSync(join(cwd, ...parts.slice(0, -1)), { recursive: true });
    writeFileSync(join(cwd, ...parts), body);
  }
  return cwd;
}

const discover = async (cwd: string) =>
  (await runDiscovery({ cwd, maxBytesPerFile: 100_000 })).map((s) => s.id);

const specById = new Map(DEFAULT_DISCOVERY_SPECS.map((s) => [s.id, s]));
const priorityOf = (id: string): number => {
  const spec = specById.get(id);
  if (spec === undefined) throw new Error(`no discovery spec declares id "${id}"`);
  return spec.priority;
};

describe("the private instruction chain is discovered", () => {
  it.each(["AGENTS.local.md", "CLAUDE.local.md", "THEO.local.md"])("finds %s", async (name) => {
    const ids = await discover(projectWith({ [name]: "PRIVATE RULE" }));

    expect(ids, `${name} is the documented spelling and nothing discovered it`).toContain(name);
  });

  it("does not replace the public sibling", async () => {
    // The chains are independent. One falling back to the other is the trap: adding a `THEO.md`
    // would silently orphan an existing `AGENTS.local.md` — a file the operator wrote, disabled by
    // a file they added for an unrelated reason.
    const ids = await discover(
      projectWith({ "AGENTS.md": "PUBLIC", "AGENTS.local.md": "PRIVATE" }),
    );

    expect(ids).toContain("AGENTS.md");
    expect(ids).toContain("AGENTS.local.md");
  });

  it("discovers nothing that merely looks local", async () => {
    // The control. A pattern matched loosely would pull `AGENTS.locale.md` — somebody else's file —
    // into the system prompt.
    const ids = await discover(
      projectWith({ "AGENTS.locale.md": "NOT AN INSTRUCTION FILE", "local.md": "NOR THIS" }),
    );

    expect(ids).toEqual([]);
  });
});

describe("the private chain is composed after the public one", () => {
  it.each([
    ["AGENTS.local.md", "AGENTS.md"],
    ["CLAUDE.local.md", "CLAUDE.md"],
    ["THEO.local.md", "THEO.md.root"],
  ])("ranks %s after %s", (priv, pub) => {
    // A correction composed BEFORE the rule it corrects loses to it. `applyAggregateCap` sorts by
    // priority ascending, so "after" means a strictly greater number — asserted against the sibling
    // rather than against a literal, so renumbering the table cannot quietly invert the pair.
    expect(priorityOf(priv)).toBeGreaterThan(priorityOf(pub));
  });

  it("ranks the whole private chain above every public spec", () => {
    const isPrivate = (s: DiscoverySpec) => s.id.endsWith(".local.md");
    const privates = DEFAULT_DISCOVERY_SPECS.filter(isPrivate);
    const publics = DEFAULT_DISCOVERY_SPECS.filter((s) => !isPrivate(s));

    expect(privates.length, "the private chain is empty, so the loop below proves nothing").toBe(3);
    expect(Math.min(...privates.map((s) => s.priority))).toBeGreaterThan(
      Math.max(...publics.map((s) => s.priority)),
    );
  });

  it("keeps the public chain's own relative order among the private specs", () => {
    // So the two halves read the same way rather than being two orderings a reader has to hold.
    expect(priorityOf("AGENTS.local.md")).toBeLessThan(priorityOf("CLAUDE.local.md"));
    expect(priorityOf("CLAUDE.local.md")).toBeLessThan(priorityOf("THEO.local.md"));
  });
});
