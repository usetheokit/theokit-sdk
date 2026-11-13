import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEditFileTool } from "../src/edit-file.js";
import { textHandler } from "./text-handler.js";

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "sdk-editfile-"));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe("createEditFileTool — tool shape", () => {
  it("Given the factory, Then it returns a CustomTool with name='edit_file'", () => {
    const tool = createEditFileTool({ projectRoot });
    expect(tool.name).toBe("edit_file");
    expect(typeof tool.handler).toBe("function");
  });
});

describe("createEditFileTool — no-op guard (old_string === new_string)", () => {
  it("Given equal old/new strings, When edit_file is invoked, Then it refuses with no_change and does not write", async () => {
    writeFileSync(join(projectRoot, "same.ts"), 'const x = "v";');
    const tool = createEditFileTool({ projectRoot });
    const out = await textHandler(tool)({ path: "same.ts", old_string: '"v"', new_string: '"v"' });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("no_change");
    expect(existsSync(join(projectRoot, "same.ts.bak"))).toBe(false);
  });
});

describe("createEditFileTool — exact match", () => {
  it("Given a file with target string, When edit_file is invoked, Then string is replaced", async () => {
    writeFileSync(join(projectRoot, "code.ts"), 'const x = "old";\nconst y = 1;');
    const tool = createEditFileTool({ projectRoot });
    const out = await textHandler(tool)({
      path: "code.ts",
      old_string: '"old"',
      new_string: '"new"',
    });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.replacements).toBe(1);
    expect(readFileSync(join(projectRoot, "code.ts"), "utf-8")).toBe(
      'const x = "new";\nconst y = 1;',
    );
  });

  it("Given a file, When edit_file succeeds, Then .bak backup is created", async () => {
    writeFileSync(join(projectRoot, "backup.ts"), "original");
    const tool = createEditFileTool({ projectRoot });
    await textHandler(tool)({ path: "backup.ts", old_string: "original", new_string: "changed" });
    expect(existsSync(join(projectRoot, "backup.ts.bak"))).toBe(true);
    expect(readFileSync(join(projectRoot, "backup.ts.bak"), "utf-8")).toBe("original");
  });
});

describe("createEditFileTool — whitespace-normalized match", () => {
  it("Given extra whitespace in file, When exact match fails, Then normalized match succeeds", async () => {
    writeFileSync(join(projectRoot, "ws.ts"), "const  x  =  1;");
    const tool = createEditFileTool({ projectRoot });
    const out = await textHandler(tool)({
      path: "ws.ts",
      old_string: "const x = 1;",
      new_string: "const x = 2;",
    });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.replacements).toBe(1);
  });
});

describe("createEditFileTool — error scenarios", () => {
  it("Given no match found, Then result is { ok: false, error: 'no_match' }", async () => {
    writeFileSync(join(projectRoot, "nomatch.ts"), "hello world");
    const tool = createEditFileTool({ projectRoot });
    const out = await textHandler(tool)({
      path: "nomatch.ts",
      old_string: "xyz",
      new_string: "abc",
    });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("no_match");
  });

  it("Given missing file, Then result is { ok: false, error: 'not_found' }", async () => {
    const tool = createEditFileTool({ projectRoot });
    const out = await textHandler(tool)({ path: "missing.ts", old_string: "x", new_string: "y" });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("not_found");
  });

  it("Given path traversal attempt, Then result is { ok: false, error: 'path_traversal' }", async () => {
    const tool = createEditFileTool({ projectRoot });
    const out = await textHandler(tool)({
      path: "../../etc/passwd",
      old_string: "x",
      new_string: "y",
    });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("path_traversal");
  });

  it("Given a forbidden path (.env), Then result is { ok: false, error: 'forbidden_path' }", async () => {
    const tool = createEditFileTool({ projectRoot });
    const out = await textHandler(tool)({ path: ".env", old_string: "x", new_string: "y" });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("forbidden_path");
  });
});

describe("createEditFileTool — Strategy 3 context-tolerant ladder (M13)", () => {
  it("Given ASCII old_string vs typographic source (curly quotes/en-dash), Then the unicode rung matches where exact + whitespace-collapse both fail", async () => {
    // Source uses a curly apostrophe + en-dash; the model authored old_string in ASCII.
    // Strategy 1 (exact) fails; Strategy 2 (whitespace-collapse) fails (it does not touch quotes/dashes);
    // Strategy 3's unicode-normalize rung matches.
    writeFileSync(join(projectRoot, "u.ts"), "const label = ‘hi’ – done;\n");
    const tool = createEditFileTool({ projectRoot });
    const out = await textHandler(tool)({
      path: "u.ts",
      old_string: "const label = 'hi' - done;",
      new_string: "const label = 'bye';",
    });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.replacements).toBe(1);
    expect(readFileSync(join(projectRoot, "u.ts"), "utf-8")).toContain("const label = 'bye';");
  });
});

describe("createEditFileTool — baseDir (#1060)", () => {
  it("resolves relative paths against baseDir, honours absolute ones, refuses .env", async () => {
    mkdirSync(join(projectRoot, "proj"));
    writeFileSync(join(projectRoot, "proj", "hello.txt"), "one");
    writeFileSync(join(projectRoot, "other.txt"), "two");
    const h = textHandler(createEditFileTool({ projectRoot, baseDir: join(projectRoot, "proj") }));
    expect(JSON.parse(await h({ path: "hello.txt", old_string: "one", new_string: "1" })).ok).toBe(
      true,
    );
    expect(readFileSync(join(projectRoot, "proj", "hello.txt"), "utf-8")).toBe("1");
    await h({ path: join(projectRoot, "other.txt"), old_string: "two", new_string: "2" });
    expect(readFileSync(join(projectRoot, "other.txt"), "utf-8")).toBe("2");
    expect(JSON.parse(await h({ path: ".env", old_string: "a", new_string: "b" })).error).toBe(
      "forbidden_path",
    );
  });

  it("throws at construction when baseDir is outside projectRoot, naming both", () => {
    const outside = join(tmpdir(), "elsewhere");
    expect(() => createEditFileTool({ projectRoot, baseDir: outside })).toThrow(
      new RegExp(`${outside}[\\s\\S]*${projectRoot}`),
    );
  });
});
