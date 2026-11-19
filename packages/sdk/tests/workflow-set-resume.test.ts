import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { ConfigurationError } from "../src/errors.js";
import {
  fn,
  Workflow,
  WorkflowResumeWorkflowMismatchError,
  WorkflowSet,
  WorkflowSnapshotNotFoundError,
} from "../src/workflow.js";
import { removeTempDirRobustSync } from "./helpers/temp-workspace.js";

const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "wfset-"));
  onTestFinished(() => removeTempDirRobustSync(d));
  return d;
};

const make = (name: string, d: string, payloadSchema?: z.ZodType) =>
  Workflow.create<{ a: string }>({
    name,
    persistence: { backend: "json", dir: d },
  })
    .then(fn<{ a: string }, string>("draft", async (input) => input.a))
    .suspend({ id: "approve", ...(payloadSchema ? { payloadSchema } : {}) })
    .commit();

describe("WorkflowSet.resume (#1030)", () => {
  it("resumes on the member that owns the run", async () => {
    const d = dir();
    const first = make("first", d);
    const second = make("second", d);
    const suspended = await second.run({ a: "x" });
    expect(suspended.status).toBe("suspended");
    const set = WorkflowSet.of([first, second]);
    expect(set.names).toEqual(["first", "second"]);
    const { name, run } = await set.resume(suspended.id, { approved: true });
    expect(name).toBe("second");
    expect(run.status).toBe("completed");
  });

  it("skips a member whose store holds another workflow's snapshot, and forwards the signal", async () => {
    const d = dir();
    const first = make("first", d);
    const second = make("second", d);
    const suspended = await second.run({ a: "x" });
    // Alone, `first` reports a mismatch (the snapshot is another workflow's) ...
    const direct = await Workflow.resume({ workflow: first, runId: suspended.id }).catch((e) => e);
    expect(direct).toBeInstanceOf(WorkflowResumeWorkflowMismatchError);
    // ... and the set treats it as "not this one", forwarding the signal to the owner.
    const ac = new AbortController();
    ac.abort();
    const { name, run } = await WorkflowSet.of([first, second]).resume(suspended.id, undefined, {
      signal: ac.signal,
    });
    expect(name).toBe("second");
    expect(run.status).toBe("cancelled");
  });

  it("rejects an unknown run id naming it", async () => {
    const d = dir();
    const set = WorkflowSet.of([make("a", d), make("b", d)]);
    const err = await set.resume("nope-123").catch((e) => e);
    expect(err).toBeInstanceOf(WorkflowSnapshotNotFoundError);
    expect(String(err.message)).toContain("nope-123");
  });

  it("rethrows a payload validation error and does not try later members", async () => {
    const d = dir();
    const first = make("first", d, z.object({ approved: z.boolean() }));
    const second = make("second", d);
    const suspended = await first.run({ a: "x" });
    const err = await WorkflowSet.of([first, second])
      .resume(suspended.id, { approved: "yes" })
      .catch((e) => e);
    expect(err).not.toBeInstanceOf(WorkflowSnapshotNotFoundError);
    expect(err).toBeInstanceOf(Error);
    // Snapshot of the run is still there: a valid payload resumes it.
    const ok = await WorkflowSet.of([second, first]).resume(suspended.id, { approved: true });
    expect(ok.name).toBe("first");
  });

  it("throws ConfigurationError for duplicate names", () => {
    const d = dir();
    expect(() => WorkflowSet.of([make("a", d), make("a", d)])).toThrow(ConfigurationError);
    expect(() => WorkflowSet.of([make("a", d), make("a", d)])).toThrow(/"a"/);
  });
});
