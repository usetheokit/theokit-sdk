import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (orig) => {
  const actual = await orig<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: vi.fn(actual.link),
    unlink: vi.fn(actual.unlink),
    readFile: vi.fn(actual.readFile),
  };
});

import { acquireWithHooks } from "../src/internal/persistence/instance-lock.js";
import { acquireInstanceLock, InstanceLockedError } from "../src/persistence.js";
import { withMockedCwd } from "./helpers/with-cwd.js";

const CHILD = fileURLToPath(new URL("./fixtures/instance-lock-child.mjs", import.meta.url));

let root: string;
let dir: string;
let lockPath: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "instance-lock-"));
  dir = path.join(root, "state");
  lockPath = `${dir}.instance.lock`;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
    encoding: "utf8",
  });
  return Number(r.stdout);
}

const readHolder = () =>
  JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number; nonce: string };

describe("acquireInstanceLock", () => {
  it("refuses a second holder, naming the live pid", async () => {
    const first = await acquireInstanceLock(dir);
    expect(first.path).toBe(lockPath);
    const err = await acquireInstanceLock(dir).catch((e) => e);
    expect(err).toBeInstanceOf(InstanceLockedError);
    expect(err.holderPid).toBe(process.pid);
    expect(err.lockPath).toBe(lockPath);
    expect(err.message).toContain(lockPath);
    expect(err.message).toContain(String(process.pid));
    await first.release();
    await (await acquireInstanceLock(dir)).release();
  });

  it("honours options.path", async () => {
    const custom = path.join(root, "custom.lock");
    const l = await acquireInstanceLock(dir, { path: custom });
    expect(l.path).toBe(custom);
    await l.release();
  });

  it("takes over a lock left by a pid that is not running", async () => {
    writeFileSync(lockPath, JSON.stringify({ pid: deadPid(), nonce: "old" }));
    const l = await acquireInstanceLock(dir);
    expect(readHolder().pid).toBe(process.pid);
    await l.release();
  });

  it("resolves a relative options.path so release() survives a cwd change", async () => {
    const l = await withMockedCwd(root, () => acquireInstanceLock(dir, { path: "rel.lock" }));
    expect(path.isAbsolute(l.path)).toBe(true);
    await withMockedCwd(tmpdir(), () => l.release());
    expect(existsSync(path.join(root, "rel.lock"))).toBe(false);
  });

  it("release() does not remove a lock another holder took over", async () => {
    const a = await acquireInstanceLock(dir);
    // simulate a crash of A: its lock now names a dead pid, then B takes over
    writeFileSync(lockPath, JSON.stringify({ pid: deadPid(), nonce: "a-dead" }));
    const b = await acquireInstanceLock(dir);
    await a.release();
    expect(readHolder().pid).toBe(process.pid);
    const err = await acquireInstanceLock(dir).catch((e) => e);
    expect(err).toBeInstanceOf(InstanceLockedError);
    await b.release();
  });

  it("concurrent release() calls share one removal and never remove a later lock", async () => {
    const actualRead = (
      await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    ).readFile;
    const a = await acquireInstanceLock(dir);
    const aNonce = readHolder().nonce;
    // Pause every read the releases make, so each one has seen A's lock before any removes it.
    const gates: Array<() => void> = [];
    vi.mocked(fsp.readFile).mockImplementation((async (...args: Parameters<typeof actualRead>) => {
      const content = await actualRead(...args);
      await new Promise<void>((open) => gates.push(open));
      return content;
    }) as never);
    try {
      const p1 = a.release();
      const p2 = a.release();
      await vi.waitFor(() => expect(gates.length).toBeGreaterThan(0));
      await new Promise((r) => setTimeout(r, 30)); // time for an independent second read to start
      gates[0]?.();
      await p1;
      const b = await acquireInstanceLock(dir); // takes the lock A just removed
      for (const open of gates.slice(1)) open(); // a second removal, if there is one, runs now
      await p2;
      expect(gates).toHaveLength(1);
      expect(readHolder().nonce).not.toBe(aNonce);
      vi.mocked(fsp.readFile).mockImplementation(actualRead as never);
      await b.release();
    } finally {
      vi.mocked(fsp.readFile).mockImplementation(actualRead as never);
    }
  });

  it("rejects when link fails with an error other than EEXIST", async () => {
    vi.mocked(fsp.link).mockRejectedValueOnce(
      Object.assign(new Error("nope"), { code: "ENOTSUP" }),
    );
    const err = await acquireInstanceLock(dir).catch((e) => e);
    expect(err).toBeInstanceOf(InstanceLockedError);
    expect(err.message).toContain("hard links");
  });

  it.each([
    ["a dead pid", () => JSON.stringify({ pid: deadPid(), nonce: "stale" })],
    ["malformed content", () => "not json"],
    ["no nonce", () => JSON.stringify({ pid: deadPid() })],
  ])(
    "two processes taking over one stale lock (%s) end with exactly one holder",
    async (_name, content) => {
      writeFileSync(lockPath, content());
      const barrier = mkdtempSync(path.join(root, "barrier-"));
      const run = (id: string) =>
        new Promise<number | null>((res) => {
          const c = spawn(
            process.execPath,
            ["--experimental-strip-types", CHILD, dir, barrier, id],
            {
              stdio: "inherit",
            },
          );
          c.on("exit", (code) => res(code));
        });
      const codes = await Promise.all([run("a"), run("b")]);
      expect(codes).toEqual([0, 0]);
      const results = ["a", "b"].map((id) =>
        JSON.parse(readFileSync(path.join(barrier, `result.${id}`), "utf8")),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok).every((r) => r.name === "InstanceLockedError")).toBe(
        true,
      );
    },
    30000,
  );

  describe("takeover guards and release (#1191)", () => {
    const staleRaw = () => JSON.stringify({ pid: deadPid(), nonce: "stale" });
    const guardsOf = () => readdirSync(root).filter((f) => f.includes(".instance.lock.takeover."));
    const generation = (raw: string) => createHash("sha256").update(raw).digest("hex").slice(0, 32);

    it("takes over after 17 crashed contenders left guards on one generation", async () => {
      const raw = staleRaw();
      writeFileSync(lockPath, raw);
      const dead = JSON.stringify({ pid: deadPid(), nonce: "crashed" });
      for (let k = 0; k < 17; k++) {
        writeFileSync(`${lockPath}.takeover.${generation(raw)}.${k}`, dead);
      }
      const l = await acquireInstanceLock(dir);
      expect(readHolder().pid).toBe(process.pid);
      await l.release();
    });

    it("a guard left by a crashed contender does not block a later takeover", async () => {
      const raw = staleRaw();
      writeFileSync(lockPath, raw);
      writeFileSync(
        `${lockPath}.takeover.${generation(raw)}.0`,
        JSON.stringify({ pid: deadPid(), nonce: "crashed" }),
      );
      const l = await acquireInstanceLock(dir);
      expect(readHolder().pid).toBe(process.pid);
      await l.release();
    });

    it("a live guard is never skipped", async () => {
      const raw = staleRaw();
      writeFileSync(lockPath, raw);
      writeFileSync(
        `${lockPath}.takeover.${generation(raw)}.0`,
        JSON.stringify({ pid: process.pid, nonce: "live" }),
      );
      await expect(acquireInstanceLock(dir)).rejects.toBeInstanceOf(InstanceLockedError);
      expect(readFileSync(lockPath, "utf8")).toBe(raw);
    });

    it("a paused release() does not remove a guard a later generation published", async () => {
      const raw = staleRaw();
      writeFileSync(lockPath, raw);
      const guard0 = `${lockPath}.takeover.${generation(raw)}.0`;
      let resume!: () => void;
      let paused!: () => void;
      const pausedP = new Promise<void>((r) => (paused = r));
      const gate = new Promise<void>((r) => (resume = r));
      const a = await acquireWithHooks(dir, undefined, {
        beforeGuardCleanup: async () => {
          paused();
          await gate;
        },
      });
      expect(existsSync(guard0)).toBe(true);
      const releasing = a.release();
      await pausedP; // A's lock is gone; A still holds its guard list
      // A later generation (same stale content) publishes its guard at the same path.
      rmSync(guard0);
      writeFileSync(lockPath, raw);
      let guardSeen!: () => void;
      let proceed!: () => void;
      const seen = new Promise<void>((r) => (guardSeen = r));
      const go = new Promise<void>((r) => (proceed = r));
      const b = acquireWithHooks(dir, undefined, {
        afterGuardPublished: async () => {
          guardSeen();
          await go;
        },
      });
      await seen;
      const bGuard = readFileSync(guard0, "utf8");
      resume();
      await releasing;
      expect(readFileSync(guard0, "utf8")).toBe(bGuard);
      proceed();
      const lockB = await b;
      expect(readHolder().pid).toBe(process.pid);
      expect(guardsOf().length).toBeGreaterThan(0);
      await lockB.release();
      expect(existsSync(lockPath)).toBe(false);
    });

    it("release() rejects when the unlink fails, and a later release() removes the lock", async () => {
      const l = await acquireInstanceLock(dir);
      vi.mocked(fsp.unlink).mockRejectedValueOnce(
        Object.assign(new Error("busy"), { code: "EIO" }),
      );
      await expect(l.release()).rejects.toThrow("busy");
      expect(existsSync(lockPath)).toBe(true);
      await l.release();
      expect(existsSync(lockPath)).toBe(false);
    });
  });
});
