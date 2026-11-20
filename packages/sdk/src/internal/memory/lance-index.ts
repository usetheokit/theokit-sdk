import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

import { ConfigurationError } from "../../errors.js";
import type { EmbeddingRuntime } from "./embedding-adapter.js";
import { type MemoryRoot, resolveMemoryRoot } from "./storage/memory-root.js";

/**
 * LanceDB-backed memory index (ADR D43). Implements the same logical
 * interface as `IndexManager` but stores embeddings in Lance's columnar
 * vector-aware file format — scalable to 100k+ facts.
 *
 * Opt-in via `Memory.create({ index: { backend: "lance" } })`. SQLite
 * remains the default; this code path only activates when explicitly
 * requested AND `@lancedb/lancedb` is installed.
 *
 * EC-1 MUST FIX: filters use Lance structured filter API (object form) —
 * NEVER string interpolation. SQL injection via namespace is impossible.
 *
 * EC-8: embedding dimension is validated when opening an existing table.
 *
 * Shared with `@theokit/sdk-memory`; see the memory-store barrel.
 */

interface LanceModule {
  connect: (uri: string) => Promise<LanceConnection>;
}

interface LanceConnection {
  openTable: (name: string) => Promise<LanceTable>;
  createTable: (name: string, data: ReadonlyArray<LanceFactRecord>) => Promise<LanceTable>;
  tableNames: () => Promise<string[]>;
}

interface LanceTable {
  add: (rows: ReadonlyArray<LanceFactRecord>) => Promise<void>;
  search: (vector: ReadonlyArray<number>) => LanceQuery;
  delete: (predicate: string) => Promise<void>;
  checkoutLatest: () => Promise<void>;
  addColumns: (transforms: ReadonlyArray<{ name: string; valueSql: string }>) => Promise<unknown>;
  countRows: () => Promise<number>;
  // EC-8: schema introspection for dimension check.
  schema: () => Promise<{
    fields: ReadonlyArray<{
      name: string;
      // Lance 0.30 returns Apache Arrow Field. FixedSizeList type has
      // `listSize`, not `fixedSize`. typeId=16 = FixedSizeList in Arrow.
      type: { listSize?: number; fixedSize?: number };
    }>;
  }>;
}

interface LanceQuery {
  where: (filter: string | Record<string, unknown>) => LanceQuery;
  limit: (n: number) => LanceQuery;
  toArray: () => Promise<ReadonlyArray<LanceFactRecord & { _distance?: number }>>;
}

/**
 * One row of the Lance `facts` table, as it is stored. Field names are the
 * on-disk column names, which is why `user_id` is snake_case here while the
 * search result reports `userId`.
 *
 * `embedding` must be exactly as wide as the table was created with; the width
 * is fixed by the embedding runtime on the first open and checked on every
 * later one.
 */
export interface LanceFactRecord {
  id: string;
  text: string;
  source: "memory" | "sessions" | "wiki";
  embedding: ReadonlyArray<number>;
  namespace: string;
  scope: string;
  user_id: string;
  timestamp: number;
  /**
   * The fact this row is a chunk of. Rows of one split fact share it, so `removeFacts(<fact>)`
   * finds them without guessing from the id. Defaults to `id` on write; rows written before this
   * column existed have it NULL (no link is guessed) and are removed by exact id only.
   */
  fact_id?: string;
}

/**
 * Options for `LanceIndex.open`. The embedding runtime is required, not
 * optional: Lance here is vector-only, so there is no text-search fallback to
 * open without one.
 */
export interface OpenLanceOptions {
  cwd: string;
  /** The resolved memory root. Defaults to `<cwd>/.theokit/memory` (#463). */
  memoryRoot?: MemoryRoot;
  embedding: EmbeddingRuntime;
  /** Override storage location. Default: `<memory root>/lance/`. */
  storagePath?: string;
}

/**
 * Filters for `LanceIndex.search`. `namespace` is required and `scope` is
 * optional; both are applied as a SQL predicate inside Lance. `sources` is
 * applied in this process, after the rows come back, so it narrows the result
 * without narrowing what `limit` counted.
 */
export interface LanceSearchOptions {
  namespace: string;
  scope?: string;
  limit?: number;
  sources?: ReadonlyArray<"memory" | "sessions" | "wiki">;
}

