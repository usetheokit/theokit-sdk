/**
 * What the build actually wired — B-108, and the piece `resolveTrustPosture` was the prerequisite
 * for. A framework cannot report a decision it does not make; now it makes one.
 *
 * The defect this exists to prevent has a name and a history in the consumer that measured it. Three
 * separate items each needed a "what is loaded?" listing, and the obvious implementation for each
 * was to re-read the configuration. Their shared acceptance bullet refuses that, in the same words:
 * the listing comes from what was actually wired, not from re-reading the config file — those two
 * can disagree, and the disagreement is the bug worth catching. One of the three was REOPENED for
 * shipping the re-read.
 *
 * A re-read cannot detect that disagreement by construction, because it IS the config. So this is
 * pure and parameterized: it performs no I/O, which is what makes "no second read" checkable rather
 * than promised — a version that could read a file would need a test proving it did not, and such a
 * test is a promise about the absence of behaviour.
 *
 * Generic by the same test as the floor, the fold and the posture: the capability KEYS and the
 * entity names are the caller's, supplied as data.
 */

import { describe, expect, it } from "vitest";

import { recordWiring, UngatedCapabilityError } from "../src/wiring-record.js";

const TRUSTED = { allows: { mcp: true, skills: true } };
const UNTRUSTED = { allows: { mcp: false, skills: false } };

describe("recordWiring — a trusted build wires what was requested", () => {
  it("test_every_requested_name_is_active_when_the_capability_is_allowed", () => {
    const record = recordWiring({
      posture: TRUSTED,
      requested: { mcp: ["postgres", "github"], skills: ["review"] },
    });

    expect(record.mcp.active).toEqual(["postgres", "github"]);
    expect(record.mcp.requested).toEqual(["postgres", "github"]);
    expect(record.skills.active).toEqual(["review"]);
  });

  it("test_nothing_is_flagged_as_suppressed_when_nothing_was_removed", () => {
    const record = recordWiring({
      posture: TRUSTED,
      requested: { mcp: ["postgres"], skills: [] },
    });

    expect(record.mcp.suppressedByTrust).toBe(false);
    expect(record.skills.suppressedByTrust).toBe(false);
  });
});

describe("recordWiring — an untrusted build reports what it withheld", () => {
  it("test_a_withheld_capability_is_empty_but_still_reports_what_was_asked_for", () => {
    // The whole point. `active` alone says "nothing is loaded", which is indistinguishable from a
    // repository that configured nothing — and the user cannot see why their servers are missing.
    const record = recordWiring({
      posture: UNTRUSTED,
      requested: { mcp: ["postgres", "github"], skills: [] },
    });

    expect(record.mcp.active).toEqual([]);
    expect(
      record.mcp.requested,
      "the withheld names were lost, so nothing can explain the absence",
    ).toEqual(["postgres", "github"]);
  });

  it("test_withheld_because_untrusted_is_distinguishable_from_none_configured", () => {
    // The distinction the whole record exists for. Both capabilities are empty and both are
    // untrusted; only one of them actually lost something.
    const record = recordWiring({
      posture: UNTRUSTED,
      requested: { mcp: ["postgres"], skills: [] },
    });

    expect(record.mcp.suppressedByTrust).toBe(true);
    expect(
      record.skills.suppressedByTrust,
      "an untrusted directory that configured no skills was reported as having had skills taken " +
        "away — a flag that fires when nothing happened teaches the reader to ignore it",
    ).toBe(false);
  });

  it("test_a_trusted_capability_with_nothing_configured_is_not_suppression_either", () => {
    // The other half of the same lesson, and the anti-vacuity floor for it: `suppressedByTrust`
    // must depend on BOTH the gate and the request, not on either alone.
    const record = recordWiring({ posture: TRUSTED, requested: { mcp: [], skills: [] } });

    expect(record.mcp.suppressedByTrust).toBe(false);
  });
});

