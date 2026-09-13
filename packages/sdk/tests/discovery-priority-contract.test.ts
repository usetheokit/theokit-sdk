/**
 * B-127 — `priority` on a discovery spec is a public contract, and it is a raw number.
 *
 * `DEFAULT_DISCOVERY_SPECS` is exported precisely so a consumer can EXTEND the seven defaults
 * rather than replace them. Placing its own source between two of them therefore means choosing a
 * number by reading that `AGENTS.md` is 10 and `CLAUDE.md` is 30 — a position in a list the
 * consumer does not own. The day this package inserts an eighth default at 25, every consumer that
 * picked 25 silently changes where its own instructions land in the merged context.
 *
 * ## The decision, recorded rather than deferred
 *
 * The raw number STAYS. A relative API (`before("AGENTS.md")`) would be a public surface designed
 * against a single consumer, which is the mistake B-104's deferral is the precedent for — and it is
 * unnecessary: the constant is already exported, so relative placement is one line at the call site
 * over data the consumer already has. Rung 1 of the parsimony ladder: it does not need to exist.
 *
 * What the raw number needs instead is that it cannot MOVE. These cases pin the seven published
 * priorities, so adding an eighth default is a deliberate act that must reckon with the numbers
 * consumers have already built on, rather than a silent re-ordering of their context.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_DISCOVERY_SPECS } from "../src/internal/runtime/context/context-discovery.js";

describe("B-127 — the published priorities are a contract", () => {
  it("test_the_published_defaults_keep_the_ids_and_priorities_consumers_build_on", () => {
    // Written out rather than derived: a test that recomputed these from the source would agree
    // with any change, which is the opposite of what a contract test is for.
    expect(DEFAULT_DISCOVERY_SPECS.map((s) => [s.id, s.priority])).toEqual([
      ["AGENTS.md", 10],
      ["GEMINI.md", 20],
      ["CLAUDE.md", 30],
      ["cursor-rules", 40],
      ["theokit-rules", 45],
      // The eighth default, added deliberately (see `context-discovery.ts`). No number above MOVED,
      // which is the promise this case exists to keep; a consumer that had chosen 47 collides, and
      // that cost is recorded rather than discovered.
      ["claude-rules", 47],
      ["theokit-context", 50],
      // The ninth default (usetheokit/theokit-sdk#531) — THEO.md.root, so a project-root THEO.md is
      // finally read like AGENTS.md/GEMINI.md/CLAUDE.md already are. 55 sits between 50 and the
      // existing THEO.md at 60, which did not move: a project already using .theokit/THEO.md keeps
      // its exact position. A consumer who had chosen 55 collides, and that cost is recorded here
      // rather than discovered, same as claude-rules above.
      ["THEO.md.root", 55],
      ["THEO.md", 60],
      // The tenth, eleventh and twelfth (B-023) — the private `*.local.md` chain. NO NUMBER ABOVE
      // MOVED, which is the promise this case exists to keep. They sit above every public spec
      // because a correction has to be composed after the rule it corrects, and they keep the
      // public chain's relative order among themselves so both halves read the same way.
      //
      // A consumer who had chosen 70, 75 or 80 collides, and that cost is recorded here rather than
      // discovered, same as claude-rules at 47 and THEO.md.root at 55.
      ["AGENTS.local.md", 70],
      ["CLAUDE.local.md", 75],
      ["THEO.local.md", 80],
    ]);
  });

  it("test_no_two_defaults_share_a_priority", () => {
    // Ties fall through to a secondary rule, so two specs at the same number means the merge order
    // between them is decided by something nobody declared.
    const priorities = DEFAULT_DISCOVERY_SPECS.map((s) => s.priority);

    expect(new Set(priorities).size).toBe(priorities.length);
  });

  it("test_a_consumer_can_place_a_source_relative_to_a_named_default", () => {
    // The DoD's first bullet, satisfied without new API. The constant is exported, so "just after
    // AGENTS.md and before GEMINI.md" is arithmetic the consumer does over data it already has —
    // and this case is what keeps that arithmetic honest if the numbers ever move.
    const agents = DEFAULT_DISCOVERY_SPECS.find((s) => s.id === "AGENTS.md");
    const gemini = DEFAULT_DISCOVERY_SPECS.find((s) => s.id === "GEMINI.md");

    expect(agents).toBeDefined();
    expect(gemini).toBeDefined();
    const between = (agents?.priority ?? 0) + 1;

    expect(between).toBeGreaterThan(agents?.priority ?? 0);
    expect(between).toBeLessThan(gemini?.priority ?? 0);
  });

  it("test_there_is_room_between_every_adjacent_pair_for_a_consumer_source", () => {
    // What makes the arithmetic above possible at all. Adjacent defaults one apart would leave a
    // consumer no slot between them, and the only remedy would be renumbering — which is the
    // silent move this contract exists to prevent.
    const sorted = [...DEFAULT_DISCOVERY_SPECS].sort((a, b) => a.priority - b.priority);
    const tooTight = sorted
      .slice(1)
      .map((spec, i) => [sorted[i]?.id, spec.id, spec.priority - (sorted[i]?.priority ?? 0)])
      .filter(([, , gap]) => (gap as number) < 2);

    expect(tooTight, "no room for a consumer source between these").toEqual([]);
  });
});