/**
 * One Lance search result. `score` is a similarity in `(0, 1]` derived from
 * Lance's distance as `1 / (1 + distance)`, so higher is better, the opposite
 * direction from the raw distance Lance returns.
 */
export interface LanceSearchHit {
  id: string;
  text: string;
  source: "memory" | "sessions" | "wiki";
  namespace: string;
  scope: string;
  userId: string;
  score: number;
}

/**
 * Lazily load `@lancedb/lancedb`. Throws typed error when absent.
 *
 * @internal
 */
function requireLance(): LanceModule {
  try {
    const r = createRequire(import.meta.url);
    return r("@lancedb/lancedb") as LanceModule;
  } catch (cause) {
    throw new ConfigurationError(
      "Lance backend selected but `@lancedb/lancedb` is not installed. " +
        'Install with: `pnpm add @lancedb/lancedb`. SQLite remains available as the default (omit `backend: "lance"`).',
      { code: "lance_backend_unavailable", cause },
    );
  }
}

const WRITE_QUEUES = new Map<string, Promise<unknown>>();
let nextAnonymousKey = 0;

/**
 * Lance-backed memory index. Public API mirrors the SQLite one logically:
 * `addFacts`, `search`, `countFacts`, `removeFacts`, `close`.
 *
 * Shared with `@theokit/sdk-memory` through the memory-store barrel, so it carries no visibility
 * tag: naming that tag in this block would delete the declaration below it (#463).
 */
export class LanceIndex {
  private constructor(
    private readonly table: LanceTable,
    private readonly embedding: EmbeddingRuntime,
    private readonly embeddingDim: number,
    /** Identity of the storage the table lives in; instances sharing it share one write queue. */
    private readonly queueKey: string = `anonymous:${nextAnonymousKey++}`,
  ) {
    openIndexes.add(this);
  }

