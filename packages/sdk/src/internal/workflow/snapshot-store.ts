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
}

/* ─── InMemory backend (default) ─── */

class InMemoryWorkflowSnapshotStore implements WorkflowSnapshotStore {
  private readonly map = new Map<string, WorkflowSnapshot>();

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
}
