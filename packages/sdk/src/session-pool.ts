import { readFileSync } from "node:fs";
import { GenerationFileError, SessionPoolClosedError } from "./errors.js";
import { atomicWriteJson } from "./internal/persistence/atomic-write.js";
import type { AgentOptions, SDKAgent } from "./types/agent.js";

/** Same shape as `AgentLease`; declared here so this file does not import `agent.ts` (cycle). */
type AgentLease = {
  readonly agent: SDKAgent;
  readonly agentId: string;
  release(): void;
};

/**
 * Generation counter per session key. A new generation means a new agent id, so a conversation
 * starts afresh.
 *
 * @public
 */
export interface GenerationStore {
  current(key: string): number;
  /** Persist and return the next generation. A failed write leaves current() unchanged. */
  next(key: string): Promise<number>;
}

/** In-memory generations, lost on restart. @public */
export function memoryGenerations(): GenerationStore {
  const gens = new Map<string, number>();
  return {
    current: (key) => gens.get(key) ?? 0,
    next: async (key) => {
      const n = (gens.get(key) ?? 0) + 1;
      gens.set(key, n);
      return n;
    },
  };
}

function parseGenerations(file: string, text: string): Map<string, number> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new GenerationFileError(file, "not valid JSON");
  }
  const rec = data as { version?: unknown; generations?: unknown } | null;
  const gens = rec?.generations;
  if (rec?.version !== 1 || typeof gens !== "object" || gens === null || Array.isArray(gens)) {
    throw new GenerationFileError(file, "expected { version: 1, generations }");
  }
  const out = new Map<string, number>();
  for (const [k, v] of Object.entries(gens)) {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      throw new GenerationFileError(file, `generation of "${k}" is not a non-negative integer`);
    }
    out.set(k, v);
  }
  return out;
}

function readGenerations(file: string): Map<string, number> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw err;
  }
  return parseGenerations(file, text);
}

/**
 * Generations persisted to a JSON file (`{ version: 1, generations }`, mode 0600), one write at a
 * time. Throws `GenerationFileError` when `file` exists and is not such a file; it is not modified.
 *
 * @public
 */
