import { readFileSync } from "node:fs";
import type { AgentLease } from "./agent.js";
import { GenerationFileError, SessionPoolClosedError } from "./errors.js";
import { diag } from "./internal/diagnostics.js";
import { atomicWriteJson } from "./internal/persistence/atomic-write.js";
import type { AgentOptions, SDKAgent } from "./types/agent.js";

/**
 * The generation counter per session key. A reset moves a key to the next generation, which maps
 * to a new agent id.
 *
 * @public
 */
export interface GenerationStore {
  current(key: string): number;
  /** Persist and return the next generation. A failed write leaves `current()` unchanged. */
  next(key: string): Promise<number>;
}

/**
 * Options of {@link Agent.sessionPool}.
 *
 * @public
 */
export interface SessionPoolOptions {
  /** Options for the agent of `key`. Called when an agent opens. */
  open(key: string): AgentOptions | Promise<AgentOptions>;
  /** Retire an agent no turn holds after this many ms without use. */
  idleMs?: number;
  /** Bound on open agents; only agents no turn holds are retired to meet it. */
  maxOpen?: number;
  /** Default `memoryGenerations()`. */
  generations?: GenerationStore;
  /** Agent id for a key at a generation. Default `${key}-g${generation}`. Ids must be unique. */
  agentId?(key: string, generation: number): string;
}

/**
 * One agent per session key, with resets, rebuilds and a drained shutdown.
 *
 * @public
 */
export interface SessionPool {
  /** Hold the agent of `key`, opening it if needed. Release in a `finally`. */
  lease(key: string): Promise<AgentLease>;
  /** Move `key` to the next generation. Turns in flight finish on the old agent, which is then disposed. */
  reset(key: string): Promise<void>;
  /** Retire the agent of `key` but keep its id: the next lease reopens it with fresh options. */
  rebuild(key: string): void;
  /** Refuse new leases, wait up to `drainMs` (default 30000) for held ones, then dispose everything. */
  disposeAll(options?: { drainMs?: number }): Promise<{ stillRunning: string[] }>;
}

/** Generations kept in memory only. */
export function memoryGenerations(): GenerationStore {
  const map = new Map<string, number>();
  return {
    current: (key) => map.get(key) ?? 0,
    next: async (key) => {
      const n = (map.get(key) ?? 0) + 1;
      map.set(key, n);
      return n;
    },
  };
}

function readGenerationFile(file: string): Map<string, number> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw new GenerationFileError(file, "unreadable", { cause });
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (cause) {
    throw new GenerationFileError(file, "not JSON", { cause });
  }
  const gens = (data as { version?: unknown; generations?: unknown } | null)?.generations;
  const valid =
    typeof data === "object" &&
    data !== null &&
    (data as { version?: unknown }).version === 1 &&
    typeof gens === "object" &&
    gens !== null &&
    !Array.isArray(gens) &&
    Object.values(gens).every((n) => Number.isInteger(n) && (n as number) >= 0);
  if (!valid) throw new GenerationFileError(file, "expected { version: 1, generations }");
  return new Map(Object.entries(gens as Record<string, number>));
}

/**
 * Generations persisted to a JSON file (`{ version: 1, generations }`, mode 0600), one write at a
 * time. Throws {@link GenerationFileError} on a file it did not write, and leaves it untouched.
 */
export function jsonGenerations(file: string): GenerationStore {
  const map = readGenerationFile(file);
  let chain: Promise<unknown> = Promise.resolve();
  const write = async (key: string): Promise<number> => {
    const n = (map.get(key) ?? 0) + 1;
    const generations = { ...Object.fromEntries(map), [key]: n };
    await atomicWriteJson(file, { version: 1, generations }, { mode: 0o600 });
    map.set(key, n);
    return n;
  };
  return {
    current: (key) => map.get(key) ?? 0,
    next: (key) => {
      const run = chain.then(() => write(key));
      chain = run.catch(() => undefined);
      return run;
    },
  };
}

interface Entry {
  readonly key: string;
  readonly id: string;
  readonly options: AgentOptions;
  agent: SDKAgent | undefined;
  readonly leases: Set<AgentLease>;
  idleWaiters: Array<() => void>;
  lastUsed: number;
  disposed: Promise<void> | undefined;
}

type LeaseFn = (agentId: string, options: AgentOptions) => Promise<AgentLease>;

class Pool implements SessionPool {
  readonly #opts: SessionPoolOptions;
  readonly #lease: LeaseFn;
  readonly #gens: GenerationStore;
  readonly #open = new Map<string, Entry>();
  readonly #opening = new Map<string, Promise<Entry>>();
  readonly #resets = new Map<string, Promise<void>>();
  readonly #disposing = new Map<string, Promise<void>>();
  /** Every entry whose agent is not disposed yet, retired ones included. */
  readonly #all = new Set<Entry>();
  #closed = false;
  #sweep: NodeJS.Timeout | undefined;

  constructor(opts: SessionPoolOptions, lease: LeaseFn) {
    this.#opts = opts;
    this.#lease = lease;
    this.#gens = opts.generations ?? memoryGenerations();
    const idleMs = opts.idleMs;
    if (idleMs !== undefined && idleMs > 0) {
      this.#sweep = setInterval(() => this.#sweepIdle(idleMs), Math.max(10, idleMs / 2));
      this.#sweep.unref?.();
    }
  }

