import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../../src/errors.js";
import { runBounded } from "../../src/process.js";
import { runShell } from "../../src/internal/runtime/tools/shell-tool.js";

const posix = process.platform !== "win32";
const cwd = tmpdir();

function running(marker: string): string {
  try {
    return execSync(`ps -eo args | grep '[s]leep ${marker}'`).toString();
  } catch {
    return "";
  }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!posix)("runBounded", () => {
  it("kills the whole process tree on timeout", async () => {
    const r = await runBounded({ command: "sh", args: ["-c", "sleep 600 | cat"], timeoutMs: 200, cwd });
    expect(r.timedOut).toBe(true);
    await wait(300);
    expect(running("600")).toBe("");
  });

  it("runShell timeout leaves no sleep 601", async () => {
    const r = await runShell({ command: "sleep 601 | cat", cwd, timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    await wait(300);
    expect(running("601")).toBe("");
  });

  it("caps stdout and flags truncation", async () => {
    const max = 1024 * 1024;
    const r = await runBounded({
      command: "sh",
      args: ["-c", "head -c 6291456 /dev/zero | tr '\\0' a"],
      timeoutMs: 20_000,
      maxOutputBytes: max,
      cwd,
    });
    expect(r.stdout.length).toBeLessThanOrEqual(max);
    expect(r.truncated.stdout).toBe(true);
    expect(r.truncated.stderr).toBe(false);
  });

  it("abort kills the group, timedOut false", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const r = await runBounded({
      command: "sh",
      args: ["-c", "sleep 602 | cat"],
      timeoutMs: 20_000,
      signal: ac.signal,
      cwd,
    });
    expect(r.timedOut).toBe(false);
    expect(r.exitCode === null || r.exitCode !== 0).toBe(true);
    await wait(300);
    expect(running("602")).toBe("");
  });
});

describe("runBounded validation", () => {
  it("throws ConfigurationError for timeoutMs <= 0", () => {
    expect(() => runBounded({ command: "true", timeoutMs: 0, cwd })).toThrow(ConfigurationError);
  });
});
