/**
 * Snapshot store interface + InMemory and JsonFile backends (ADR D235).
 *
 * EC-4 absorbed: serialization happens here. `JSON.stringify` failure raises
 * `WorkflowNotSerializableError` instead of letting the underlying `TypeError`
 * leak.
 *
 * @internal
 */

import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkflowOptions, WorkflowSnapshot } from "../../types/workflow.js";
import { WorkflowNotSerializableError } from "../../workflow-errors.js";
import { atomicWriteText } from "../persistence/atomic-write.js";
import { safeFilenameForId } from "../security/path-guard.js";

/** One stored checkpoint (`keepHistory`). `runInput` is kept on the first entry of a run only. */
export interface WorkflowHistoryEntry {
  runId: string;
  workflowName: string;
  stepId: string;
  output: unknown;
  state?: unknown;
  at: number;
  runInput?: unknown;
}

function serializeEntry(entry: WorkflowHistoryEntry): string {
  try {
    return JSON.stringify(entry);
  } catch (err) {
    throw new WorkflowNotSerializableError(
      entry.stepId,
      err instanceof Error ? err : new Error(String(err)),
    );
  }
}

export interface WorkflowSnapshotListing {
  runId: string;
  workflowName: string;
  suspendedAt: number;
  status: "suspended" | "running";
  currentStepId: string;
}

function toListing(s: WorkflowSnapshot): WorkflowSnapshotListing {
  return {
    runId: s.runId,
    workflowName: s.workflowName,
    suspendedAt: s.suspendedAt,
    status: s.status ?? "suspended",
    currentStepId: s.currentStepId,
  };
}

export interface WorkflowSnapshotStore {
  save(snapshot: WorkflowSnapshot): Promise<void>;
  load(runId: string): Promise<WorkflowSnapshot | undefined>;
  delete(runId: string): Promise<void>;
  list(workflowName?: string): Promise<ReadonlyArray<WorkflowSnapshotListing>>;
  /** Append a checkpoint to the run's history (copied, so later mutation cannot change it). */
  appendHistory(entry: WorkflowHistoryEntry): Promise<void>;
  /** The run's checkpoints, oldest first; empty when none. */
  history(runId: string): Promise<ReadonlyArray<WorkflowHistoryEntry>>;
}

/** The first entry of a run keeps the run's input; later ones drop it. */
function entryForIndex(entry: WorkflowHistoryEntry, index: number): string {
  if (index === 0 || entry.runInput === undefined) return serializeEntry(entry);
  return serializeEntry({ ...entry, runInput: undefined });
}

/* ─── InMemory backend (default) ─── */

class InMemoryWorkflowSnapshotStore implements WorkflowSnapshotStore {
  private readonly map = new Map<string, WorkflowSnapshot>();
  private readonly histories = new Map<string, string[]>();

  async appendHistory(entry: WorkflowHistoryEntry): Promise<void> {
    const list = this.histories.get(entry.runId) ?? [];
    list.push(entryForIndex(entry, list.length));
    this.histories.set(entry.runId, list);
  }
  async history(runId: string): Promise<ReadonlyArray<WorkflowHistoryEntry>> {
    return (this.histories.get(runId) ?? []).map((raw) => JSON.parse(raw) as WorkflowHistoryEntry);
  }

  async save(snapshot: WorkflowSnapshot): Promise<void> {
    // Verify serializability even in-memory so behavior is consistent with json backend.
    try {
      JSON.stringify(snapshot);
    } catch (err) {
      throw new WorkflowNotSerializableError(
        snapshot.currentStepId,
        err instanceof Error ? err : new Error(String(err)),
      );
    }
    this.map.set(snapshot.runId, snapshot);
  }
  async load(runId: string): Promise<WorkflowSnapshot | undefined> {
    return this.map.get(runId);
  }
  async delete(runId: string): Promise<void> {
    this.map.delete(runId);
  }
  async list(workflowName?: string): Promise<ReadonlyArray<WorkflowSnapshotListing>> {
    return [...this.map.values()]
      .filter((s) => workflowName === undefined || s.workflowName === workflowName)
      .map(toListing);
  }
}

