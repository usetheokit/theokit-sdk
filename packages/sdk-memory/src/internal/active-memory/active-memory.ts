/**
 * Active Memory blocking recall. The implementation lives in `@theokit/sdk` (#1069); this module
 * re-exports it so both packages run one copy.
 *
 * @internal
 */

export {
  type ActiveMemoryOptions,
  type ActiveMemoryQueryMode,
  type ActiveMemoryResult,
  type ActiveMemoryStatus,
  type RunActiveMemoryArgs,
  runActiveMemory,
} from "@theokit/sdk/internal/memory-store";