  /**
   * Adds and removals on one storage path run one at a time, in call order, even across several
   * `LanceIndex` objects opened on that path in this process (not across processes).
   */
  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const tail = WRITE_QUEUES.get(this.queueKey) ?? Promise.resolve();
    const run = tail.then(task, task);
    const next = run.catch(() => undefined);
    WRITE_QUEUES.set(this.queueKey, next);
    void next.then(() => {
      if (WRITE_QUEUES.get(this.queueKey) === next) WRITE_QUEUES.delete(this.queueKey);
    });
    return run;
  }

  static async open(opts: OpenLanceOptions): Promise<LanceIndex> {
    const lance = requireLance();
    const storagePath =
      opts.storagePath ?? lanceStoragePath(opts.memoryRoot ?? resolveMemoryRoot(opts.cwd));
    mkdirSync(storagePath, { recursive: true });
    const conn = await lance.connect(storagePath);
    const dim = opts.embedding.dimension;
    const tableName = "facts";
    const existing = await conn.tableNames();
    let table: LanceTable;
    if (existing.includes(tableName)) {
      table = await conn.openTable(tableName);
      // EC-8: validate embedding dimension matches what's in storage.
      // Lance 0.30 uses Apache Arrow FixedSizeList type — the size lives
      // in `type.listSize` (older API used `fixedSize`; we read both for
      // forward/backward safety).
      const schema = await table.schema();
      if (!schema.fields.some((f) => f.name === "fact_id")) {
        // Existing rows get NULL: no parent link is guessed for them.
        await table.addColumns([{ name: "fact_id", valueSql: "cast(NULL as string)" }]);
      }
      const embField = schema.fields.find((f) => f.name === "embedding");
      const existingDim = embField?.type?.listSize ?? embField?.type?.fixedSize;
      if (typeof existingDim === "number" && existingDim !== dim) {
        throw new ConfigurationError(
          `Embedding dimension mismatch in Lance index: storage has ${existingDim}-dim vectors, current provider yields ${dim}-dim. Re-embed with \`migrateSqliteToLance\` after switching providers, or use a different storagePath.`,
          { code: "embedding_dimension_mismatch" },
        );
      }
    } else {
      // Create with one bootstrap record. Lance requires an initial row to
      // infer schema; we delete the bootstrap immediately.
      const bootstrap: LanceFactRecord = {
        id: "__bootstrap__",
        text: "",
        source: "memory",
        embedding: new Array(dim).fill(0),
        namespace: "__bootstrap__",
        scope: "__bootstrap__",
        user_id: "__bootstrap__",
        timestamp: 0,
        fact_id: "__bootstrap__",
      };
      table = await conn.createTable(tableName, [bootstrap]);
      await table.delete("namespace = '__bootstrap__'");
    }
    return new LanceIndex(table, opts.embedding, dim, resolve(storagePath));
  }

  async addFacts(facts: ReadonlyArray<Omit<LanceFactRecord, "embedding">>): Promise<void> {
    if (facts.length === 0) return;
    // Serialized with `removeFacts`: a removal issued while this add is embedding runs after the
    // rows land, so it deletes them instead of being overtaken.
    await this.serialized(() => this.addFactsNow(facts));
  }

  private async addFactsNow(
    facts: ReadonlyArray<Omit<LanceFactRecord, "embedding">>,
  ): Promise<void> {
    const texts = facts.map((f) => f.text);
    const embeddings = await this.embedding.embed(texts);
    const rows: LanceFactRecord[] = facts.map(({ fact_id, ...f }, i) => ({
      ...f,
      fact_id: fact_id ?? f.id,
      embedding: embeddings[i] ?? new Array(this.embeddingDim).fill(0),
    }));
    await this.table.add(rows);
  }

  /**
   * Search facts by semantic similarity. EC-1: filters use Lance's
   * structured object filter — NEVER string interpolation.
   */
  async search(query: string, opts: LanceSearchOptions): Promise<LanceSearchHit[]> {
    const [embedding] = await this.embedding.embed([query]);
    if (embedding === undefined) return [];
    // EC-1 (lancedb-backend-ship-v1-1 integration test caught this 2026-05-31):
    // Lance 0.30.0's `.where()` accepts SQL STRING only, NOT object filter —
    // contrary to D43's original assumption. We build the SQL string with
    // single-quote escaping (`'` → `''`) to neutralize injection. This is
    // the standard SQL string-literal escape; bind parameters are not
    // supported in Lance's predicate API. Backed by integration test
    // `injection attempt in namespace does not break filter` (test 7).
    const predicates: string[] = [`namespace = '${escapeSqlValue(opts.namespace)}'`];
    if (opts.scope !== undefined) {
      predicates.push(`scope = '${escapeSqlValue(opts.scope)}'`);
    }
    let q = this.table.search(embedding).where(predicates.join(" AND "));
    if (opts.limit !== undefined) q = q.limit(opts.limit);
    const results = await q.toArray();
    return results
      .filter((r) => opts.sources === undefined || opts.sources.includes(r.source))
      .map((r) => ({
        id: r.id,
        text: r.text,
        source: r.source,
        namespace: r.namespace,
        scope: r.scope,
        userId: r.user_id,
        // Lower _distance = better match; normalize to 0..1 (1=best).
        score: 1 / (1 + (r._distance ?? 1)),
      }));
  }

  async countFacts(namespace: string): Promise<number> {
    // Total count, regardless of namespace, used by migration validation.
    // For per-namespace count, callers can do a where() + countRows() if
    // Lance supports it; v1.2 ships with global count only.
    void namespace;
    return this.table.countRows();
  }

  /**
   * Remove facts by id. Without `scope` this is the exact-id deletion it always was. With `scope`
   * it removes every row of that namespace AND source whose `fact_id` is the id (a split fact's
   * chunks share it), linked by `fact_id` and never by id shape, so a same-named row owned by
   * another namespace or source (a note, a wiki page) survives. Rows that predate `fact_id` (NULL)
   * match only by exact id. Runs after any add already queued on this storage path, including adds
   * from other `LanceIndex` objects opened on it.
   */
  async removeFacts(
    ids: ReadonlyArray<string>,
    scope?: { namespace: string; source: "memory" | "sessions" | "wiki" },
  ): Promise<void> {
    if (ids.length === 0) return;
    const where = [
      `(${ids
        .map((id) =>
          scope === undefined
            ? `id = '${idLiteral(id)}'`
            : `fact_id = '${idLiteral(id)}' OR (fact_id IS NULL AND id = '${idLiteral(id)}')`,
        )
        .join(" OR ")})`,
      ...(scope
        ? [
            `namespace = '${escapeSqlValue(scope.namespace)}'`,
            `source = '${escapeSqlValue(scope.source)}'`,
          ]
        : []),
    ].join(" AND ");
    await this.serialized(async () => {
      // A table handle reads the version it opened; another handle on this path may have added since.
      await this.table.checkoutLatest();
      await this.table.delete(where);
    });
  }

  /** True when this index's storage lives at `path` (a resolved absolute path). */
  storedAt(path: string): boolean {
    return this.queueKey === path;
  }

  async close(): Promise<void> {
    openIndexes.delete(this);
    // Lance auto-closes on GC; no explicit shutdown needed.
  }
}

