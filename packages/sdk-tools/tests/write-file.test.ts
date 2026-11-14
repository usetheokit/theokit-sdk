import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createWriteFileTool } from "../src/write-file.js";
import { textHandler } from "./text-handler.js";

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "sdk-writefile-"));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe("createWriteFileTool — tool shape", () => {
  it("Given the factory, Then it returns a CustomTool with name='write_file'", () => {
    const tool = createWriteFileTool({ projectRoot });
    expect(tool.name).toBe("write_file");
    expect(typeof tool.handler).toBe("function");
  });
});

describe("createWriteFileTool — happy path", () => {
  it("Given content and path, When write_file is invoked, Then file is created", async () => {
    const tool = createWriteFileTool({ projectRoot });
    const out = await textHandler(tool)({ path: "hello.txt", content: "hello world" });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.bytes).toBe(11);
    expect(readFileSync(join(projectRoot, "hello.txt"), "utf-8")).toBe("hello world");
  });

  it("Given a nested path, When write_file is invoked, Then parent dirs are created", async () => {
    const tool = createWriteFileTool({ projectRoot });
    await textHandler(tool)({ path: "deep/nested/file.ts", content: "export {}" });
    expect(existsSync(join(projectRoot, "deep/nested/file.ts"))).toBe(true);
  });

  it("Given an existing text file, When write_file is invoked, Then file is overwritten", async () => {
    writeFileSync(join(projectRoot, "existing.txt"), "old content");
    const tool = createWriteFileTool({ projectRoot });
    await textHandler(tool)({ path: "existing.txt", content: "new content" });
    expect(readFileSync(join(projectRoot, "existing.txt"), "utf-8")).toBe("new content");
  });
});

describe("createWriteFileTool — safety boundaries", () => {
  it("Given path traversal attempt, Then result is { ok: false, error: 'path_traversal' }", async () => {
    const tool = createWriteFileTool({ projectRoot });
    const out = await textHandler(tool)({ path: "../../etc/evil", content: "hacked" });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("path_traversal");
  });

  it("Given a forbidden path (.env), Then result is { ok: false, error: 'forbidden_path' }", async () => {
    const tool = createWriteFileTool({ projectRoot });
    const out = await textHandler(tool)({ path: ".env", content: "SECRET=x" });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("forbidden_path");
  });

  it("Given a binary file exists, When overwriting, Then result is { ok: false, error: 'binary_file' }", async () => {
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    writeFileSync(join(projectRoot, "logo.png"), binary);
    const tool = createWriteFileTool({ projectRoot });
    const out = await textHandler(tool)({ path: "logo.png", content: "not a png" });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("binary_file");
  });

  it("Given .git/config path, Then result is { ok: false, error: 'forbidden_path' }", async () => {
    const tool = createWriteFileTool({ projectRoot });
    const out = await textHandler(tool)({ path: ".git/config", content: "evil" });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("forbidden_path");
  });
});

describe("createWriteFileTool — baseDir (#1060)", () => {
  it("resolves relative paths against baseDir, honours absolute ones, refuses .env", async () => {
    mkdirSync(join(projectRoot, "proj"));
    const tool = createWriteFileTool({ projectRoot, baseDir: join(projectRoot, "proj") });
    const h = textHandler(tool);
    expect(JSON.parse(await h({ path: "hello.txt", content: "a" })).ok).toBe(true);
    expect(readFileSync(join(projectRoot, "proj", "hello.txt"), "utf-8")).toBe("a");
    await h({ path: join(projectRoot, "other.txt"), content: "b" });
    expect(readFileSync(join(projectRoot, "other.txt"), "utf-8")).toBe("b");
    expect(JSON.parse(await h({ path: ".env", content: "x" })).error).toBe("forbidden_path");
  });

  it("throws at construction when baseDir is outside projectRoot, naming both", () => {
    const outside = join(tmpdir(), "elsewhere");
    expect(() => createWriteFileTool({ projectRoot, baseDir: outside })).toThrow(
      new RegExp(`${outside}[\\s\\S]*${projectRoot}`),
    );
  });
});
