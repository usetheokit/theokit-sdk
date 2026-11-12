import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../src/errors.js";
import { runShell } from "../src/internal/runtime/tools/shell-tool.js";
import { runBounded } from "../src/process.js";

const posix = process.platform !== "win32";
const alive = (tag: string): string => {
  try {
    return execSync(`ps -eo args | grep '[${tag[0]}]${tag.slice(1)}'`)
      .toString()
      .trim();
  } catch {
    return "";
  }
};

describe.skipIf(!posix)("runBounded", () => {
  it("kills the whole group on timeout", async () => {
    const r = await runBounded({
      command: "sh",
      args: ["-c", "sleep 601 | cat"],
      cwd: process.cwd(),
      timeoutMs: 200,
    });
    expect(r.timedOut).toBe(true);
    await new Promise((res) => setTimeout(res, 300));
    expect(alive("sleep 601")).toBe("");
  });

  it("shell tool timeout leaves no child", async () => {
    const r = await runShell({ command: "sleep 602 | cat", cwd: process.cwd(), timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    await new Promise((res) => setTimeout(res, 300));
    expect(alive("sleep 602")).toBe("");
  });

  it("caps output", async () => {
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

  it("abort kills the group", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const r = await runBounded({
      command: "sh",
      args: ["-c", "sleep 603 | cat"],
      cwd: process.cwd(),
      timeoutMs: 20_000,
      signal: ac.signal,
    });
    expect(r.timedOut).toBe(false);
    expect(r.exitCode === null || r.exitCode !== 0).toBe(true);
    await new Promise((res) => setTimeout(res, 300));
    expect(alive("sleep 603")).toBe("");
  });
});

describe("runBounded config", () => {
  it("rejects non-positive timeout", () => {
    expect(() => runBounded({ command: "true", cwd: process.cwd(), timeoutMs: 0 })).toThrow(
      ConfigurationError,
    );
  });
});
