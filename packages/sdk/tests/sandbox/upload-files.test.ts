import { describe, expect, it } from "vitest";
import { type ExecuteResult, SandboxBackend } from "../../src/sandbox/types.js";

class Fake extends SandboxBackend {
  calls: string[] = [];
  failOn?: string;
  async execute(): Promise<ExecuteResult> {
    return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
  }
  async uploadFile(path: string, content: string | Buffer): Promise<void> {
    if (path === this.failOn) throw new Error("boom");
    this.calls.push(`${path}:${content.toString()}`);
  }
}

describe("SandboxBackend.uploadFiles", () => {
  it("does nothing for an empty batch", async () => {
    const b = new Fake({});
    await b.uploadFiles([]);
    expect(b.calls).toEqual([]);
  });

  it("uploads string and Buffer content in order", async () => {
    const b = new Fake({});
    await b.uploadFiles([
      { path: "/a", content: "1" },
      { path: "/b", content: Buffer.from("2") },
    ]);
    expect(b.calls).toEqual(["/a:1", "/b:2"]);
  });

  it("propagates the error and stops", async () => {
    const b = new Fake({});
    b.failOn = "/b";
    await expect(
      b.uploadFiles([
        { path: "/a", content: "1" },
        { path: "/b", content: "2" },
        { path: "/c", content: "3" },
      ]),
    ).rejects.toThrow("boom");
    expect(b.calls).toEqual(["/a:1"]);
  });

  it("lets a subclass override with one batch", async () => {
    let batches = 0;
    class Batch extends Fake {
      override async uploadFiles(files: { path: string; content: string | Buffer }[]) {
        batches++;
        expect(files).toHaveLength(2);
      }
    }
    const b = new Batch({});
    await b.uploadFiles([
      { path: "/a", content: "1" },
      { path: "/b", content: "2" },
    ]);
    expect(batches).toBe(1);
    expect(b.calls).toEqual([]);
  });
});