export function jsonGenerations(file: string): GenerationStore {
  const gens = readGenerations(file);
  let queue: Promise<unknown> = Promise.resolve();
  const write = async (key: string): Promise<number> => {
    const n = (gens.get(key) ?? 0) + 1;
    const next = new Map(gens).set(key, n);
    const body = { version: 1, generations: Object.fromEntries(next) };
    await atomicWriteJson(file, body, { mode: 0o600 });
    gens.set(key, n);
    return n;
  };
  return {
    current: (key) => gens.get(key) ?? 0,
    next: (key) => {
      const run = queue.then(() => write(key));
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

/** Options for {@link Agent.sessionPool}. @public */
export interface SessionPoolOptions {
  /** Options for the agent of `key`. Called when an agent opens. */
  open(key: string): AgentOptions | Promise<AgentOptions>;
  /** Retire agents nobody holds for this long. Default: never. */
  idleMs?: number;
  /** Retire the least recently used unheld agents beyond this many. Default: unbounded. */
  maxOpen?: number;
  /** Default `memoryGenerations()`. */
  generations?: GenerationStore;
  /** Agent id for a key at a generation. Default `${key}-g${generation}`. */
  agentId?(key: string, generation: number): string;
}

/** One agent per session key, with generations, rebuilds and a drained shutdown. @public */
export interface SessionPool {
  /** Hold the agent of `key`. Waits for a reset or a dispose in progress. */
  lease(key: string): Promise<AgentLease>;
  /** Move `key` to the next generation. A turn in flight finishes on the old agent. */
  reset(key: string): Promise<void>;
  /**
   * Retire the current agent but keep its id: the next lease reopens it with fresh options. That
   * lease waits until the old agent is released and disposed, so release your own lease before
   * calling `lease` again, or it never resolves.
   */
  rebuild(key: string): void;
  /** Refuse new leases, wait up to `drainMs` (default 30 s) for held ones, dispose everything. */
  disposeAll(options?: { drainMs?: number }): Promise<{ stillRunning: string[] }>;
}

/** What the pool needs from `Agent`; injected so this file does not import it at runtime. */
interface PoolHost {
  lease(agentId: string, options: AgentOptions): Promise<AgentLease>;
  registry: { forget(id: string, instance?: object): void };
}

interface Entry {
  readonly key: string;
  readonly id: string;
  readonly options: Promise<AgentOptions>;
  agent?: SDKAgent;
  active: number;
  lastUsed: number;
  retired: boolean;
  disposed: boolean;
  /** Resolves once the retired agent is disposed. */
  done: Promise<void>;
  finish: () => void;
}

const DEFAULT_DRAIN_MS = 30_000;

class Pool implements SessionPool {
  readonly #entries = new Map<string, Entry>();
  readonly #retiring = new Map<string, Promise<void>>();
  readonly #resets = new Map<string, Promise<void>>();
  readonly #idleWaiters = new Set<() => void>();
  readonly #generations: GenerationStore;
  #closed = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly options: SessionPoolOptions,
    private readonly host: PoolHost,
  ) {
    this.#generations = options.generations ?? memoryGenerations();
    const idleMs = options.idleMs;
    if (idleMs !== undefined && idleMs > 0) {
      this.#timer = setInterval(() => this.#sweep(), Math.max(10, Math.floor(idleMs / 2)));
      this.#timer.unref();
    }
  }

  #idFor(key: string): string {
    const gen = this.#generations.current(key);
    return this.options.agentId?.(key, gen) ?? `${key}-g${String(gen)}`;
  }

  /** Wait for a reset on `key` and a dispose on its id; returns the id to use. */
  async #settle(key: string): Promise<string> {
    for (;;) {
      if (this.#closed) throw new SessionPoolClosedError(key);
      const reset = this.#resets.get(key);
      if (reset !== undefined) {
        await reset.catch(() => undefined);
        continue;
      }
      const id = this.#idFor(key);
      const disposing = this.#retiring.get(id);
      if (disposing === undefined) return id;
      await disposing;
    }
  }

  #entryFor(key: string, id: string): Entry {
    const existing = this.#entries.get(id);
    if (existing !== undefined) return existing;
    let finish = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const options = Promise.resolve().then(() => this.options.open(key));
    options.catch(() => undefined);
    const entry: Entry = {
      key,
      id,
      options,
      active: 0,
      lastUsed: Date.now(),
      retired: false,
      disposed: false,
      done,
      finish,
    };
    this.#entries.set(id, entry);
    return entry;
  }

  async lease(key: string): Promise<AgentLease> {
    const id = await this.#settle(key);
    const entry = this.#entryFor(key, id);
    entry.active += 1;
    this.#sweep();
    let inner: AgentLease;
    try {
      inner = await this.host.lease(id, await entry.options);
    } catch (err) {
      if (this.#entries.get(id) === entry && entry.agent === undefined) this.#entries.delete(id);
      this.#unhold(entry);
      throw err;
    }
    if (this.#closed || entry.disposed) {
      // disposeAll ran during the build: it could not see this agent, so close it here.
      this.host.registry.forget(id, inner.agent);
      inner.release();
      this.#unhold(entry);
      await inner.agent.dispose().catch(() => undefined);
      throw new SessionPoolClosedError(key);
    }
    entry.agent = inner.agent;
    // A retire that ran during the build cannot see an agent that did not exist yet.
    if (entry.retired) this.host.registry.forget(id, inner.agent);
    return this.#wrap(entry, inner);
  }

  #wrap(entry: Entry, inner: AgentLease): AgentLease {
    let released = false;
    return {
      agent: inner.agent,
      agentId: inner.agentId,
      release: () => {
        if (released) return;
        released = true;
        inner.release();
        this.#unhold(entry);
      },
    };
  }

  #unhold(entry: Entry): void {
    entry.active -= 1;
    entry.lastUsed = Date.now();
    if (entry.active > 0) return;
    if (entry.retired) void this.#dispose(entry);
    else this.#sweep();
    if (this.#totalActive() === 0) for (const w of [...this.#idleWaiters]) w();
  }

  #totalActive(): number {
    let n = 0;
    for (const e of this.#entries.values()) n += e.active;
    for (const e of this.#retiredEntries) n += e.active;
    return n;
  }

  readonly #retiredEntries = new Set<Entry>();

  async #dispose(entry: Entry): Promise<void> {
    if (entry.disposed) return;
    entry.disposed = true;
    try {
      await entry.agent?.dispose();
    } catch {
      // Disposal is cleanup; a failure must not break the pool.
    } finally {
      this.#retiredEntries.delete(entry);
      if (this.#retiring.get(entry.id) === entry.done) this.#retiring.delete(entry.id);
      entry.finish();
    }
  }

  /** Take an entry out of service. Disposed once no lease holds it. */
  #retire(entry: Entry): void {
    if (entry.retired) return;
    entry.retired = true;
    if (this.#entries.get(entry.id) === entry) this.#entries.delete(entry.id);
    this.#retiredEntries.add(entry);
    this.#retiring.set(entry.id, entry.done);
    if (entry.agent !== undefined) this.host.registry.forget(entry.id, entry.agent);
    if (entry.active === 0) void this.#dispose(entry);
  }

  async reset(key: string): Promise<void> {
    const prev = this.#resets.get(key);
    const run = (async () => {
      await prev?.catch(() => undefined);
      const old = this.#entries.get(this.#idFor(key));
      await this.#generations.next(key);
      if (old !== undefined) this.#retire(old);
    })();
    this.#resets.set(key, run);
    try {
      await run;
    } finally {
      if (this.#resets.get(key) === run) this.#resets.delete(key);
    }
  }

  rebuild(key: string): void {
    const entry = this.#entries.get(this.#idFor(key));
    if (entry !== undefined) this.#retire(entry);
  }

  #sweep(): void {
    const unheld = [...this.#entries.values()].filter((e) => e.active === 0);
    const idleMs = this.options.idleMs;
    const now = Date.now();
    if (idleMs !== undefined && idleMs > 0) {
      for (const e of unheld) if (now - e.lastUsed >= idleMs) this.#retire(e);
    }
    const max = this.options.maxOpen;
    if (max === undefined) return;
    const live = unheld.filter((e) => !e.retired).sort((a, b) => a.lastUsed - b.lastUsed);
    const excess = this.#entries.size - max;
    for (const e of live.slice(0, Math.max(0, excess))) this.#retire(e);
  }

  async #drain(drainMs: number): Promise<void> {
    if (this.#totalActive() === 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, drainMs);
      const waiter = () => done();
      function done(): void {
        clearTimeout(timer);
        resolve();
      }
      this.#idleWaiters.add(waiter);
    });
    this.#idleWaiters.clear();
  }

  async disposeAll(options: { drainMs?: number } = {}): Promise<{ stillRunning: string[] }> {
    this.#closed = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    await this.#drain(options.drainMs ?? DEFAULT_DRAIN_MS);
    const all = [...this.#entries.values(), ...this.#retiredEntries];
    const stillRunning = [...new Set(all.filter((e) => e.active > 0).map((e) => e.key))];
    for (const e of [...this.#entries.values()]) this.#retire(e);
    // Held agents are disposed now too: the deadline passed.
    await Promise.all([...this.#retiredEntries].map((e) => this.#dispose(e)));
    return { stillRunning };
  }
}

/** @internal */
export function createSessionPool(options: SessionPoolOptions, host: PoolHost): SessionPool {
  return new Pool(options, host);
}
