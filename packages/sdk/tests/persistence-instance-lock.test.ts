import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (orig) => {
  const actual = await orig<typeof import("node:fs/promises")>();
  return { ...actual, link: vi.fn(actual.link), readFile: vi.fn(actual.readFile) };
});

import { acquireInstanceLock, InstanceLockedError } from "../src/persistence.js";

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

  it("two processes taking over one stale lock end with exactly one holder", async () => {
    writeFileSync(lockPath, JSON.stringify({ pid: deadPid(), nonce: "stale" }));
    const barrier = mkdtempSync(path.join(root, "barrier-"));
    const run = (id: string) =>
      new Promise<number | null>((res) => {
        const c = spawn(process.execPath, ["--experimental-strip-types", CHILD, dir, barrier, id], {
          stdio: "inherit",
        });
        c.on("exit", (code) => res(code));
      });
    const codes = await Promise.all([run("a"), run("b")]);
    expect(codes).toEqual([0, 0]);
    const results = ["a", "b"].map((id) =>
      JSON.parse(readFileSync(path.join(barrier, `result.${id}`), "utf8")),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => r.name === "InstanceLockedError")).toBe(true);
  }, 30000);
});
