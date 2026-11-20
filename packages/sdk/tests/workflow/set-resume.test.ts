import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { ConfigurationError } from "../../src/errors.js";
import {
  fn,
  Workflow,
  WorkflowResumeWorkflowMismatchError,
  WorkflowSet,
  WorkflowSnapshotNotFoundError,
} from "../../src/workflow.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "wfset-"));
  dirs.push(d);
  return d;
};

const build = (name: string, dir: string, payloadSchema?: z.ZodType) =>
  Workflow.create<{ a: string }>({ name, persistence: { backend: "json", dir } })
    .then(fn<{ a: string }, string>("draft", async (i) => i.a))
    .suspend({ id: "approve", ...(payloadSchema ? { payloadSchema } : {}) })
    .commit();

describe("WorkflowSet.resume (#1030)", () => {
  it("resumes a run on the second member of a shared store and names it", async () => {
    const dir = tmp();
    const first = build("first", dir);
    const second = build("second", dir);
    const suspended = await second.run({ a: "x" });
    expect(suspended.status).toBe("suspended");
    const set = WorkflowSet.of([first, second]);
    expect(set.names).toEqual(["first", "second"]);
    const { name, run } = await set.resume(suspended.id, { approved: true });
    expect(name).toBe("second");
    expect(run.status).toBe("completed");
  });

  it("rejects an unknown run id with WorkflowSnapshotNotFoundError naming it", async () => {
    const dir = tmp();
    const set = WorkflowSet.of([build("first", dir), build("second", dir)]);
    const err = await set.resume("nope").catch((e) => e);
    expect(err).toBeInstanceOf(WorkflowSnapshotNotFoundError);
    expect(err.runId).toBe("nope");
    expect(err.message).toContain("nope");
  });

  it("rethrows a payload validation error without trying later members", async () => {
    const dir = tmp();
    const schema = z.object({ approved: z.boolean() });
    const first = build("first", dir, schema);
    const second = build("second", dir, schema);
    const third = build("third", dir, schema);
    const touched: Array<string | symbol> = [];
    const spyThird = new Proxy(third, {
      get(target, prop, receiver) {
        if (prop !== "__options" && prop !== "_options") touched.push(prop);
        return Reflect.get(target, prop, receiver);
      },
    });
    const suspended = await second.run({ a: "x" });
    const set = WorkflowSet.of([first, second, spyThird]);
    const parsed = schema.safeParse({ approved: "yes" });
    expect(parsed.success).toBe(false);
    const err = await set.resume(suspended.id, { approved: "yes" }).catch((e) => e);
    expect(err).not.toBeInstanceOf(WorkflowSnapshotNotFoundError);
    expect(err).not.toBeInstanceOf(WorkflowResumeWorkflowMismatchError);
    expect(err.message).toMatch(/approved/);
    expect(touched).toEqual([]);
  });

  it("throws ConfigurationError naming a duplicated workflow name", () => {
    const dir = tmp();
    expect(() => WorkflowSet.of([build("a", dir), build("a", dir)])).toThrow(ConfigurationError);
    expect(() => WorkflowSet.of([build("a", dir), build("a", dir)])).toThrow(/"a"/);
  });
});