/* ─── Json file backend (opt-in) ─── */

class JsonFileWorkflowSnapshotStore implements WorkflowSnapshotStore {
  constructor(private readonly dir: string) {}

  private filePath(runId: string): string {
    return join(this.dir, `${runId}.json`);
  }

  async save(snapshot: WorkflowSnapshot): Promise<void> {
    let serialized: string;
    try {
      serialized = JSON.stringify(snapshot);
    } catch (err) {
      throw new WorkflowNotSerializableError(
        snapshot.currentStepId,
        err instanceof Error ? err : new Error(String(err)),
      );
    }
    await mkdir(this.dir, { recursive: true });
    await atomicWriteText(this.filePath(snapshot.runId), serialized);
  }

  async load(runId: string): Promise<WorkflowSnapshot | undefined> {
    try {
      const raw = await readFile(this.filePath(runId), "utf8");
      return JSON.parse(raw) as WorkflowSnapshot;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  async delete(runId: string): Promise<void> {
    try {
      await (await import("node:fs/promises")).unlink(this.filePath(runId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  private historyDir(runId: string): string {
    return join(this.dir, safeFilenameForId(runId));
  }

  async appendHistory(entry: WorkflowHistoryEntry): Promise<void> {
    const dir = this.historyDir(entry.runId);
    await mkdir(dir, { recursive: true });
    const index = (await this.readEntriesOrEmpty(dir)).filter((f) => f.endsWith(".json")).length;
    await atomicWriteText(join(dir, `${index}-${entry.stepId}.json`), entryForIndex(entry, index));
  }

  async history(runId: string): Promise<ReadonlyArray<WorkflowHistoryEntry>> {
    const dir = this.historyDir(runId);
    const files = (await this.readEntriesOrEmpty(dir))
      .filter((f) => /^\d+-.*\.json$/.test(f))
      .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
    const out: WorkflowHistoryEntry[] = [];
    for (const f of files) {
      out.push(JSON.parse(await readFile(join(dir, f), "utf8")) as WorkflowHistoryEntry);
    }
    return out;
  }

  private async readEntriesOrEmpty(dir: string = this.dir): Promise<string[]> {
    try {
      return await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  private async readSnapshotSafe(file: string): Promise<WorkflowSnapshot | undefined> {
    try {
      const raw = await readFile(join(this.dir, file), "utf8");
      return JSON.parse(raw) as WorkflowSnapshot;
    } catch {
      return undefined;
    }
  }

  async list(workflowName?: string): Promise<ReadonlyArray<WorkflowSnapshotListing>> {
    const entries = await this.readEntriesOrEmpty();
    const results: WorkflowSnapshotListing[] = [];
    for (const file of entries) {
      if (!file.endsWith(".json")) continue;
      const snap = await this.readSnapshotSafe(file);
      if (snap === undefined) continue;
      if (workflowName !== undefined && snap.workflowName !== workflowName) continue;
      results.push(toListing(snap));
    }
    return results;
  }
}

/* ─── Resolver: per-Workflow store cache ─── */

const memoryStore = new InMemoryWorkflowSnapshotStore();
const jsonStores = new Map<string, JsonFileWorkflowSnapshotStore>();

export function getSnapshotStoreFor(options: WorkflowOptions): WorkflowSnapshotStore {
  if (options.persistence?.backend === "json") {
    const dir = options.persistence.dir as string; // schema enforces dir is set
    let store = jsonStores.get(dir);
    if (store === undefined) {
      store = new JsonFileWorkflowSnapshotStore(dir);
      jsonStores.set(dir, store);
    }
    return store;
  }
  return memoryStore;
}

/** Test seam — clear in-memory store between tests. */
export function __resetSnapshotStoresForTests(): void {
  jsonStores.clear();
  // memoryStore has private map; reset via assignment.
  // biome-ignore lint/suspicious/noExplicitAny: test-only seam
  (memoryStore as any).map.clear();
  // biome-ignore lint/suspicious/noExplicitAny: test-only seam
  (memoryStore as any).histories.clear();
}
