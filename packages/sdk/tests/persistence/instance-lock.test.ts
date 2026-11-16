import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const linkFail = vi.hoisted(() => ({
  code: undefined as string | undefined,
  onGuard: undefined as (() => void) | undefined,
  onAbsentRead: undefined as ((path: string) => void) | undefined,
  onRead: undefined as ((path: string) => void | Promise<void>) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    readFile: (async (...args: Parameters<typeof real.readFile>) => {
      try {
        const text = await real.readFile(...args);
        await linkFail.onRead?.(String(args[0]));
        return text;
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
  linkFail.onRead = undefined;
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

  it("takes over after many takers crashed on the same generation", async () => {
    writeStale("gen1");
    const dead = deadPid();
    for (let k = 0; k < 40; k++) {
      writeFileSync(
        `${lockPath}.takeover.gen1.${k}`,
        JSON.stringify({ pid: dead, nonce: `crashed${k}` }),
      );
    }
    const lock = await acquireInstanceLock(dir);
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
    await lock.release();
  });

  it("release propagates a failure and a later call retries", async () => {
    const lock = await acquireInstanceLock(dir);
    rmSync(lockPath);
    mkdirSync(lockPath); // reading a directory fails with EISDIR
    await expect(lock.release()).rejects.toMatchObject({ code: "EISDIR" });
    rmSync(lockPath, { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, nonce: "other" }));
    await lock.release(); // retried, ownership verified absent
    expect(existsSync(lockPath)).toBe(true);
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

  it("a contender linking in during a takeover backs out and is never overwritten", async () => {
    writeStale("gen1");
    let armed = false;
    let contender: Promise<unknown> | undefined;
    linkFail.onGuard = () => {
      armed = true;
    };
    linkFail.onRead = async (path) => {
      if (!armed || path !== lockPath) return;
      armed = false;
      // the stale lock is removed and a contender acquires while the taker holds its guard
      unlinkSync(lockPath);
      contender = acquireInstanceLock(dir).catch((e) => e);
      const err = await contender;
      expect(err).toBeInstanceOf(InstanceLockedError);
      expect(existsSync(lockPath)).toBe(false); // it never kept the lock
    };
    const lock = await acquireInstanceLock(dir);
    expect(contender).toBeDefined();
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
    await lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("an empty takeover guard blocks contenders and stays in place", async () => {
    writeStale("gen1");
    const guard = `${lockPath}.takeover.gen1.0`;
    writeFileSync(guard, "");
    const err = await acquireInstanceLock(dir).catch((e) => e);
    expect(err).toBeInstanceOf(InstanceLockedError);
    expect(existsSync(guard)).toBe(true);
    expect(readFileSync(guard, "utf8")).toBe("");
    expect(JSON.parse(readFileSync(lockPath, "utf8")).nonce).toBe("gen1");
  });

  it("retries the link protocol when the stale lock vanished before the re-read", async () => {
    writeStale("gen1");
    linkFail.onGuard = () => unlinkSync(lockPath);
    const lock = await acquireInstanceLock(dir);
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
    await lock.release();
  });

  it("concurrent release calls share one removal", async () => {
    const mine = await acquireInstanceLock(dir);
    const first = mine.release();
    const second = mine.release();
    expect(second).toBe(first);
    // another holder takes the lock the moment the first removal is done
    await first;
    const other = JSON.stringify({ pid: process.pid, nonce: "someone-else" });
    writeFileSync(lockPath, other);
    await second;
    await mine.release();
    expect(readFileSync(lockPath, "utf8")).toBe(other);
  });

  it("two concurrent takeovers of one stale lock end with one holder", async () => {
    writeStale();
    const tsx = resolve(__dirname, "../../../../node_modules/.bin/tsx");
    expect(existsSync(tsx), `tsx missing at ${tsx}: run pnpm install`).toBe(true);
    const impl = resolve(__dirname, "../../src/persistence.ts");
    expect(existsSync(impl)).toBe(true);
    const script = join(root, "child.mjs");
    const barrier = join(root, "barrier");
    mkdirSync(barrier);
    // Each child waits, after reading the stale lock, until both children have read it.
    writeFileSync(
      script,
      `import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { writeFileSync, readdirSync } from "node:fs";
const [dir, barrier] = process.argv.slice(2);
const lockPath = dir + ".instance.lock";
const realRead = fsp.readFile;
let waited = false;
fsp.readFile = async (...args) => {
  const text = await realRead(...args);
  if (!waited && String(args[0]) === lockPath) {
    waited = true;
    writeFileSync(barrier + "/" + process.pid, "");
    const deadline = Date.now() + 30000;
    while (readdirSync(barrier).length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  return text;
};
syncBuiltinESMExports();
const { acquireInstanceLock } = await import(${JSON.stringify(impl)});
try { await acquireInstanceLock(dir); console.log("held"); }
catch (e) { console.log(e.name === "InstanceLockedError" ? "locked" : "error " + e.message); }
process.stdin.resume(); process.stdin.on("end", () => process.exit(0));`,
    );
    const run = () =>
      new Promise<{ out: string; child: ReturnType<typeof spawn> }>((res) => {
        const child = spawn(tsx, [script, dir, barrier], { stdio: ["pipe", "pipe", "inherit"] });
        child.stdout.once("data", (d) => res({ out: String(d).trim(), child }));
      });
    const results = await Promise.all([run(), run()]);
    for (const r of results) r.child.stdin?.end();
    expect(readdirSync(barrier)).toHaveLength(2);
    expect(results.map((r) => r.out).sort()).toEqual(["held", "locked"]);
  }, 60_000);
});
