import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { __resetSnapshotStoresForTests } from "../../src/internal/workflow/snapshot-store.js";
import { loadWorkflowDir, Workflow, WorkflowDefinitionError } from "../../src/workflow.js";
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
