import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const linkFail = vi.hoisted(() => ({
  code: undefined as string | undefined,
  onGuard: undefined as (() => void) | undefined,
  onAbsentRead: undefined as ((path: string) => void) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    readFile: (async (...args: Parameters<typeof real.readFile>) => {
      try {
        return await real.readFile(...args);
      } catch (err) {
        const hook = linkFail.onAbsentRead;
        if ((err as NodeJS.ErrnoException).code === "ENOENT" && hook) {
          linkFail.onAbsentRead = undefined;
          hook(String(args[0]));
        }
        throw err;
      }
    }) as typeof real.readFile,
    link: (...args: Parameters<typeof real.link>) => {
      if (linkFail.code) {
        return Promise.reject(Object.assign(new Error("link failed"), { code: linkFail.code }));
      }
      if (linkFail.onGuard && String(args[1]).includes(".takeover.")) {
        const hook = linkFail.onGuard;
        linkFail.onGuard = undefined;
        return real.link(...args).then((r) => {
          hook();
          return r;
        });
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
  linkFail.onGuard = undefined;
  linkFail.onAbsentRead = undefined;
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

  it("a live takeover guard blocks other takeovers and is not reaped", async () => {
    writeStale("gen1");
    const guard = `${lockPath}.takeover.gen1.0`;
    writeFileSync(guard, JSON.stringify({ pid: process.pid, nonce: "owner" }));
    const err = await acquireInstanceLock(dir).catch((e) => e);
    expect(err).toBeInstanceOf(InstanceLockedError);
    expect(existsSync(guard)).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, "utf8")).nonce).toBe("gen1");
  });

  it("takes over after a taker crashed holding its guard", async () => {
    writeStale("gen1");
    const guard = `${lockPath}.takeover.gen1.0`;
    writeFileSync(guard, JSON.stringify({ pid: deadPid(), nonce: "crashed" }));
    const lock = await acquireInstanceLock(dir);
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
    expect(existsSync(guard)).toBe(true); // superseded, never deleted by others
    await lock.release();
  });

  it("release never removes a takeover guard", async () => {
    const mine = await acquireInstanceLock(dir);
    const nonce = JSON.parse(readFileSync(lockPath, "utf8")).nonce;
    const guard = `${lockPath}.takeover.${nonce}.0`;
    writeFileSync(guard, JSON.stringify({ pid: process.pid, nonce: "active" }));
    const later = `${lockPath}.takeover.later.0`;
    writeFileSync(later, JSON.stringify({ pid: process.pid, nonce: "active2" }));
    await mine.release();
    expect(existsSync(guard)).toBe(true);
    expect(existsSync(later)).toBe(true);
  });

  it("does not overwrite a holder that links in right after the re-read reports absence", async () => {
    writeStale("gen1");
    const other = JSON.stringify({ pid: process.pid, nonce: "live-other" });
    linkFail.onGuard = () => unlinkSync(lockPath); // stale lock vanishes once the guard is ours
    linkFail.onAbsentRead = (path) => {
      // the takeover's re-read just reported absence; another process links in before it goes on
      if (path === lockPath) writeFileSync(lockPath, other);
    };
    const err = await acquireInstanceLock(dir).catch((e) => e);
    expect(err).toBeInstanceOf(InstanceLockedError);
    expect(err.holderPid).toBe(process.pid);
    expect(readFileSync(lockPath, "utf8")).toBe(other);
  });

  it("retries the link protocol when the stale lock vanished before the re-read", async () => {
    writeStale("gen1");
    linkFail.onGuard = () => unlinkSync(lockPath);
    const lock = await acquireInstanceLock(dir);
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
    await lock.release();
  });

  it("two concurrent takeovers of one stale lock end with one holder", async () => {
    writeStale();
    const tsx = resolve(__dirname, "../../../../node_modules/.bin/tsx");
    const impl = resolve(__dirname, "../../src/persistence.ts");
    const script = join(root, "child.mjs");
    writeFileSync(
      script,
      `import { acquireInstanceLock } from ${JSON.stringify(impl)};
try { await acquireInstanceLock(process.argv[2]); console.log("held"); }
catch (e) { console.log(e.name === "InstanceLockedError" ? "locked" : "error " + e.message); }
process.stdin.resume(); process.stdin.on("end", () => process.exit(0));`,
    );
    const run = () =>
      new Promise<{ out: string; child: ReturnType<typeof spawn> }>((res) => {
        const child = spawn(tsx, [script, dir], { stdio: ["pipe", "pipe", "inherit"] });
        child.stdout.once("data", (d) => res({ out: String(d).trim(), child }));
      });
    const results = await Promise.all([run(), run()]);
    for (const r of results) r.child.stdin?.end();
    expect(results.map((r) => r.out).sort()).toEqual(["held", "locked"]);
  }, 60_000);
});