  #idFor(key: string): string {
    const gen = this.#gens.current(key);
    return this.#opts.agentId?.(key, gen) ?? `${key}-g${String(gen)}`;
  }

  async lease(key: string): Promise<AgentLease> {
    for (;;) {
      this.#assertOpen(key);
      const wait = this.#resets.get(key) ?? this.#disposing.get(this.#idFor(key));
      if (wait !== undefined) {
        await wait.catch(() => undefined);
        continue;
      }
      const entry = this.#open.get(key) ?? (await this.#openEntry(key));
      const lease = await this.#lease(entry.id, entry.options);
      if (this.#open.get(key) === entry && !this.#closed) return this.#track(entry, lease);
      lease.release();
      this.#assertOpen(key);
    }
  }

  #assertOpen(key: string): void {
    if (this.#closed) throw new SessionPoolClosedError(key);
  }

  #openEntry(key: string): Promise<Entry> {
    const pending = this.#opening.get(key);
    if (pending !== undefined) return pending;
    const p = (async (): Promise<Entry> => {
      const id = this.#idFor(key);
      const existing = this.#open.get(key);
      if (existing !== undefined) return existing;
      const options = await this.#opts.open(key);
      const entry: Entry = {
        key,
        id,
        options,
        agent: undefined,
        leases: new Set(),
        idleWaiters: [],
        lastUsed: Date.now(),
        disposed: undefined,
      };
      if (this.#closed || this.#idFor(key) !== id) return entry; // lease() loop discards it
      this.#open.set(key, entry);
      this.#all.add(entry);
      return entry;
    })();
    this.#opening.set(key, p);
    const clear = () => {
      if (this.#opening.get(key) === p) this.#opening.delete(key);
    };
    p.then(clear, clear);
    return p;
  }

  #track(entry: Entry, inner: AgentLease): AgentLease {
    entry.agent = inner.agent;
    entry.lastUsed = Date.now();
    const lease: AgentLease = {
      agent: inner.agent,
      agentId: inner.agentId,
      release: () => {
        if (!entry.leases.delete(lease)) return;
        inner.release();
        entry.lastUsed = Date.now();
        if (entry.leases.size === 0) this.#notifyIdle(entry);
      },
    };
    entry.leases.add(lease);
    this.#enforceMaxOpen(entry);
    return lease;
  }

  #notifyIdle(entry: Entry): void {
    const waiters = entry.idleWaiters;
    entry.idleWaiters = [];
    for (const w of waiters) w();
  }

  #whenIdle(entry: Entry): Promise<void> {
    if (entry.leases.size === 0) return Promise.resolve();
    return new Promise((resolve) => entry.idleWaiters.push(resolve));
  }

  #disposeEntry(entry: Entry): Promise<void> {
    entry.disposed ??= (async () => {
      try {
        await entry.agent?.dispose();
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        diag(`[theokit-sdk] session pool dispose failed (${entry.id}): ${msg}\n`);
      }
      this.#all.delete(entry);
    })();
    return entry.disposed;
  }

  /** Take the entry of `key` out of the pool; dispose it once no turn holds it. */
  #retire(key: string): void {
    const entry = this.#open.get(key);
    if (entry === undefined) return;
    this.#open.delete(key);
    const done = (async () => {
      await this.#whenIdle(entry);
      await this.#disposeEntry(entry);
    })();
    this.#disposing.set(entry.id, done);
    const clear = () => {
      if (this.#disposing.get(entry.id) === done) this.#disposing.delete(entry.id);
    };
    done.then(clear, clear);
  }

  #oldestUnheld(keep: Entry): Entry | undefined {
    let oldest: Entry | undefined;
    for (const e of this.#open.values()) {
      if (e === keep || e.leases.size > 0) continue;
      if (oldest === undefined || e.lastUsed < oldest.lastUsed) oldest = e;
    }
    return oldest;
  }

  #enforceMaxOpen(keep: Entry): void {
    const max = this.#opts.maxOpen;
    while (max !== undefined && this.#open.size > max) {
      const oldest = this.#oldestUnheld(keep);
      if (oldest === undefined) return;
      this.#retire(oldest.key);
    }
  }

  #sweepIdle(idleMs: number): void {
    const threshold = Date.now() - idleMs;
    for (const e of [...this.#open.values()]) {
      if (e.leases.size === 0 && e.lastUsed <= threshold) this.#retire(e.key);
    }
  }

  reset(key: string): Promise<void> {
    const prev = this.#resets.get(key) ?? Promise.resolve();
    const run = prev.then(async () => {
      await this.#opening.get(key)?.catch(() => undefined);
      await this.#gens.next(key); // a failed write throws before anything is retired
      this.#retire(key);
    });
    this.#resets.set(key, run);
    const clear = () => {
      if (this.#resets.get(key) === run) this.#resets.delete(key);
    };
    run.then(clear, clear);
    return run;
  }

  rebuild(key: string): void {
    this.#retire(key);
  }

  async disposeAll(options: { drainMs?: number } = {}): Promise<{ stillRunning: string[] }> {
    this.#closed = true;
    if (this.#sweep !== undefined) clearInterval(this.#sweep);
    await Promise.allSettled([...this.#resets.values(), ...this.#opening.values()]);
    const entries = [...this.#all];
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, options.drainMs ?? 30_000);
    });
    await Promise.race([Promise.all(entries.map((e) => this.#whenIdle(e))), deadline]);
    clearTimeout(timer);
    const stillRunning = [...new Set(entries.filter((e) => e.leases.size > 0).map((e) => e.key))];
    for (const key of stillRunning) diag(`[theokit-sdk] session pool: ${key} still running\n`);
    await Promise.all(entries.map((e) => this.#disposeEntry(e)));
    this.#open.clear();
    return { stillRunning };
  }
}

/** @internal Built by `Agent.sessionPool`, which passes `Agent.lease`. */
export function createSessionPool(options: SessionPoolOptions, lease: LeaseFn): SessionPool {
  return new Pool(options, lease);
}
