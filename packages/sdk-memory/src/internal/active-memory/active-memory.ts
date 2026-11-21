/**
 * Active Memory blocking recall — one implementation, in `@theokit/sdk` (#1069). The satellite's
 * copy lacked the abort signal, `memoryRoot`, and the diagnostics sink.
 */
export {
  type ActiveMemoryOptions,
  type ActiveMemoryQueryMode,
  type ActiveMemoryResult,
  type ActiveMemoryStatus,
  type RunActiveMemoryArgs,
  runActiveMemory,
} from "@theokit/sdk/internal/memory-store";
