import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalSandbox } from "../../src/sandbox/local-sandbox.js";

describe("SandboxBackend protocol (LocalSandbox)", () => {
  let sandbox: LocalSandbox;
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    sandbox = new LocalSandbox({ workDir, timeoutMs: 5_000, maxOutputBytes: 1024 });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("execute returns stdout, stderr, exitCode", async () => {
    const result = await sandbox.execute("echo hello");
    expect(result.stdout.trim()).toBe("hello");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("execute returns non-zero exit code on failure", async () => {
    const result = await sandbox.execute("exit 42");
    expect(result.exitCode).not.toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("execute times out on long-running commands", async () => {
    const result = await sandbox.execute("sleep 60", { timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
  });

  it("readFile returns file content", async () => {
    await writeFile(join(workDir, "test.txt"), "hello world");
    const content = await sandbox.readFile(join(workDir, "test.txt"));
    expect(content.trim()).toBe("hello world");
  });

  it("writeFile + readFile roundtrip", async () => {
    const path = join(workDir, "roundtrip.txt");
    await sandbox.writeFile(path, "roundtrip content");
    const content = await sandbox.readFile(path);
    expect(content.trim()).toBe("roundtrip content");
  });

  it("glob matches file patterns", async () => {
    await writeFile(join(workDir, "a.ts"), "");
    await writeFile(join(workDir, "b.ts"), "");
    await writeFile(join(workDir, "c.js"), "");
    const matches = await sandbox.glob("*.ts", workDir);
    expect(matches.length).toBe(2);
    expect(matches.every((m: string) => m.endsWith(".ts"))).toBe(true);
  });

  it("grep finds pattern in file", async () => {
    await writeFile(join(workDir, "search.txt"), "line1\nhello world\nline3");
    const matches = await sandbox.grep("hello", join(workDir, "search.txt"));
    expect(matches.length).toBe(1);
    expect(matches[0]).toContain("hello world");
  });

  it("uploadFile writes content to path", async () => {
    const path = join(workDir, "uploaded.txt");
    await sandbox.uploadFile(path, "uploaded content");
    const content = await sandbox.readFile(path);
    expect(content.trim()).toBe("uploaded content");
  });

  it("truncates output exceeding maxOutputBytes", async () => {
    const result = await sandbox.execute(`python3 -c "print('x' * 2000)"`);
    expect(result.stdout.length).toBeLessThanOrEqual(1024 + 20);
  });

  it("listDir returns directory entries", async () => {
    await writeFile(join(workDir, "file1.txt"), "");
    await writeFile(join(workDir, "file2.txt"), "");
    const entries = await sandbox.listDir(workDir);
    expect(entries).toContain("file1.txt");
    expect(entries).toContain("file2.txt");
  });
});
