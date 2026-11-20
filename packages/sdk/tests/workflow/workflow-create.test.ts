/**
 * Tests for `Workflow.create` + `WorkflowBuilder` public surface.
 * Covers commit, validation, helper factories, EC-3/5/9.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ConfigurationError } from "../../src/errors.js";
import { __resetSnapshotStoresForTests } from "../../src/internal/workflow/snapshot-store.js";

import { agentStep, fn, Workflow, WorkflowDuplicateStepIdError } from "../../src/workflow.js";

/**
 * Returns the value a thrower threw, so a test can interrogate it beyond its class.
 *
 * B-079 residue. `toThrow(SomeError)` is coarse: `ConfigurationError` has three subclasses and 132
 * throw sites in `src/`, and `z.ZodError` is raised by every schema in the SDK. The class says
 * "a validation refused this"; only the discriminator (`.code` for SDK errors, `issues[].code` for
 * Zod) says WHICH rule refused it, which is what these tests are named after.
 */
function caught(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw, but it returned normally");
}

/** The Zod issue codes raised by a rejection, in order. */
function zodIssueCodes(error: unknown): string[] {
  expect(error).toBeInstanceOf(z.ZodError);
  return (error as z.ZodError).issues.map((issue) => issue.code);
}

describe("Workflow.create", () => {
  it("validates options via Zod (name required)", () => {
    // B-079. Bare `toThrow()` passes on any failure. Measured which error actually arrives —
    // `ZodError` for schema rejections, `ConfigurationError` for identifier validation — and the two
    // live on adjacent lines in this file, so one matcher per file would have been wrong on half of
    // it. The type is asserted, not the message: `ZodError`'s message is serialised JSON and would
    // couple these tests to Zod's formatting.
    expect(() => Workflow.create({ name: "" } as never)).toThrow(z.ZodError);
    // ...and WHICH rule refused it. `z.ZodError` alone cannot distinguish "the name was empty"
    // from "the name was 300 chars" or "the name was a number" — three different bugs that a
    // caller fixes three different ways. The issue code is the discriminator; the message is not,
    // because Zod serialises it as JSON and its formatting moves between minor versions.
    expect(zodIssueCodes(caught(() => Workflow.create({ name: "" } as never)))).toContain(
      "too_small",
    );
    // § 4.2 — the accepted case is half the oracle: a schema that rejected EVERY name would pass
    // the line above.
    expect(() => Workflow.create({ name: "demo" })).not.toThrow();
  });

  it("EC-3 — retry maxAttempts must be int in [1, 20]", () => {
    // B-079 residue. Each of the three rejections is a DIFFERENT rule — below the floor, above the
    // ceiling, not an integer — and `toThrow(z.ZodError)` reported all three identically.
    //
    // A correction to an earlier draft of this comment, which justified the change with mutants
    // that do not in fact survive the previous version. Widening the range to [0, 99] and dropping
    // `.int()` were both cited; measured, each turns the OLD file red too (1 failed), because they
    // stop the input being refused at all and a bare `toThrow` notices an absent throw perfectly
    // well. Claiming them as the gain was prose asserting a protection the measurement does not
    // support — the same defect this batch exists to remove, committed in the repair for it.
    //
    // What an issue-code assertion actually buys is the mutant that KEEPS the rejection and changes
    // only its REASON, which is invisible to any assertion on the class. Measured: `.int(...)`
    // replaced by `.multipleOf(1, ...)` refuses exactly the same inputs — 0 too_small, 21 too_big,
    // 3.5 rejected, 3 accepted — and reports 3.5 as `not_multiple_of` instead of `invalid_type`.
    // Against that mutant the previous version is 8 passed; this one is 1 failed.
    expect(
      zodIssueCodes(caught(() => fn("s", async () => 1, { retry: { maxAttempts: 0 } }))),
    ).toContain("too_small");
    expect(
      zodIssueCodes(caught(() => fn("s", async () => 1, { retry: { maxAttempts: 21 } }))),
    ).toContain("too_big");
    expect(
      zodIssueCodes(caught(() => fn("s", async () => 1, { retry: { maxAttempts: 3.5 } }))),
    ).toContain("invalid_type");
    // § 4.2 — an in-range integer is accepted, so a schema rejecting every value cannot pass.
    expect(() => fn("step1", async () => 1, { retry: { maxAttempts: 3 } })).not.toThrow();
  });

  it("EC-9 — builder.commit() called twice throws", () => {
    const b = Workflow.create({ name: "demo" });
    b.then(fn("step1", async () => 1));
    b.commit();
    // B-079 residue, recorded rather than smoothed: this is the one negative case in the file whose
    // typed error cannot be asserted, because production does not raise one —
    // `src/workflow.ts:224` throws a bare `new Error(...)`. Pinning `toThrow(Error)` would be
    // vacuous (every throw satisfies it), so the message stays the oracle until the SDK gives this
    // guard a typed error. Reported as a finding; fixing it is a `src/` change this batch may not make.
    expect(() => b.commit()).toThrow(/already committed/i);
  });

  it("EC-5 — commit mints a unique workflowId per Workflow instance", async () => {
    const wf1 = Workflow.create({ name: "same-name" })
      .then(fn("a", async () => 1))
      .commit();
    const wf2 = Workflow.create({ name: "same-name" })
      .then(fn("a", async () => 1))
      .commit();
    // Both should be runnable concurrently without single-flight collision.
    const [r1, r2] = await Promise.all([wf1.run(undefined), wf2.run(undefined)]);
    expect(r1.status).toBe("completed");
    expect(r2.status).toBe("completed");
    __resetSnapshotStoresForTests();
  });

  it("throws on duplicate step id at commit time", () => {
    const b = Workflow.create({ name: "demo" })
      .then(fn("step1", async () => 1))
      .then(fn("step1", async () => 2)); // duplicate
    expect(() => b.commit()).toThrow(WorkflowDuplicateStepIdError);
  });

  it("rejects invalid step id grammar (special chars, empty)", () => {
    // B-079. These three reject an IDENTIFIER, not a schema — `ConfigurationError`, not `ZodError`.
    // Three lines above assert the other type; that split is why this batch measured per site.
    expect(() => fn("step.1", async () => 1)).toThrow(ConfigurationError);
    expect(() => fn("step 1", async () => 1)).toThrow(ConfigurationError);
    expect(() => fn("", async () => 1)).toThrow(ConfigurationError);
    // B-079 residue, and the DoD's own words: "plus a `.code` assertion where the SDK owns the
    // error". `ConfigurationError` has three subclasses and is raised from 132 sites in `src/`, so
    // substituting an unrelated one — an `IntegrationNotConnectedError` leaking out of a provider
    // lookup, say — left the three lines above green. `invalid_identifier` is what `sanitizeIdentifier`
    // stamps, and it is the only thing here that says the STEP ID is what was refused.
    for (const badId of ["step.1", "step 1", ""]) {
      const error = caught(() => fn(badId, async () => 1));
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).code).toBe("invalid_identifier");
    }
    // § 4.2 — a valid id is accepted, so a predicate rejecting every id cannot pass this test.
    expect(() => fn("step-ok_123", async () => 1)).not.toThrow();
    // Note: sanitizeIdentifier lowercases uppercase input, so "Step1" → "step1" is accepted.
  });

  it("agentStep helper accepts string + function templates", () => {
    const fakeAgent = {
      agentId: "agent-fake",
      send: async () => ({ wait: async () => ({ status: "finished" as const, result: "ok" }) }),
    } as never;
    expect(() => agentStep("classify", fakeAgent, "static prompt")).not.toThrow();
    expect(() =>
      agentStep("classify2", fakeAgent, (i) => `dynamic ${JSON.stringify(i)}`),
    ).not.toThrow();
  });

  it("supports Zod input/output schemas on fn step", () => {
    const step = fn("validate", async (input: { id: string }) => ({ valid: true, id: input.id }), {
      inputSchema: z.object({ id: z.string() }),
      outputSchema: z.object({ valid: z.boolean(), id: z.string() }),
    });
    expect(step.kind).toBe("fn");
    expect(step.inputSchema).toBeDefined();
    expect(step.outputSchema).toBeDefined();
  });
});
