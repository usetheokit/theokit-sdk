import type { EmbeddingRuntime } from "./embedding-adapter.js";
import type { MemoryDb } from "./index-db.js";

/**
 * Vector index helpers (ADR D2 + D4 of memory-system-peer-project-parity).
 *
 * Embeddings live in `embeddings(chunk_id, vec)` — a `vec0` virtual table
 * provided by the sqlite-vec extension. Embedding identity (providerId +
 * model + dimension) lives in the `meta` table; mismatches force a full
 * re-embed sweep (EC-1).
 *
 */

export const META_KEY_PROVIDER_ID = "embedding.providerId";
/** `meta` table key holding the embedding model name. */
export const META_KEY_MODEL = "embedding.model";
/** `meta` table key holding the embedding dimension. */
export const META_KEY_DIMENSION = "embedding.dimension";

/** Identity of the embedding provider, model and dimension that produced the stored vectors. */
export interface EmbeddingIdentity {
  providerId: string;
  model: string;
  dimension: number;
}

/** Read the stored embedding identity, or undefined when none is recorded. */
export function readEmbeddingIdentity(db: MemoryDb): EmbeddingIdentity | undefined {
  const get = (key: string): string | undefined => {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row !== undefined ? String(row.value) : undefined;
  };
  const providerId = get(META_KEY_PROVIDER_ID);
  const model = get(META_KEY_MODEL);
  const dimRaw = get(META_KEY_DIMENSION);
  if (providerId === undefined || model === undefined || dimRaw === undefined) return undefined;
  const dimension = Number(dimRaw);
  if (!Number.isFinite(dimension) || dimension <= 0) return undefined;
  return { providerId, model, dimension };
}

/** Persist the embedding identity in the `meta` table. */
export function writeEmbeddingIdentity(db: MemoryDb, identity: EmbeddingIdentity): void {
  const stmt = db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  stmt.run(META_KEY_PROVIDER_ID, identity.providerId);
  stmt.run(META_KEY_MODEL, identity.model);
  stmt.run(META_KEY_DIMENSION, String(identity.dimension));
}

/** Whether two embedding identities describe the same vector space. */
export function identityMatches(a: EmbeddingIdentity, b: EmbeddingIdentity): boolean {
  return a.providerId === b.providerId && a.model === b.model && a.dimension === b.dimension;
}

/** Drop the `embeddings` vec0 table if present. */
export function dropVectorIndex(db: MemoryDb): void {
  db.exec("DROP TABLE IF EXISTS embeddings");
}

/** Create the `embeddings` vec0 table for vectors of the given dimension. */
export function createVectorIndex(db: MemoryDb, dimension: number): void {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS embeddings USING vec0(
    chunk_id INTEGER PRIMARY KEY,
    vec FLOAT[${dimension}]
  )`);
}

/** Pack a Float32Array into a Buffer suitable for sqlite-vec BLOB binding. */
export function packVector(vec: ReadonlyArray<number>): Buffer {
  const f32 = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) f32[i] = vec[i] ?? 0;
  return Buffer.from(f32.buffer);
}

/** Insert or replace the embedding stored for a chunk. */
export function upsertEmbedding(db: MemoryDb, chunkId: number, vec: ReadonlyArray<number>): void {
  // sqlite-vec vec0 virtual tables don't support UPSERT — emulate via
  // DELETE-then-INSERT. vec0 REJECTS JS Number for chunk_id columns; it
  // requires BigInt binding. Verified via repro against vec0 v0.1.9.
  const id = BigInt(chunkId);
  db.prepare("DELETE FROM embeddings WHERE chunk_id = ?").run(id);
  db.prepare("INSERT INTO embeddings (chunk_id, vec) VALUES (?, ?)").run(id, packVector(vec));
}

/** One nearest-neighbour row returned by a vector search. */
export interface VectorHitRow {
  chunk_id: number;
  distance: number;
}

/** Run a nearest-neighbour search over the stored embeddings. */
export function vectorSearch(
  db: MemoryDb,
  query: ReadonlyArray<number>,
  k: number,
): VectorHitRow[] {
  // sqlite-vec returns distance (lower = closer). Use KNN syntax. k needs
  // a BigInt-typed binding too.
  const rows = db
    .prepare(
      `SELECT chunk_id, distance FROM embeddings
       WHERE vec MATCH ? AND k = ?
       ORDER BY distance`,
    )
    .all(packVector(query), BigInt(k));
  return rows.map((row) => ({ chunk_id: Number(row.chunk_id), distance: Number(row.distance) }));
}

/** Arguments for embedding every chunk that has no vector yet. */
export interface EmbedAllArgs {
  db: MemoryDb;
  runtime: EmbeddingRuntime;
}

/** Embed every chunk that doesn't yet have a vector. */
export async function embedMissingChunks(args: EmbedAllArgs): Promise<number> {
  const rows = args.db
    .prepare(
      `SELECT chunks.id as id, chunks.text as text
       FROM chunks
       LEFT JOIN embeddings ON embeddings.chunk_id = chunks.id
       WHERE embeddings.chunk_id IS NULL`,
    )
    .all();
  if (rows.length === 0) return 0;
  const normalized = rows.map((row) => ({ id: Number(row.id), text: String(row.text ?? "") }));
  const vectors = await args.runtime.embed(normalized.map((r) => r.text));
  for (let i = 0; i < normalized.length; i++) {
    const row = normalized[i];
    const vector = vectors[i];
    if (row === undefined || vector === undefined) continue;
    upsertEmbedding(args.db, row.id, vector);
  }
  return normalized.length;
}
