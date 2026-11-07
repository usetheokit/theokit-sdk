/**
 * Dreaming phases — re-exported from `@theokit/sdk`, not reimplemented here (B-444).
 *
 * This was a copy that had already drifted: it lacked the protected-kind dedup policy. A fix in
 * one copy did not reach the other, and `Memory.runDreamingSweep` runs this package's whenever it
 * is installed.
 */
export {
  type Cluster,
  type ClusterResult,
  type DedupResult,
  deepPhase,
  lightPhase,
  remPhase,
} from "@theokit/sdk/internal/memory-store";
