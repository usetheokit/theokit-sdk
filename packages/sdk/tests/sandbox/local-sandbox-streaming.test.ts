import { describe, expect, it } from "vitest";

import { LocalSandbox } from "../../src/sandbox/local-sandbox.js";

describe("LocalSandbox.executeStreaming", () => {
  it("delivers lines live and in order, and returns the full result", async () => {
    const sb = new LocalSandbox({});
    const lines: string[] = [];
    const stamps: number[] = [];
    const r = await sb.executeStreaming?.("echo a; sleep 0.4; printf 'b\\n\\nc'; echo err >&2", {
      onStdoutLine: (l) => {
        lines.push(l);
        stamps.push(Date.now());
      },
    });
    expect(lines).toEqual(["a", "b", "", "c"]);
    expect(stamps[1] - stamps[0]).toBeGreaterThanOrEqual(300);
    expect(r).toMatchObject({ stdout: "a\nb\n\nc", stderr: "err\n", exitCode: 0, timedOut: false });
  });

  it("reports a failing exit and a timeout", async () => {
    const sb = new LocalSandbox({});
    expect((await sb.executeStreaming?.("exit 3"))?.exitCode).toBe(1);
    const t = await sb.executeStreaming?.("echo x; sleep 5", { timeoutMs: 200 });
    expect(t).toMatchObject({ timedOut: true, exitCode: 124, stdout: "x\n" });
  });

  it("stops the command when the signal aborts", async () => {
    const sb = new LocalSandbox({});
    const ac = new AbortController();
    const started = Date.now();
    const r = await sb.executeStreaming?.("echo go; sleep 10", {
      signal: ac.signal,
      onStdoutLine: () => ac.abort(),
    });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r).toMatchObject({ stdout: "go\n", exitCode: 1, timedOut: false });
    const pre = await sb.executeStreaming?.("echo no", { signal: ac.signal });
    expect(pre?.stdout).toBe("");
  });

  it("kills the command when output exceeds maxOutputBytes", async () => {
    const sb = new LocalSandbox({ maxOutputBytes: 100 });
    const r = await sb.executeStreaming?.("yes");
    expect(r?.exitCode).toBe(1);
    expect(r?.stdout).toContain("...(truncated)");
  });
});
