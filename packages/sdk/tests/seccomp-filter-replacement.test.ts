// B-600 — a confined command must not be able to change the syscall filter a LATER confined
// command loads. Live: needs bubblewrap on x86_64; skipped with the reason elsewhere.
//
// Before the fix `LinuxSandbox` read its seccomp program from `/tmp/ab-seccomp-*/filter.bpf`, and
// `/tmp` is a writable root under `workspace-write`: one confined command could overwrite the file,
// or rename its directory away and recreate it, and every later command loaded an allow-all
// program. The SDK's wraps now pipe the program from memory, so there is no file to replace.

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  detectBwrap,
  LinuxSandbox,
  realProbes,
  restrictedSeccompPath,
} from "../src/sandbox/index.js";

const LIVE = detectBwrap(realProbes).ok && process.arch === "x64";
const itLive = LIVE ? it : it.skip; // reason: needs bubblewrap and the x86_64 seccomp program

const workDir = mkdtempSync(path.join(tmpdir(), "b600-wd-"));
const moved: string[] = [];
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
  for (const m of moved) rmSync(m, { recursive: true, force: true });
});

// One cBPF instruction, BPF_RET|BPF_K with SECCOMP_RET_ALLOW: a valid program that allows everything.
const ALLOW_ALL_OCTAL = "\\006\\000\\000\\000\\000\\000\\377\\177";

const INET_PROBE =
  'python3 -c "import socket\n' +
  'try:\n socket.socket(socket.AF_INET, socket.SOCK_STREAM); print(\\"INET-OK\\")\n' +
  'except OSError as e: print(\\"INET-DENIED\\", e.errno)"';

/** Every live process whose command line contains `marker`, read from /proc (no pgrep needed). */
function processesNaming(marker: string): number[] {
  const found: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    let cmdline: string;
    try {
      cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf-8").replace(/\0/g, " ");
    } catch {
      continue; // the process exited between readdir and read: it is not alive
    }
    if (cmdline.includes(marker)) found.push(Number(entry));
  }
  return found;
}

describe("B-600 — the seccomp program a later command loads", () => {
  itLive("a_confined_command_cannot_weaken_the_filter_of_a_later_command", async () => {
    const sbx = new LinuxSandbox({ workDir, timeoutMs: 10_000 }, { mode: "workspace-write" });
    const control = await sbx.execute(INET_PROBE);
    expect(control.stdout).toContain("INET-DENIED");

    const filter = restrictedSeccompPath();
    expect(filter).toBeDefined();
    const dir = path.dirname(filter!);
    moved.push(`${dir}.moved`);
    const q = (p: string): string => `'${p.replace(/'/g, "'\\''")}'`;
    // Every route a writable root offers: overwrite in place, then rename the parent directory
    // away and recreate the path with an allow-all program.
    await sbx.execute(
      `(printf '${ALLOW_ALL_OCTAL}' > ${q(filter!)}) 2>/dev/null; ` +
        `(mv ${q(dir)} ${q(`${dir}.moved`)} && mkdir ${q(dir)} && printf '${ALLOW_ALL_OCTAL}' > ${q(filter!)}) 2>/dev/null; true`,
    );

    const later = await sbx.execute(INET_PROBE);
    expect(later.stdout).toContain("INET-DENIED");
    expect(later.stdout).not.toContain("INET-OK");
  });

  itLive("timeout_ends_the_confined_command", async () => {
    // The program reaches bwrap through a pipe. Without the two `exec`s in that pipeline a timeout
    // killed only the outer shell and left the confined command running (measured in DISCOVER).
    const marker = `9.${process.pid}${Date.now() % 100_000}`;
    const sbx = new LinuxSandbox({ workDir, timeoutMs: 1_000 }, { mode: "workspace-write" });

    const started = Date.now();
    const r = await sbx.execute(`sleep ${marker}`);
    // execFile resolves only once stdout closes: a confined command still holding the pipe would
    // keep this pending long past the timeout.
    expect(Date.now() - started, "execute() did not return near its 1000 ms timeout").toBeLessThan(
      3_000,
    );
    expect(r.timedOut).toBe(true);

    const deadline = Date.now() + 2_000;
    let alive = processesNaming(`sleep ${marker}`);
    while (alive.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50)); // poll interval, not a guessed wait
      alive = processesNaming(`sleep ${marker}`);
    }
    expect(
      alive,
      `the confined sleep outlived its timeout by 2000 ms: pids ${alive.join(",")}`,
    ).toEqual([]);
  });
});
