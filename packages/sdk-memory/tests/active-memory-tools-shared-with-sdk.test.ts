/**
 * #1069: active recall and the memory tools have ONE copy, in `@theokit/sdk`.
 *
 * `pnpm build` must precede this file: it imports the built packages, the way a consumer does.
 */

import * as sdk from "@theokit/sdk/internal/memory-store";
import * as peer from "@theokit/sdk-memory";
import { describe, expect, it } from "vitest";

describe("active memory and memory tools: one copy shared by sdk and sdk-memory", () => {
  it("exports the SDK's runActiveMemory", () => {
    expect(peer.runActiveMemory).toBeTypeOf("function");
    expect(peer.runActiveMemory).toBe(sdk.runActiveMemory);
  });

  it("exports the SDK's memory tool factories", () => {
    expect(peer.createMemorySearchTool).toBeTypeOf("function");
    expect(peer.createMemorySearchTool).toBe(sdk.createMemorySearchTool);
    expect(peer.createMemoryGetTool).toBeTypeOf("function");
    expect(peer.createMemoryGetTool).toBe(sdk.createMemoryGetTool);
  });
});
