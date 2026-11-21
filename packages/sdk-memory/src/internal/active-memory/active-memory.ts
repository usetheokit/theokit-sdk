/**
 * Active Memory blocking recall — one implementation, in `@theokit/sdk` (#1069). The satellite's
 * copy lacked the abort signal, `memoryRoot`, and the diagnostics sink.
 *
 * Only the argument type is restated, so callers keep passing this package's `MemoryIndex`.
 */
import {
  type ActiveMemoryOptions,
  type ActiveMemoryQueryMode,
  type ActiveMemoryResult,
  type ActiveMemoryStatus,
  type RunActiveMemoryArgs as SdkRunActiveMemoryArgs,
  runActiveMemory as sdkRunActiveMemory,
} from "@theokit/sdk/internal/memory-store";
import type { MemoryIndex } from "../index/memory-index.js";

export type { ActiveMemoryOptions, ActiveMemoryQueryMode, ActiveMemoryResult, ActiveMemoryStatus };

/** Everything {@link runActiveMemory} needs for one attempt. */
export type RunActiveMemoryArgs = Omit<SdkRunActiveMemoryArgs, "index"> & {
  /** The index to recall from; `undefined` yields a `skipped` result. */
  index: MemoryIndex | undefined;
};

/** Runs one blocking recall attempt before the system prompt is assembled. */
export const runActiveMemory = sdkRunActiveMemory as unknown as (
  args: RunActiveMemoryArgs,
) => Promise<ActiveMemoryResult>;
