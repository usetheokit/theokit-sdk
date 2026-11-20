import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { InteractiveBackend, StartInteractiveOptions } from "@theokit/sdk/interactive";
import { describe, expect, it } from "vitest";

import { createConfinedPtyBackend, probeConfinement } from "../src/confined-pty-backend.js";

interface Call {
  command: string;
  opts?: StartInteractiveOptions;
}

function fakeInner(onStart?: (command: string) => void) {
  const calls: Call[] = [];
  const killed: string[] = [];
  let config: { maxSessions: number } | undefined;
  const createInner = (c: { maxSessions: number }): InteractiveBackend => {
    config = c;
    return {
      startInteractive: async (command, opts) => {
        calls.push({ command, opts });
        onStart?.(command);
        return { sessionId: "s1", output: "" };
      },
      writeStdin: async () => ({ output: "", alive: true }),
      kill: (id) => {
        killed.push(id);
      },
    };
  };
  return { calls, killed, createInner, config: () => config };
}

const make = (f: ReturnType<typeof fakeInner>, extra = {}) =>
  createConfinedPtyBackend({
    root: "/srv/root",
    mode: "danger-full-access",
    sourceEnv: { PATH: "/bin", SECRET_TOKEN: "x" },
    createInner: f.createInner,
    ...extra,
  });

describe("createConfinedPtyBackend", () => {
  it("forces cwd to the root", async () => {
    const f = fakeInner();
    await make(f).startInteractive("ls", { cwd: "/etc", yieldMs: 300 });
    expect(f.calls[0]?.opts?.cwd).toBe("/srv/root");
    expect(f.calls[0]?.opts?.yieldMs).toBe(300);
  });

  it("keeps allowlisted env, sets HOME, drops secrets", async () => {
    const f = fakeInner();
    await make(f).startInteractive("ls");
    const cmd = f.calls[0]?.command ?? "";
    expect(cmd).toContain("PATH='/bin'");
    expect(cmd).toContain("HOME='/srv/root'");
    expect(cmd).not.toContain("SECRET_TOKEN");
    expect(cmd.startsWith("/usr/bin/env -i ")).toBe(true);
  });

  it("quotes a command with a single quote so the shell receives it unchanged", async () => {
    const f = fakeInner();
    const command = "echo 'a b' \"$HOME\"";
    await make(f).startInteractive(command);
    const sent = f.calls[0]?.command ?? "";
    const out = spawnSync("/bin/sh", ["-c", `printf %s ${sent.split(" /bin/sh -c ")[1]}`]);
    expect(out.stdout.toString()).toBe(command);
  });

  it("defaults maxSessions to 4 and honours an override", () => {
    const a = fakeInner();
    make(a);
    expect(a.config()?.maxSessions).toBe(4);
    const b = fakeInner();
    make(b, { maxSessions: 2 });
    expect(b.config()?.maxSessions).toBe(2);
  });
});

describe("probeConfinement", () => {
  const paths = () => {
    const dir = mkdtempSync(join(tmpdir(), "probe-"));
    return { dir, inside: join(dir, "in"), outside: join(dir, "out") };
  };
  const backend = (start: () => Promise<{ sessionId: string; output: string }>) => {
    const killed: string[] = [];
    const b: InteractiveBackend = {
      startInteractive: start,
      writeStdin: async () => ({ output: "", alive: false }),
      kill: (id) => {
        killed.push(id);
      },
    };
    return { b, killed };
  };

  it("reports wrote_outside and removes both files", async () => {
    const p = paths();
    const { b, killed } = backend(async () => {
      writeFileSync(p.inside, "");
      writeFileSync(p.outside, "");
      return { sessionId: "s", output: "" };
    });
    const r = await probeConfinement(b, p, { timeoutMs: 500 });
    expect(r).toEqual({ confined: false, reason: "wrote_outside" });
    expect(existsSync(p.inside) || existsSync(p.outside)).toBe(false);
    expect(killed).toEqual(["s"]);
    rmSync(p.dir, { recursive: true, force: true });
  });

  it("reports confined when only the inside file is written", async () => {
    const p = paths();
    const { b } = backend(async () => {
      writeFileSync(p.inside, "");
      return { sessionId: "s", output: "" };
    });
    expect(await probeConfinement(b, p, { timeoutMs: 500 })).toEqual({ confined: true });
    rmSync(p.dir, { recursive: true, force: true });
  });

  it("reports cannot_write_inside when nothing is written", async () => {
    const p = paths();
    const { b } = backend(async () => ({ sessionId: "s", output: "" }));
    expect(await probeConfinement(b, p, { timeoutMs: 100 })).toEqual({
      confined: false,
      reason: "cannot_write_inside",
    });
    rmSync(p.dir, { recursive: true, force: true });
  });

  it("reports start_failed with the error message", async () => {
    const p = paths();
    const { b } = backend(async () => {
      throw new Error("no node-pty");
    });
    expect(await probeConfinement(b, p)).toEqual({
      confined: false,
      reason: "start_failed",
      detail: "no node-pty",
    });
    rmSync(p.dir, { recursive: true, force: true });
  });
});

function integrationSkipReason(): string | undefined {
  try {
    createRequire(import.meta.url)("node-pty");
  } catch {
    return "node-pty is not installed";
  }
  if (spawnSync("bwrap", ["--version"]).status !== 0) return "bubblewrap (bwrap) is not available";
  return undefined;
}

const skipReason = integrationSkipReason();
if (skipReason) console.warn(`confined-pty integration test skipped: ${skipReason}`);

describe("confined backend, real PTY + bubblewrap", () => {
  it.skipIf(skipReason !== undefined)("proves confinement on this host", async () => {
    const root = mkdtempSync(join(tmpdir(), "confined-root-"));
    const outside = join(process.cwd(), `.confined-outside-${process.pid}`);
    const backend = createConfinedPtyBackend({ root, mode: "workspace-write" });
    const r = await probeConfinement(backend, { inside: join(root, "in"), outside });
    rmSync(root, { recursive: true, force: true });
    // Namespaces may be forbidden in CI containers; accept any definite, non-leaking answer.
    expect(r.confined || r.reason !== "wrote_outside").toBe(true);
  });
});
