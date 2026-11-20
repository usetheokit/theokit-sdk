import { describe, expect, it } from "vitest";

import { LocalSandbox } from "../../src/sandbox/local-sandbox.js";
import { SandboxBackend } from "../../src/sandbox/types.js";

describe("executeStreaming", () => {
  it("delivers lines live, in order, with CRLF, empty and final partial lines", async () => {
    const sb = new LocalSandbox({});
    const lines: string[] = [];
    const r = await sb.executeStreaming?.("printf 'a\\r\\n\\nb\\nlast'", {
      onStdoutLine: (l) => lines.push(l),
    });
    expect(lines).toEqual(["a", "", "b", "last"]);
    expect(r).toMatchObject({ exitCode: 0, timedOut: false, stdout: "a\r\n\nb\nlast" });
  });

  it("calls back before the command exits", async () => {
    const sb = new LocalSandbox({});
    let early = false;
    let done = false;
    const p = sb.executeStreaming?.("echo one; sleep 0.5; echo two", {
      onStdoutLine: (l) => {
        if (l === "one") early = !done;
      },
    });
    await p;
    done = true;
    expect(early).toBe(true);
  });

  it("keeps multibyte characters whole and reports failure and stderr", async () => {
    const sb = new LocalSandbox({});
    const lines: string[] = [];
    const r = await sb.executeStreaming?.("printf 'naïve\\n'; echo bad >&2; exit 3", {
      onStdoutLine: (l) => lines.push(l),
    });
    expect(lines).toEqual(["naïve"]);
    expect(r).toMatchObject({ exitCode: 1, stderr: "bad\n" });
  });

  it("stops the command when the signal aborts, also when already aborted", async () => {
    const sb = new LocalSandbox({});
    const ac = new AbortController();
    const started = Date.now();
    const p = sb.executeStreaming?.("echo go; sleep 30", {
      signal: ac.signal,
      onStdoutLine: () => ac.abort(),
    });
    const r = await p;
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r).toMatchObject({ exitCode: 1, timedOut: false, stdout: "go\n" });
    const r2 = await sb.executeStreaming?.("sleep 30", { signal: ac.signal });
    expect(r2).toMatchObject({ exitCode: 1, timedOut: false });
  });

  it("times out with 124 and keeps partial output", async () => {
    const sb = new LocalSandbox({});
    const r = await sb.executeStreaming?.("echo x; sleep 30", { timeoutMs: 300 });
    expect(r).toMatchObject({ exitCode: 124, timedOut: true, stdout: "x\n" });
  });

  it("marks output beyond maxOutputBytes as truncated", async () => {
    const sb = new LocalSandbox({ maxOutputBytes: 100 });
    const r = await sb.executeStreaming?.("yes | head -c 100000");
    expect(r?.exitCode).toBe(1);
    expect(r?.stdout.endsWith("...(truncated)")).toBe(true);
  });

  it("rejects and stops the command when the callback throws", async () => {
    const sb = new LocalSandbox({});
    await expect(
      sb.executeStreaming?.("echo a; sleep 30", {
        onStdoutLine: () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");
  });

  it("is absent on a backend that does not stream", () => {
    class Plain extends SandboxBackend {
      async execute() {
        return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
      }
      async uploadFile() {}
    }
    expect(new Plain().executeStreaming).toBeUndefined();
  });
});
