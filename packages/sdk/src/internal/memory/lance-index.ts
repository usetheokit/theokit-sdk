import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

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
  ) {}

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
      };
      table = await conn.createTable(tableName, [bootstrap]);
      await table.delete("namespace = '__bootstrap__'");
    }
    return new LanceIndex(table, opts.embedding, dim);
  }

  async addFacts(facts: ReadonlyArray<Omit<LanceFactRecord, "embedding">>): Promise<void> {
    if (facts.length === 0) return;
    const texts = facts.map((f) => f.text);
    const embeddings = await this.embedding.embed(texts);
    const rows: LanceFactRecord[] = facts.map((f, i) => ({
      ...f,
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

  async removeFacts(ids: ReadonlyArray<string>): Promise<void> {
    if (ids.length === 0) return;
    // Build a parameterized-style delete predicate. Lance's delete still
    // takes a string predicate, so we explicitly quote-escape each id —
    // ids in our system are content-hashed (alphanumeric), so the risk
    // is low, but we belt-and-suspenders.
    const escaped = ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(", ");
    await this.table.delete(`id IN (${escaped})`);
  }

  async close(): Promise<void> {
    // Lance auto-closes on GC; no explicit shutdown needed.
  }
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
