import type { MemorySearchHit } from "./index-manager-contract.js";

/**
 * Type-leaf — shared types between `active-memory.ts` and
 * `active-memory-cache.ts`. Extracted to break LOW type-only cycle #10
 * (audit `architecture-output/final_report.md`) per plan
 * arch-review-fixes-2026-06-06 § Phase 4 / T4.1 (D438).
 *
 * Internal — `active-memory.ts` re-exports these for in-tree consumers
 * that historically imported from there.
 *
 */

export type ActiveMemoryQueryMode = "message" | "recent" | "full";

export type ActiveMemoryStatus = "ok" | "timeout" | "skipped" | "no-recall" | "error";

export interface ActiveMemoryResult {
  summary: string | undefined;
  durationMs: number;
  status: ActiveMemoryStatus;
  hits: ReadonlyArray<MemorySearchHit>;
}
