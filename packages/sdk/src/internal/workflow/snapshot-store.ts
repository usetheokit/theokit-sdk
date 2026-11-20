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
import type {
  WorkflowCheckpoint,
  WorkflowOptions,
  WorkflowSnapshot,
} from "../../types/workflow.js";
import { WorkflowNotSerializableError } from "../../workflow-errors.js";
import { atomicWriteText } from "../persistence/atomic-write.js";

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

/** A retained checkpoint plus what a replay needs: the owning workflow and, on the first step, the run input. */
export interface HistoryEntry extends WorkflowCheckpoint {
  readonly workflowName: string;
  readonly input?: unknown;
}

function copyEntry(entry: HistoryEntry): HistoryEntry {
  try {
    return JSON.parse(JSON.stringify(entry)) as HistoryEntry;
  } catch (err) {
    throw new WorkflowNotSerializableError(
      entry.stepId,
      err instanceof Error ? err : new Error(String(err)),
    );
  }
}

export interface WorkflowSnapshotStore {
  /** Retain a checkpoint; an entry for the same step of the run is replaced in place. */
  appendHistory(entry: HistoryEntry): Promise<void>;
  /** Retained checkpoints of a run, oldest first. */
  loadHistory(runId: string): Promise<ReadonlyArray<HistoryEntry>>;
  save(snapshot: WorkflowSnapshot): Promise<void>;
  load(runId: string): Promise<WorkflowSnapshot | undefined>;
  delete(runId: string): Promise<void>;
  list(workflowName?: string): Promise<ReadonlyArray<WorkflowSnapshotListing>>;
}

/* ─── InMemory backend (default) ─── */

class InMemoryWorkflowSnapshotStore implements WorkflowSnapshotStore {
  private readonly map = new Map<string, WorkflowSnapshot>();
  private readonly histories = new Map<string, HistoryEntry[]>();

  async appendHistory(entry: HistoryEntry): Promise<void> {
    const copy = copyEntry(entry);
    const list = this.histories.get(entry.runId) ?? [];
    const at = list.findIndex((e) => e.stepId === entry.stepId);
    if (at >= 0) list[at] = copy;
    else list.push(copy);
    this.histories.set(entry.runId, list);
  }
  async loadHistory(runId: string): Promise<ReadonlyArray<HistoryEntry>> {
    return (this.histories.get(runId) ?? []).map(copyEntry);
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

  private historyDir(runId: string): string {
    return join(this.dir, runId);
  }

  private async historyFiles(runId: string): Promise<Array<{ index: number; file: string }>> {
    let names: string[];
    try {
      names = await readdir(this.historyDir(runId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const found: Array<{ index: number; file: string }> = [];
    for (const file of names) {
      const m = /^(\d+)-.*\.json$/.exec(file);
      if (m?.[1] !== undefined) found.push({ index: Number(m[1]), file });
    }
    return found.sort((a, b) => a.index - b.index);
  }

  async appendHistory(entry: HistoryEntry): Promise<void> {
    const serialized = JSON.stringify(copyEntry(entry));
    const files = await this.historyFiles(entry.runId);
    const suffix = `-${entry.stepId}.json`;
    const same = files.find((f) => f.file.slice(String(f.index).length) === suffix);
    const index = same?.index ?? (files.at(-1)?.index ?? -1) + 1;
    await mkdir(this.historyDir(entry.runId), { recursive: true });
    await atomicWriteText(join(this.historyDir(entry.runId), `${index}${suffix}`), serialized);
  }

  async loadHistory(runId: string): Promise<ReadonlyArray<HistoryEntry>> {
    const files = await this.historyFiles(runId);
    const out: HistoryEntry[] = [];
    for (const f of files) {
      const raw = await readFile(join(this.historyDir(runId), f.file), "utf8");
      out.push(JSON.parse(raw) as HistoryEntry);
    }
    return out;
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

  private async readEntriesOrEmpty(): Promise<string[]> {
    try {
      return await readdir(this.dir);
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
