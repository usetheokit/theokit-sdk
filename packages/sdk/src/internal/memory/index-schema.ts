/**
 * SQLite schema for the memory index.
 *
 * Tables:
 *   - files      — one row per indexed markdown file (path, mtime, hash).
 *   - chunks     — one row per chunk produced by `chunkMarkdown`.
 *   - chunks_fts — FTS5 virtual table mirroring chunks.text for BM25 search.
 *   - meta       — key/value store; persists the active embedding identity
 *                  (provider id, model, dimension) so we detect when the
 *                  index was built against a different embedding setup.
 *   - embeddings — sqlite-vec virtual table holding the chunk vectors
 *                  (created on demand by `vec-index.ts`).
 *
 */

export const SCHEMA_STATEMENTS: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS files (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     path TEXT UNIQUE NOT NULL,
     rel_path TEXT NOT NULL,
     mtime INTEGER NOT NULL,
     hash TEXT NOT NULL,
     source TEXT NOT NULL DEFAULT 'memory'
   )`,
  `CREATE TABLE IF NOT EXISTS chunks (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
     start_line INTEGER NOT NULL,
     end_line INTEGER NOT NULL,
     text TEXT NOT NULL,
     hash TEXT NOT NULL,
     session_key TEXT
   )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
     text,
     content='chunks',
     content_rowid='id'
   )`,
  `CREATE TRIGGER IF NOT EXISTS chunks_fts_insert AFTER INSERT ON chunks BEGIN
     INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
   END`,
  `CREATE TRIGGER IF NOT EXISTS chunks_fts_delete AFTER DELETE ON chunks BEGIN
     INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
   END`,
  `CREATE TABLE IF NOT EXISTS meta (
     key TEXT PRIMARY KEY,
     value TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_chunks_file_id ON chunks(file_id)`,
];

/**
 * Non-WAL pragmas. WAL is applied separately via
 * `applyWalWithFallback` (T4.2, ADR D63) so NFS/SMB users get a graceful
 * DELETE fallback instead of crashing.
 */
export const PRAGMA_STATEMENTS: ReadonlyArray<string> = [
  "PRAGMA synchronous=NORMAL",
  "PRAGMA foreign_keys=ON",
];