describe("recordWiring — the record covers what the caller declared", () => {
  it("test_every_requested_capability_appears_in_the_record", () => {
    // The invariant that makes forgetting impossible: a capability the build tracks but the report
    // omits is a gap nobody sees, because the reader has no way to know a key is missing.
    const record = recordWiring({
      posture: { allows: { mcp: true, skills: false, hooks: true } },
      requested: { mcp: [], skills: ["a"], hooks: [] },
    });

    expect(Object.keys(record).sort()).toEqual(["hooks", "mcp", "skills"]);
  });

  it("test_no_capability_appears_that_was_not_requested", () => {
    // The reverse. The gate may cover more than the build tracks as named entities — a trust posture
    // gates memory and durable state too, and neither is a list of names. Reporting those as empty
    // entities would invent absences that were never requests.
    const record = recordWiring({
      posture: { allows: { mcp: true, memory: true, agentsMd: false } },
      requested: { mcp: ["postgres"] },
    });

    expect(Object.keys(record)).toEqual(["mcp"]);
  });
});

describe("recordWiring — the record is a snapshot, not a view", () => {
  it("test_mutating_the_requested_list_afterwards_does_not_change_the_record", () => {
    // The record is read after the build, often much later — a slash command, a doctor run. If it
    // aliased the caller's arrays it would answer with whatever the process holds NOW rather than
    // with what was wired, which is the re-read defect wearing a different hat.
    const requested = { mcp: ["postgres"] };
    const record = recordWiring({ posture: { allows: { mcp: true } }, requested });

    requested.mcp.push("injected-later");

    expect(record.mcp.requested).toEqual(["postgres"]);
    expect(record.mcp.active).toEqual(["postgres"]);
  });

  it("test_an_empty_declaration_yields_an_empty_record", () => {
    expect(recordWiring({ posture: { allows: {} }, requested: {} })).toEqual({});
  });
});

describe("recordWiring — a capability nobody gates is an error, not a default", () => {
  it("test_recording_a_capability_the_posture_does_not_gate_is_refused", () => {
    // Reading an absent gate as "not allowed" is the tempting default and it lies in the direction
    // the reader cannot check: the capability would be reported as SUPPRESSED, sending them to look
    // for a trust setting that does not exist. A product wiring an entity nobody gates has a bug in
    // its own declaration, and the loud version is the cheap one to fix.
    expect(() =>
      recordWiring({ posture: { allows: { mcp: true } }, requested: { skills: ["review"] } }),
    ).toThrow(UngatedCapabilityError);
  });

  it("test_the_refusal_names_the_capability_and_what_is_actually_gated", () => {
    // A refusal that only says "ungated capability" sends the reader to diff two lists by hand.
    try {
      recordWiring({ posture: { allows: { mcp: true } }, requested: { skills: [] } });
      throw new Error("expected a throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("skills");
      expect(message).toContain("mcp");
    }
  });
});

describe("recordWiring — scopes and off reasons", () => {
  it("test_scope_is_recorded_per_entity_and_missing_scope_is_undefined", () => {
    const r = recordWiring({
      posture: TRUSTED,
      requested: { mcp: ["a", "b"], skills: ["s"] },
      scopes: { mcp: [{ name: "a", scope: "personal" }, { name: "b", scope: "project" }], skills: [{ name: "s", scope: "operator" }] },
    });
    expect(r.mcp.entities).toEqual([
      { name: "a", scope: "personal" },
      { name: "b", scope: "project" },
    ]);
    expect(r.skills.entities).toEqual([{ name: "s", scope: "operator" }]);
    const bare = recordWiring({ posture: TRUSTED, requested: { mcp: ["x"] } });
    expect(bare.mcp.entities).toEqual([{ name: "x", scope: undefined }]);
    expect(bare.mcp.off).toBeUndefined();
  });

  it("test_off_reasons_trust_config_and_custom", async () => {
    const { offCapabilities } = await import("../src/wiring-record.js");
    const r = recordWiring({
      posture: { allows: { mcp: false, skills: true, hooks: true, cmds: true } },
      requested: { mcp: ["a"], skills: ["s"], hooks: ["h"], cmds: ["c"] },
      disabled: {
        skills: { reason: "disabled-by-config" },
        hooks: { reason: "no-runtime", detail: "headless" },
        mcp: { reason: "disabled-by-config" },
      },
    });
    expect(r.mcp.off).toEqual({ reason: "suppressed-by-trust" });
    expect(r.skills.active).toEqual([]);
    expect(r.cmds.off).toBeUndefined();
    expect(offCapabilities(r)).toEqual([
      { capability: "mcp", reason: "suppressed-by-trust" },
      { capability: "skills", reason: "disabled-by-config" },
      { capability: "hooks", reason: "no-runtime", detail: "headless" },
    ]);
  });
});
