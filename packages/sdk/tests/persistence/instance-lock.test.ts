import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const linkFail = vi.hoisted(() => ({ code: undefined as string | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    link: (...args: Parameters<typeof real.link>) => {
      if (linkFail.code) {
        return Promise.reject(Object.assign(new Error("link failed"), { code: linkFail.code }));
      }
      return real.link(...args);
    },
  };
});

import { acquireInstanceLock, InstanceLockedError } from "../../src/persistence.js";

let root: string;
let dir: string;
let lockPath: string;

function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", ""]);
  return r.pid;
}

function writeStale(nonce = "stale"): void {
  writeFileSync(lockPath, JSON.stringify({ pid: deadPid(), nonce }));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "instance-lock-"));
  dir = join(root, "state");
  lockPath = `${dir}.instance.lock`;
  linkFail.code = undefined;
});
afterEach(() => {
  linkFail.code = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe("acquireInstanceLock", () => {
  it("refuses a second acquire and names this pid", async () => {
    const first = await acquireInstanceLock(dir);
    const err = await acquireInstanceLock(dir).catch((e) => e);
    expect(err).toBeInstanceOf(InstanceLockedError);
    expect(err.holderPid).toBe(process.pid);
    expect(err.lockPath).toBe(lockPath);
    expect(err.message).toContain(lockPath);
    expect(err.message).toContain(String(process.pid));
    await first.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("takes over a lock left by a pid that is not running", async () => {
    writeStale();
    const lock = await acquireInstanceLock(dir);
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
    await lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("release after another holder took over leaves their lock", async () => {
    const mine = await acquireInstanceLock(dir);
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, nonce: "someone-else" }));
    await mine.release();
    expect(JSON.parse(readFileSync(lockPath, "utf8")).nonce).toBe("someone-else");
    await mine.release(); // idempotent
  });

  it("honours options.path", async () => {
    const p = join(root, "custom.lock");
    const lock = await acquireInstanceLock(dir, { path: p });
    expect(lock.path).toBe(p);
    expect(existsSync(p)).toBe(true);
    await lock.release();
  });

  it("rejects naming hard links when link fails with another error", async () => {
    linkFail.code = "EPERM";
    const err = await acquireInstanceLock(dir).catch((e) => e);
    expect(err).toBeInstanceOf(InstanceLockedError);
    expect(err.message).toMatch(/filesystem with hard links/);
    expect(existsSync(lockPath)).toBe(false);
  });

  const dist = resolve(__dirname, "../../dist/persistence.js");
  it.skipIf(!existsSync(dist))(
    "two concurrent takeovers of one stale lock end with one holder",
    async () => {
      writeStale();
      const script = join(root, "child.mjs");
      writeFileSync(
        script,
        `import { acquireInstanceLock } from ${JSON.stringify(dist)};
try { await acquireInstanceLock(process.argv[2]); console.log("held"); }
catch (e) { console.log(e.name === "InstanceLockedError" ? "locked" : "error " + e.message); }
process.stdin.resume(); process.stdin.on("end", () => process.exit(0));`,
      );
      const run = () =>
        new Promise<{ out: string; child: ReturnType<typeof spawn> }>((res) => {
          const child = spawn(process.execPath, [script, dir], {
            stdio: ["pipe", "pipe", "inherit"],
          });
          child.stdout.once("data", (d) => res({ out: String(d).trim(), child }));
        });
      const results = await Promise.all([run(), run()]);
      for (const r of results) r.child.stdin?.end();
      expect(results.map((r) => r.out).sort()).toEqual(["held", "locked"]);
    },
    30_000,
  );
});
