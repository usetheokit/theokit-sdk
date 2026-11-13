import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../../src/errors.js";
import { runShell } from "../../src/internal/runtime/tools/shell-tool.js";
import { runBounded } from "../../src/process.js";

const posix = process.platform !== "win32";

function survivors(marker: string): string {
  try {
    return execSync(`ps -eo args | grep '[${marker[0]}]${marker.slice(1)}'`).toString();
  } catch {
    return "";
  }
}

describe.skipIf(!posix)("runBounded", () => {
  it("kills the whole process tree on timeout", async () => {
    const r = await runBounded({
      command: "sh",
      args: ["-c", "sleep 600 | cat"],
      cwd: process.cwd(),
      timeoutMs: 200,
    });
    expect(r.timedOut).toBe(true);
    await new Promise((res) => setTimeout(res, 300));
    expect(survivors("sleep 600")).toBe("");
  });

  it("runShell timeout leaves no sleep 601", async () => {
    const r = await runShell({ command: "sleep 601 | cat", cwd: process.cwd(), timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    await new Promise((res) => setTimeout(res, 300));
    expect(survivors("sleep 601")).toBe("");
  });

  it("caps output and flags truncation", async () => {
    const max = 1024 * 1024;
    const r = await runBounded({
      command: "sh",
      args: ["-c", "head -c 6291456 /dev/zero | tr '\\0' a"],
      cwd: process.cwd(),
      timeoutMs: 20_000,
      maxOutputBytes: max,
    });
    expect(r.stdout.length).toBeLessThanOrEqual(max);
    expect(r.truncated.stdout).toBe(true);
    expect(r.truncated.stderr).toBe(false);
  });

  it("abort kills the group without timedOut", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const r = await runBounded({
      command: "sh",
      args: ["-c", "sleep 602 | cat"],
      cwd: process.cwd(),
      timeoutMs: 20_000,
      signal: ac.signal,
    });
    expect(r.timedOut).toBe(false);
    expect(r.exitCode === null || r.exitCode !== 0).toBe(true);
    await new Promise((res) => setTimeout(res, 300));
    expect(survivors("sleep 602")).toBe("");
  });
});

describe("runBounded config", () => {
  it("throws ConfigurationError for timeoutMs <= 0", async () => {
    await expect(
      runBounded({ command: "sh", cwd: process.cwd(), timeoutMs: 0 }),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });
});
