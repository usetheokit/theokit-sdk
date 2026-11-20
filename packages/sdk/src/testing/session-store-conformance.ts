import { deepStrictEqual } from "node:assert/strict";
import type { SessionRecord, SessionStore } from "../types/session-store.js";

/** One named check of the {@link SessionStore} contract. */
export interface SessionStoreConformanceCase {
  /** Stable name, e.g. `"unknown agent reads as empty"`. */
  readonly name: string;
  /** Resolves when the store obeys the rule; throws an `Error` describing the violation. */
  run(): Promise<void>;
  /** Set when the case does not apply to this factory; the reason names why. Running it is a no-op. */
  readonly skipReason?: string;
}

/** How the suite obtains stores to check. */
export interface SessionStoreFactory {
  /** A fresh, empty store per case. */
  create(): Promise<SessionStore>;
  /** Optional: a store whose backend is down, to check that reads throw. */
  createUnreachable?(): Promise<SessionStore>;
  /**
   * Set to `true` when every `create()` call opens the SAME backend (same directory, database or
   * key space), so records written by one store are visible to the next. Enables the "survive a
   * second create()" and "lease contention" cases.
   */
  readonly sharesBackend?: boolean;
  /**
   * Set to `false` when two stores over the same backend are allowed to hold one session's lease
   * at once (for example an in-process lease shared by reference count). Skips the contention case.
   * Defaults to `true`.
   */
  readonly exclusiveLeases?: boolean;
}

const BUSY = "SessionBusyError";
let counter = 0;

function freshId(label: string): string {
  counter += 1;
  return `conformance-${label}-${process.pid}-${Date.now().toString(36)}-${counter}`;
}

function record(uuid: string, parentUuid: string | null, text: string): SessionRecord {
  return {
    type: "user",
    uuid,
    parentUuid,
    sessionId: "conformance-session",
    timestamp: "2026-07-15T00:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

function chain(prefix: string, count: number, startAfter: string | null = null): SessionRecord[] {
  const out: SessionRecord[] = [];
  let parent = startAfter;
  for (let i = 0; i < count; i++) {
    const uuid = `${prefix}-${i}`;
    out.push(record(uuid, parent, `${prefix} message ${i}`));
    parent = uuid;
  }
  return out;
}

function expectEqual(actual: unknown, expected: unknown, rule: string): void {
  try {
    deepStrictEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)));
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`SessionStore rule violated: ${rule}\n${detail}`);
  }
}

async function withStores(
  factory: SessionStoreFactory,
  count: number,
  body: (stores: SessionStore[]) => Promise<void>,
): Promise<void> {
  const stores: SessionStore[] = [];
  try {
    for (let i = 0; i < count; i++) stores.push(await factory.create());
    await body(stores);
  } finally {
    for (const store of stores) await store.dispose?.().catch(() => undefined);
  }
}

async function withStore(
  factory: SessionStoreFactory,
  body: (store: SessionStore) => Promise<void>,
): Promise<void> {
  await withStores(factory, 1, ([store]) => body(store as SessionStore));
}

function skipped(name: string, skipReason: string): SessionStoreConformanceCase {
  return { name, skipReason, run: async () => undefined };
}

function readCases(factory: SessionStoreFactory): SessionStoreConformanceCase[] {
  return [
    {
      name: "unknown agent reads as empty",
      run: () =>
        withStore(factory, async (store) => {
          expectEqual(
            await store.readRecords(freshId("unknown")),
            [],
            "a never-written session MUST resolve to [] (not throw)",
          );
        }),
    },
    {
      name: "append then read returns the same records in order",
      run: () =>
        withStore(factory, async (store) => {
          const id = freshId("roundtrip");
          const records = chain("rt", 3);
          await store.appendRecords(id, records);
          expectEqual(
            await store.readRecords(id),
            records,
            "readRecords MUST return the appended records, deep-equal and in append order",
          );
        }),
    },
    {
      name: "two appends read back as one ordered list",
      run: () =>
        withStore(factory, async (store) => {
          const id = freshId("two-appends");
          const first = chain("a", 2);
          const second = chain("b", 2, "a-1");
          await store.appendRecords(id, first);
          await store.appendRecords(id, second);
          expectEqual(
            await store.readRecords(id),
            [...first, ...second],
            "appendRecords MUST preserve order and MUST NOT drop or rewrite prior records",
          );
        }),
    },
    {
      name: "sessions of two agents are isolated",
      run: () =>
        withStore(factory, async (store) => {
          const a = freshId("iso-a");
          const b = freshId("iso-b");
          const ra = chain("ia", 2);
          const rb = chain("ib", 1);
          await store.appendRecords(a, ra);
          await store.appendRecords(b, rb);
          expectEqual(
            await store.readRecords(a),
            ra,
            "a session MUST NOT see another agent's records",
          );
          expectEqual(
            await store.readRecords(b),
            rb,
            "a session MUST NOT see another agent's records",
          );
        }),
    },
  ];
}

