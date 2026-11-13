/**
 * Every SQL string the memory index runs, in one place.
 *
 * `IndexManager` answered four questions with four independent reasons to change: the corpus walk,
 * the BM25-to-score normalisation, the vector-cache strategy, and the schema. This is the fourth.
 * Changing a column, an index or a join is now a change to THIS file, and the caller above it reads
 * as search logic rather than as SQL with scoring in between.
 *
 * The row-to-`MemorySearchHit` mapping deliberately stays with the caller: turning a row into a hit
 * involves a score, a snippet and a citation, none of which the schema knows about. Keeping it here
 * would move the normalisation into the repository and re-create the same mixture one layer down.
 *
 * Rows come back as `Record<string, unknown>` for the same reason: the repository knows what it
 * SELECTed, not what the caller will make of it.
 *
 * @internal
 */

import type { MemoryDb } from "./index-db.js";

/** What `files` holds for one path — the pair the corpus walk compares against disk. */
export interface FileRow {
  readonly id: number;
  readonly hash: string;
}

export class MemoryIndexRepository {
  constructor(private readonly db: MemoryDb) {}

  counts(): { files: number; chunks: number } {
    const files = this.db.prepare("SELECT COUNT(*) as n FROM files").get() ?? { n: 0 };
    const chunks = this.db.prepare("SELECT COUNT(*) as n FROM chunks").get() ?? { n: 0 };
    return { files: Number(files.n ?? 0), chunks: Number(chunks.n ?? 0) };
  }

  /**
   * FTS5 match, ordered by bm25. THROWS on an FTS5 error rather than swallowing it — whether that
   * error means "CJK input the default tokenizer cannot segment" or "the table is missing" is a
   * judgement the caller makes, and it makes it differently for each.
   */
  ftsRows(sanitizedQuery: string, limit: number): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT chunks.id as id, files.rel_path as rel_path, files.source as source,
                chunks.start_line as start_line, chunks.end_line as end_line,
                chunks.text as text, bm25(chunks_fts) as bm25_score
         FROM chunks_fts
         JOIN chunks ON chunks_fts.rowid = chunks.id
         JOIN files  ON chunks.file_id = files.id
         WHERE chunks_fts MATCH ?
         ORDER BY bm25_score
         LIMIT ?`,
      )
      .all(sanitizedQuery, limit);
  }

  /** Substring scan — the CJK fallback. No relevance score exists here; the caller supplies one. */
  likeRows(escapedPattern: string, limit: number): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT chunks.id as id, files.rel_path as rel_path, files.source as source,
                chunks.start_line as start_line, chunks.end_line as end_line,
                chunks.text as text
         FROM chunks
         JOIN files ON chunks.file_id = files.id
         WHERE chunks.text LIKE ? ESCAPE '\\'
         LIMIT ?`,
      )
      .all(escapedPattern, limit) as Array<Record<string, unknown>>;
  }

  /** Hydrate the chunks a vector search returned by id. Empty in, empty out — no query runs. */
  chunkRowsByIds(ids: ReadonlyArray<number>): Array<Record<string, unknown>> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT chunks.id as id, files.rel_path as rel_path, files.source as source,
                chunks.start_line as start_line, chunks.end_line as end_line,
                chunks.text as text
         FROM chunks JOIN files ON chunks.file_id = files.id
         WHERE chunks.id IN (${placeholders})`,
      )
      .all(...ids);
  }

  /** Absolute path → its row, for the corpus walk to compare hashes against disk. */
  filesByPath(): Map<string, FileRow> {
    const rows = this.db.prepare("SELECT id, path, hash FROM files").all() as Array<{
      id: number;
      path: string;
      hash: string;
    }>;
    return new Map(rows.map((row) => [row.path, { id: row.id, hash: row.hash }]));
  }

  upsertFile(file: {
    absPath: string;
    relPath: string;
    hash: string;
    mtimeMs: number;
    source: "memory" | "wiki" | "sessions";
  }): number {
    const row = this.db
      .prepare(
        `INSERT INTO files (path, rel_path, mtime, hash, source) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, mtime = excluded.mtime, source = excluded.source
         RETURNING id`,
      )
      .get(file.absPath, file.relPath, Math.floor(file.mtimeMs), file.hash, file.source) as {
      id: number;
    };
    return row.id;
  }

  /** Drop a file the corpus no longer contains, with its chunks (and so their FTS rows). */
  deleteFile(fileId: number): void {
    this.deleteChunksForFile(fileId);
    this.db.prepare("DELETE FROM files WHERE id = ?").run(fileId);
  }

  deleteChunksForFile(fileId: number): void {
    this.db.prepare("DELETE FROM chunks WHERE file_id = ?").run(fileId);
  }

  insertChunk(chunk: {
    fileId: number;
    startLine: number;
    endLine: number;
    text: string;
    hash: string;
  }): void {
    this.db
      .prepare(
        "INSERT INTO chunks (file_id, start_line, end_line, text, hash) VALUES (?, ?, ?, ?, ?)",
      )
      .run(chunk.fileId, chunk.startLine, chunk.endLine, chunk.text, chunk.hash);
  }

  close(): void {
    this.db.close();
  }
}
