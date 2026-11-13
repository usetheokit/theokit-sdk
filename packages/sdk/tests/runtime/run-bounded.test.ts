import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../../src/errors.js";
import { runBounded } from "../../src/internal/runtime/lifecycle/run-bounded.js";
import { runShell } from "../../src/internal/runtime/tools/shell-tool.js";
import { pollUntil } from "../helpers/poll-until.js";

const posix = process.platform !== "win32";

function sleepers(marker: string): string {
  try {
    return execSync(`ps -eo args | grep '[${marker[0]}]${marker.slice(1)}' || true`)
      .toString()
      .trim();
  } catch {
    return "";
  }
}

describe.skipIf(!posix)("runBounded — process tree", () => {
  it("kills the whole group on timeout", async () => {
    const r = await runBounded({
      command: "sh",
      args: ["-c", "sleep 601 | cat"],
      cwd: process.cwd(),
      timeoutMs: 200,
    });
    expect(r.timedOut).toBe(true);
    await pollUntil(() => sleepers("sleep 601") === "");
    expect(sleepers("sleep 601")).toBe("");
  });

  it("the shell tool leaves no child after its timeout", async () => {
    const r = await runShell({ command: "sleep 602 | cat", cwd: process.cwd(), timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    await pollUntil(() => sleepers("sleep 602") === "");
    expect(sleepers("sleep 602")).toBe("");
  });

  it("abort kills the group and is not a timeout", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const r = await runBounded({
      command: "sh",
      args: ["-c", "sleep 603 | cat"],
      cwd: process.cwd(),
      timeoutMs: 30_000,
      signal: ac.signal,
    });
    expect(r.timedOut).toBe(false);
    expect(r.exitCode === null || r.exitCode !== 0).toBe(true);
    await pollUntil(() => sleepers("sleep 603") === "");
    expect(sleepers("sleep 603")).toBe("");
  });
});

describe("runBounded — output cap and validation", () => {
  it("caps stdout and flags truncation", async () => {
    const max = 1024 * 1024;
    const r = await runBounded({
      command: process.execPath,
      args: ["-e", "process.stdout.write('a'.repeat(6*1024*1024))"],
      cwd: process.cwd(),
      timeoutMs: 20_000,
      maxOutputBytes: max,
    });
    expect(r.stdout.length).toBeLessThanOrEqual(max);
    expect(r.truncated.stdout).toBe(true);
    expect(r.truncated.stderr).toBe(false);
    expect(r.exitCode).toBe(0);
  });

  it("applies a 5 MiB default cap", async () => {
    const r = await runBounded({
      command: process.execPath,
      args: ["-e", "process.stdout.write('a'.repeat(6*1024*1024))"],
      cwd: process.cwd(),
      timeoutMs: 20_000,
    });
    expect(r.stdout.length).toBeLessThanOrEqual(5 * 1024 * 1024);
    expect(r.truncated.stdout).toBe(true);
  });

  it("throws ConfigurationError for a non-positive timeout", () => {
    expect(() => runBounded({ command: "sh", cwd: process.cwd(), timeoutMs: 0 })).toThrow(
      ConfigurationError,
    );
  });
});
