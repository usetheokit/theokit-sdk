import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FsSessionStore } from "../src/internal/persistence/fs-session-store.js";
import { SqliteSessionStore } from "../src/persistence.js";
import {
  type SessionStoreConformanceCase,
  type SessionStoreFactory,
  sessionStoreConformanceCases,
} from "../src/testing.js";
import type { SessionRecord, SessionStore } from "../src/types/session-store.js";

const dirs: string[] = [];
async function tmp(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `theokit-conf-${label}-`));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

function runAll(label: string, cases: readonly SessionStoreConformanceCase[]): void {
  describe(label, () => {
    for (const c of cases) {
      if (c.skipReason !== undefined) it.skip(`${c.name} (${c.skipReason})`, () => undefined);
      else it(c.name, () => c.run());
    }
  });
}

async function fsFactory(): Promise<SessionStoreFactory> {
  const baseDir = await tmp("fs-base");
  const cwd = await tmp("fs-cwd");
  const blocker = join(await tmp("fs-blocker"), "file");
  await writeFile(blocker, "x");
  return {
    sharesBackend: true,
    // One lease per path is shared by reference count inside a process (deliberate).
    exclusiveLeases: false,
    create: async () => new FsSessionStore({ baseDir, cwd }),
    createUnreachable: async () => new FsSessionStore({ baseDir: join(blocker, "x"), cwd }),
  };
}

async function sqliteFactory(): Promise<SessionStoreFactory> {
  const filePath = join(await tmp("sqlite"), "sessions.db");
  const blocker = join(await tmp("sqlite-blocker"), "file");
  await writeFile(blocker, "x");
  return {
    sharesBackend: true,
    create: async () => new SqliteSessionStore({ filePath }),
    createUnreachable: async () =>
      new SqliteSessionStore({ filePath: join(blocker, "nested", "s.db") }),
  };
}

runAll("FsSessionStore conformance", sessionStoreConformanceCases(await fsFactory()));
runAll("SqliteSessionStore conformance", sessionStoreConformanceCases(await sqliteFactory()));

function memoryStore(opts: { reverse?: boolean; swallowRead?: boolean }): SessionStore {
  const data = new Map<string, SessionRecord[]>();
  return {
    async readRecords(id) {
      if (opts.swallowRead) return [];
      const rows = data.get(id) ?? [];
      return opts.reverse ? [...rows].reverse() : [...rows];
    },
    async appendRecords(id, records) {
      data.set(id, [...(data.get(id) ?? []), ...records]);
    },
  };
}

function find(cases: readonly SessionStoreConformanceCase[], part: string) {
  const c = cases.find((x) => x.name.includes(part));
  if (c === undefined) throw new Error(`no case ${part}`);
  return c;
}

describe("broken stores are caught", () => {
  it("conformance_catches_empty_read_on_failure", async () => {
    const cases = sessionStoreConformanceCases({
      create: async () => memoryStore({}),
      createUnreachable: async () => memoryStore({ swallowRead: true }),
    });
    await expect(find(cases, "unreachable").run()).rejects.toThrow(
      /MUST throw rather than return \[\]/,
    );
  });

  it("conformance_catches_reordered_appends", async () => {
    const cases = sessionStoreConformanceCases({
      create: async () => memoryStore({ reverse: true }),
    });
    await expect(find(cases, "same records in order").run()).rejects.toThrow(/append order/);
  });

  it("a correct in-memory store passes and the shared-backend cases skip with a reason", async () => {
    const cases = sessionStoreConformanceCases({ create: async () => memoryStore({}) });
    for (const c of cases) await c.run();
    const skipped = cases.filter((c) => c.skipReason !== undefined).map((c) => c.skipReason);
    expect(skipped.length).toBe(3);
    expect(skipped.every((r) => typeof r === "string" && r.length > 0)).toBe(true);
  });

  it("a lease that never reports busy fails the contention case", async () => {
    const backing = memoryStore({});
    const cases = sessionStoreConformanceCases({
      sharesBackend: true,
      create: async () => ({ ...backing, acquire: async () => undefined }),
    });
    await expect(find(cases, "SessionBusyError").run()).rejects.toThrow(/SessionBusyError/);
  });
});

describe("@theokit/sdk/testing exports", () => {
  it("exposes the factory function", () => {
    expect(typeof sessionStoreConformanceCases).toBe("function");
  });
});
