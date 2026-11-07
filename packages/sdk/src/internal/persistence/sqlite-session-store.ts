import type { SessionRecord, SessionStore } from "../../types/session-store.js";
import { openSqliteResilient, type ResilientSqliteDb } from "./sqlite-open.js";

/** Options for {@link SqliteSessionStore}. */
export interface SqliteSessionStoreOptions {
  /** Absolute path of the SQLite file. Parent directories are created. */
  filePath: string;
}

interface Stmt {
  run(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
}
interface Db extends ResilientSqliteDb {
  prepare(sql: string): Stmt;
}

/**
 * A {@link SessionStore} that keeps the native session records in one SQLite file instead of
 * per-agent JSONL transcripts. Pass it as `local.sessionStore`.
 *
 * Uses `better-sqlite3` when installed, else the built-in `node:sqlite` (Node 22.5+).
 * Appends are one transaction, so a batch lands whole or not at all; order is the
 * autoincrement `seq`. Corruption is NOT silently rebuilt: opening a corrupt file throws.
 *
 * @public
 */
export class SqliteSessionStore implements SessionStore {
  private readonly filePath: string;
  private dbPromise: Promise<Db> | undefined;

  constructor(options: SqliteSessionStoreOptions) {
    this.filePath = options.filePath;
  }

  private db(): Promise<Db> {
    this.dbPromise ??= openSqliteResilient<Db>({
      filePath: this.filePath,
      label: "session-store",
      recoverCorrupt: false,
      onOpen: (db) => {
        db.exec(
          "CREATE TABLE IF NOT EXISTS session_records (seq INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, record TEXT NOT NULL);" +
            "CREATE INDEX IF NOT EXISTS session_records_agent ON session_records (agent_id, seq);",
        );
      },
    });
    this.dbPromise.catch(() => {
      this.dbPromise = undefined; // allow retry after a failed open
    });
    return this.dbPromise;
  }

  async readRecords(agentId: string): Promise<SessionRecord[]> {
    const db = await this.db();
    const rows = db
      .prepare("SELECT record FROM session_records WHERE agent_id = ? ORDER BY seq")
      .all(agentId) as { record: string }[];
    return rows.map((r) => JSON.parse(r.record) as SessionRecord);
  }

  async appendRecords(agentId: string, records: readonly SessionRecord[]): Promise<void> {
    if (records.length === 0) return;
    const db = await this.db();
    const insert = db.prepare("INSERT INTO session_records (agent_id, record) VALUES (?, ?)");
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const rec of records) insert.run(agentId, JSON.stringify(rec));
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  async dispose(): Promise<void> {
    const p = this.dbPromise;
    this.dbPromise = undefined;
    if (p) (await p).close();
  }
}
