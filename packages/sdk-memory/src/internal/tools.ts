/**
 * Memory tools (`memory_search` + `memory_get`) — one implementation, in `@theokit/sdk`
 * (#1069). The satellite's copy was a subset of it (no symlink-aware containment in `memory_get`).
 *
 * The values are the SDK's functions themselves. Only the option types are restated, so callers
 * keep passing this package's `MemoryIndex`, whose `SyncResult`/`IndexStatus` omit fields the SDK's
 * declare as required.
 */
import {
  createMemoryGetTool as sdkCreateMemoryGetTool,
  createMemorySearchTool as sdkCreateMemorySearchTool,
  type MemoryGetToolOptions,
  type MemorySearchToolOptions as SdkMemorySearchToolOptions,
  type MemoryTool,
  type MemoryToolJson,
} from "@theokit/sdk/internal/memory-store";
import type { MemoryIndex } from "./index/memory-index.js";

export type { MemoryGetToolOptions, MemoryTool, MemoryToolJson };

/** Options for {@link createMemorySearchTool}. */
export type MemorySearchToolOptions = Omit<SdkMemorySearchToolOptions, "index"> & {
  /** The index to search. */
  index: MemoryIndex;
};

/** Builds the `memory_search` tool. */
export const createMemorySearchTool = sdkCreateMemorySearchTool as unknown as (
  opts: MemorySearchToolOptions,
) => MemoryTool;

/** Builds the `memory_get` tool. */
export const createMemoryGetTool: (opts: MemoryGetToolOptions) => MemoryTool =
  sdkCreateMemoryGetTool;
