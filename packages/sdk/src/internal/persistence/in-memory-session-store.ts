import type { SessionRecord } from "../../types/session-record.js";
import type { SessionStore } from "../../types/session-store.js";

/**
 * A {@link SessionStore} whose records live in this object only: nothing is written to disk, and
 * the transcript disappears with the process. Use a fresh instance per agent. Resume works while the
 * same instance is passed again; `dispose` deliberately keeps the records for that reason.
 */
export class InMemorySessionStore implements SessionStore {
  readonly #records = new Map<string, SessionRecord[]>();

  async readRecords(agentId: string): Promise<SessionRecord[]> {
    return (this.#records.get(agentId) ?? []).map((record) => structuredClone(record));
  }

  async appendRecords(agentId: string, records: readonly SessionRecord[]): Promise<void> {
    const list = this.#records.get(agentId) ?? [];
    for (const record of records) list.push(structuredClone(record));
    this.#records.set(agentId, list);
  }
}
