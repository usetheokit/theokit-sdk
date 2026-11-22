import * as sdkStore from "@theokit/sdk/internal/memory-store";
import { describe, expect, it } from "vitest";

import { runActiveMemory } from "../src/internal/active-memory/active-memory.js";
import { createMemoryGetTool, createMemorySearchTool } from "../src/internal/tools.js";

describe("active memory and memory tools are shared with @theokit/sdk (#1069)", () => {
  it("re-exports the SDK references", () => {
    expect(runActiveMemory).toBe(sdkStore.runActiveMemory);
    expect(createMemorySearchTool).toBe(sdkStore.createMemorySearchTool);
    expect(createMemoryGetTool).toBe(sdkStore.createMemoryGetTool);
  });
});