function persistenceCase(factory: SessionStoreFactory): SessionStoreConformanceCase {
  const name = "records survive a second create() over the same backend";
  if (factory.sharesBackend !== true) {
    return skipped(
      name,
      "the factory does not set sharesBackend, so create() calls are independent",
    );
  }
  return {
    name,
    run: async () => {
      const id = freshId("persist");
      const records = chain("ps", 2);
      await withStore(factory, (store) => store.appendRecords(id, records));
      await withStore(factory, async (store) => {
        expectEqual(
          await store.readRecords(id),
          records,
          "persisted records MUST be readable by a new store",
        );
      });
    },
  };
}

function unreachableCase(factory: SessionStoreFactory): SessionStoreConformanceCase {
  const name = "unreachable backend makes readRecords reject";
  const create = factory.createUnreachable;
  if (create === undefined) return skipped(name, "the factory has no createUnreachable");
  return {
    name,
    run: async () => {
      const store = await create.call(factory);
      try {
        let result: SessionRecord[];
        try {
          result = await store.readRecords(freshId("down"));
        } catch {
          return;
        }
        throw new Error(
          `SessionStore rule violated: a store that cannot read MUST throw rather than return [] (resolved to ${JSON.stringify(result)})`,
        );
      } finally {
        await store.dispose?.().catch(() => undefined);
      }
    },
  };
}

function leaseCases(factory: SessionStoreFactory): SessionStoreConformanceCase[] {
  const cycle = "acquire, release and acquire again resolve";
  const busy = "second store acquiring a held agent rejects with SessionBusyError";
  const cycleCase: SessionStoreConformanceCase = {
    name: cycle,
    run: () =>
      withStore(factory, async (store) => {
        if (store.acquire === undefined) return;
        const id = freshId("lease");
        await store.acquire(id);
        await store.release?.(id);
        await store.acquire(id);
        await store.release?.(id);
      }),
  };
  const busyCase: SessionStoreConformanceCase = {
    name: busy,
    run: () =>
      withStores(factory, 2, async ([first, second]) => {
        if (first?.acquire === undefined || second?.acquire === undefined) return;
        const id = freshId("busy");
        await first.acquire(id);
        try {
          await second.acquire(id).then(
            () => {
              throw new Error(
                "SessionStore rule violated: a second store acquiring a held agentId MUST reject with SessionBusyError (it resolved)",
              );
            },
            (err: unknown) => {
              if (!(err instanceof Error) || err.name !== BUSY) {
                throw new Error(
                  `SessionStore rule violated: acquire on a held agentId MUST reject with name "${BUSY}", got ${String(err)}`,
                );
              }
            },
          );
        } finally {
          await first.release?.(id);
        }
      }),
  };
  return [
    cycleCase,
    factory.sharesBackend !== true
      ? skipped(busy, "the factory does not set sharesBackend, so create() calls are independent")
      : factory.exclusiveLeases === false
        ? skipped(busy, "the factory sets exclusiveLeases: false")
        : busyCase,
  ];
}

const disposeCase = (factory: SessionStoreFactory): SessionStoreConformanceCase => ({
  name: "dispose resolves",
  run: async () => {
    const store = await factory.create();
    if (store.dispose === undefined) return;
    await store.dispose();
  },
});

/**
 * The SessionStore contract as plain named cases. Loop over them in any test runner:
 * `for (const c of cases) it(c.name, c.run)` — a case with `skipReason` is a no-op, so map it to
 * the runner's skip instead.
 *
 * @public
 */
export function sessionStoreConformanceCases(
  factory: SessionStoreFactory,
): readonly SessionStoreConformanceCase[] {
  return [
    ...readCases(factory),
    persistenceCase(factory),
    unreachableCase(factory),
    ...leaseCases(factory),
    disposeCase(factory),
  ];
}
