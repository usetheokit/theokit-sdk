import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { __resetSnapshotStoresForTests } from "../../src/internal/workflow/snapshot-store.js";
import { loadWorkflowDir, Workflow, WorkflowDefinitionError } from "../../src/workflow.js";
import { WorkflowDefinitionSchema } from "../../src/workflow-definition.js";
import { removeTempDirRobust } from "../helpers/temp-workspace.js";

const def = {
  name: "release",
  steps: [
    { id: "draft", prompt: "Draft notes" },
    { id: "ok", approve: true as const },
  ],
};

describe("Workflow.fromDefinition", () => {
  it("runs to the approval, suspends, and finishes after resume", async () => {
    __resetSnapshotStoresForTests();
    const calls: Array<[string, unknown]> = [];
    const workflow = Workflow.fromDefinition(def, {
      generate: (prompt, input) => {
        calls.push([prompt, input]);
        return "notes";
      },
      persistence: { backend: "memory" },
    });
    const first = await workflow.run("start");
    expect(first.status).toBe("suspended");
    expect(calls).toEqual([["Draft notes", "start"]]);
    const done = await Workflow.resume({ workflow, runId: first.id });
    expect(done.status).toBe("completed");
    expect(done.output).toBe("notes");
  });

  it("rejects a duplicate step id naming the field", () => {
    const bad = { name: "x", steps: [def.steps[0], { id: "draft", approve: true as const }] };
    expect(() => Workflow.fromDefinition(bad as never, { generate: () => "" })).toThrow(
      /steps\.1\.id/,
    );
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wfdef-"));
  onTestFinished(() => removeTempDirRobust(dir));
  return dir;
}

describe("loadWorkflowDir", () => {
  it("loads json files in filename order", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "b.json"), JSON.stringify({ ...def, name: "b" }));
    await writeFile(join(dir, "a.json"), JSON.stringify({ ...def, name: "a" }));
    await writeFile(join(dir, "note.txt"), "ignored");
    const list = await loadWorkflowDir(dir, { generate: () => "" });
    expect(list.map((w) => w.__options.name)).toEqual(["a", "b"]);
  });

  it("orders filenames alphabetically, not by UTF-16 code unit", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "B.json"), JSON.stringify({ ...def, name: "upper" }));
    await writeFile(join(dir, "a.json"), JSON.stringify({ ...def, name: "lower" }));
    const list = await loadWorkflowDir(dir, { generate: () => "" });
    expect(list.map((w) => w.__options.name)).toEqual(["lower", "upper"]);
  });

  it("names the file and field of an invalid definition", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, "bad.json"),
      JSON.stringify({ name: "bad", steps: [{ id: "Bad Id", prompt: "p" }] }),
    );
    const err = await loadWorkflowDir(dir, { generate: () => "" }).catch((e) => e);
    expect(err).toBeInstanceOf(WorkflowDefinitionError);
    expect(err.file).toBe("bad.json");
    expect(err.field).toBe("steps.0.id");
    expect(err.message).toContain("bad.json");
    expect(err.message).toContain("steps.0.id");
  });

  it("names the file for malformed JSON", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "broken.json"), "{");
    await expect(loadWorkflowDir(dir, { generate: () => "" })).rejects.toThrow(/broken\.json/);
  });
});

describe("description", () => {
  it("is accepted by the schema and kept by describe()", async () => {
    const input = { name: "x", description: "d", steps: [{ id: "a", prompt: "p" }] };
    expect(WorkflowDefinitionSchema.safeParse(input).success).toBe(true);
    expect(WorkflowDefinitionSchema.safeParse({ ...input, description: "" }).success).toBe(false);
    expect(Workflow.fromDefinition(input, { generate: () => "" }).describe().description).toBe("d");
    const dir = await tempDir();
    await writeFile(join(dir, "x.json"), JSON.stringify(input));
    const [wf] = await loadWorkflowDir(dir, { generate: () => "" });
    expect(wf?.describe().description).toBe("d");
  });
});

describe("approval decision", () => {
  const approvalDef = {
    name: "gate",
    steps: [
      { id: "draft", prompt: "Draft" },
      { id: "ok", approve: true as const, decision: "approved" as const },
      { id: "send", prompt: "Send" },
    ],
  };
  async function suspended() {
    __resetSnapshotStoresForTests();
    const calls: string[] = [];
    const workflow = Workflow.fromDefinition(approvalDef, {
      generate: (prompt) => {
        calls.push(prompt);
        return `out:${prompt}`;
      },
      persistence: { backend: "memory" },
    });
    const run = await workflow.run("in");
    expect(run.status).toBe("suspended");
    return { workflow, runId: run.id, calls };
  }

  it("completes with the held value and skips later steps when refused", async () => {
    const { workflow, runId, calls } = await suspended();
    const done = await Workflow.resume({ workflow, runId, payload: { approved: false } });
    expect(done.status).toBe("completed");
    expect(done.output).toBe("out:Draft");
    expect(calls).toEqual(["Draft"]);
  });

  it("continues with the held value when approved", async () => {
    const { workflow, runId, calls } = await suspended();
    const done = await Workflow.resume({ workflow, runId, payload: { approved: true } });
    expect(done.status).toBe("completed");
    expect(done.output).toBe("out:Send");
    expect(calls).toEqual(["Draft", "Send"]);
  });

  it("rejects a payload that is not { approved: boolean }", async () => {
    const { workflow, runId } = await suspended();
    await expect(Workflow.resume({ workflow, runId, payload: "yes" })).rejects.toThrow();
  });
});

describe("loadWorkflowDir onInvalid", () => {
  it("skips and reports an invalid file", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "a.json"), JSON.stringify(def));
    await writeFile(join(dir, "b.json"), "{");
    const seen: Array<[string, WorkflowDefinitionError]> = [];
    const list = await loadWorkflowDir(dir, {
      generate: () => "",
      onInvalid: (file, error) => seen.push([file, error]),
    });
    expect(list).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]).toBe("b.json");
    expect(seen[0]?.[1]).toBeInstanceOf(WorkflowDefinitionError);
  });
});