/**
 * An id as a Lance string literal: control characters rejected, `'` doubled, and nothing else
 * touched. Lance literals have no backslash escape, so unlike `escapeSqlValue` this keeps `\\`
 * as the one character it is; the stored id then matches itself.
 */
function idLiteral(value: string): string {
  escapeSqlValue(value);
  return value.replace(/'/g, "''");
}

/**
 * T5.2 — Harden SQL value escaping for Lance `.where()` predicates.
 *
 * Pre-T5.2 this only escaped single quotes (`'` → `''`). T5.2 adds:
 * - NUL byte rejection (NUL truncates the string in some SQL engines)
 * - C0 control char rejection (prevents invisible payload injection)
 * - Backslash escaping (`\` → `\\` — some engines interpret `\'` as
 *   a single-quote escape, bypassing the `''` defense)
 *
 * Throws `ConfigurationError` on NUL/control to surface the attack
 * honestly rather than silently corrupting the query.
 */
function escapeSqlValue(value: string): string {
  // Reject NUL + C0/DEL control chars (T5.5 pattern adapted for SQL).
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x00 || (code >= 0x01 && code <= 0x1f) || code === 0x7f) {
      throw new ConfigurationError(
        `SQL filter value contains control character at position ${i} (0x${code.toString(16)}). ` +
          "This may indicate an injection attempt.",
        { code: "sql_injection_blocked" },
      );
    }
  }
  // Escape both single-quote and backslash.
  return value.replace(/\\/g, "\\\\").replace(/'/g, "''");
}

/**
 * Test helper for {@link LanceIndex}: indicates whether the Lance module
 * is loadable in the current environment. Allows tests to gracefully skip
 * when the optional dep is absent.
 *
 * Shared with `@theokit/sdk-memory` through the memory-store barrel, so it carries no visibility
 * tag: naming that tag in this block would delete the declaration below it (#463).
 */
export function isLanceAvailable(): boolean {
  try {
    const r = createRequire(import.meta.url);
    r("@lancedb/lancedb");
    return true;
  } catch {
    return false;
  }
}

/**
 * `<memory root>/lance`.
 *
 * Takes the RESOLVED ROOT. This used to spell the default layout out again as a string literal,
 * beside a second copy of the same literal in `open()` — two more answers to "where does memory
 * live?" that no `memoryDir` search would have surfaced (#463).
 *
 * Shared with `@theokit/sdk-memory` through the memory-store barrel, so it carries no
 * visibility tag — naming that tag in this block would delete the function below it (#463).
 */
export function lanceStoragePath(root: MemoryRoot): string {
  return join(root, "lance");
}

/** Every `LanceIndex` currently open in this process. */
const openIndexes = new Set<LanceIndex>();

/**
 * Called by `agent.memory.delete` with the agent's memory root: removes the fact's rows (source
 * `memory`, the given namespace) from the Lance index stored under THAT root only, via
 * `removeFacts`, which runs after any add already queued on the same storage path. Another agent's
 * index (a different root) is never touched. No-op when no index is open on the root.
 *
 * Association: `factId` is matched against the rows' `fact_id` (exact `id` for rows without one).
 * `agent.memory.delete` passes the adapter's `MemoryId` (e.g. `"a:42"`), so a writer that indexes
 * an agent-memory fact must store it with `fact_id` = that MemoryId. Legacy chunks that carry no
 * `fact_id` (e.g. migrated from SQLite) are removed only when their exact id equals `factId`.
 * A failure is thrown after all matching indexes were attempted.
 */
export async function forgetFactInOpenIndexes(
  root: MemoryRoot,
  factId: string,
  namespace: string,
): Promise<void> {
  const path = resolve(lanceStoragePath(root));
  // Instances on one path share a table; one removal covers them all.
  const target = [...openIndexes].find((i) => i.storedAt(path));
  if (target === undefined) return;
  await target.removeFacts([factId], { namespace, source: "memory" });
}
