/**
 * `MemoryProvider.buildTools()` wiring, driven through the real `runAgentLoop`.
 *
 * CONVERTED 2026-09-01. This file used to define `performBuildTools` — a local copy of the call
 * site in `initLoopContext` — and assert against the copy. The justification was the one nine files
 * in this package shared: that the loop "cannot be driven without a stubbed LLM". It is false.
 * `LlmClient` has two members, the stub is ten lines, and it now lives in
 * `tests/helpers/agent-loop-driver.ts` where the other conversions can reuse it.
 *
 * Why a copy is worse than no test rather than merely redundant: it passes for exactly as long as
 * someone remembers to edit it alongside the code — which is the property it was supposed to VERIFY.
 * The sibling `agent-loop/budget-tracker-check-wiring.test.ts` reached the end state: its mirror had
 * drifted INVERTED, pinning a fail-open budget gate while production failed closed, and the suite
 * stayed green.
 *
 * The observable now is what the model was actually asked. Provider tools reaching the request is
 * the wiring; a spy on `buildTools` alone would only prove the test called it.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ActiveMemoryPassArgs,
  ActiveMemoryPassResult,
  CustomTool,
  MemoryProvider,
  MemoryProviderHandle,
  MemoryProviderInitOptions,
  SDKAgent,
} from "@theokit/sdk";
import { afterAll, describe, expect, it, vi } from "vitest";

import { driveLoop } from "../helpers/agent-loop-driver.js";
import { stubMemoryAdapter } from "../helpers/memory-stubs.js";
import { removeTempDirRobustSync } from "../helpers/temp-workspace.js";

const CWD = mkdtempSync(join(tmpdir(), "theokit-buildtools-"));
afterAll(() => {
  removeTempDirRobustSync(CWD);
});

/** Tool names the loop sends to the model, in order. */
async function toolNamesSeenByModel(provider?: MemoryProvider): Promise<string[]> {
  const { requests } = await driveLoop(
    CWD,
    provider === undefined ? {} : { memoryProvider: provider },
  );
  return (requests[0]?.tools ?? []).map((t) => t.name);
}

function buildSpyProvider(opts?: {
  buildToolsThrows?: boolean;
  providerTools?: ReadonlyArray<CustomTool>;
}) {
  const initSpy = vi.fn(
    async (_o: MemoryProviderInitOptions): Promise<MemoryProviderHandle> => ({
      adapter: stubMemoryAdapter(),
    }),
  );
  const buildToolsSpy = vi.fn(
    (_h: MemoryProviderHandle, _a: SDKAgent): ReadonlyArray<CustomTool> => {
      if (opts?.buildToolsThrows) throw new Error("buildTools blew");
      return opts?.providerTools ?? [];
    },
  );
  const runActivePassSpy = vi.fn(
    async (
      _h: MemoryProviderHandle,
      _a: ActiveMemoryPassArgs,
    ): Promise<ActiveMemoryPassResult> => ({
      facts: [],
    }),
  );
  const disposeSpy = vi.fn((_h: MemoryProviderHandle): void => undefined);
  const provider: MemoryProvider = {
    init: initSpy,
    buildTools: buildToolsSpy,
    runActivePass: runActivePassSpy,
    dispose: disposeSpy,
  };
  return { provider, initSpy, buildToolsSpy, runActivePassSpy, disposeSpy };
}

describe("MemoryProvider buildTools() wiring, observed in the request the model received", () => {
  it("test_no_provider_means_no_provider_tools", async () => {
    const names = await toolNamesSeenByModel();
    expect(names.some((n) => n.startsWith("memory_"))).toBe(false);
  });

  it("test_provider_with_no_tools_appends_nothing", async () => {
    const { provider, buildToolsSpy } = buildSpyProvider();
    const names = await toolNamesSeenByModel(provider);
    expect(buildToolsSpy).toHaveBeenCalledTimes(1);
    expect(names.some((n) => n.startsWith("memory_"))).toBe(false);
  });

  it("test_provider_tools_reach_the_model_after_the_base_tools", async () => {
    const providerTools: CustomTool[] = [
      {
        name: "memory_search",
        description: "Search memory by query.",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
        handler: async () => "{}",
      },
      {
        name: "memory_get",
        description: "Fetch a memory by id.",
        inputSchema: { type: "object" },
        handler: async () => "{}",
      },
    ];
    const { provider, buildToolsSpy } = buildSpyProvider({ providerTools });
    const names = await toolNamesSeenByModel(provider);

    expect(buildToolsSpy).toHaveBeenCalledTimes(1);
    expect(names).toContain("memory_search");
    expect(names).toContain("memory_get");
    // Order is part of the contract: provider tools are APPENDED, so they cannot displace a
    // built-in the model was already told about.
    const first = names.indexOf("memory_search");
    expect(first, "provider tools must not come first").toBeGreaterThan(0);
    expect(names.indexOf("memory_get")).toBe(first + 1);
  });

  it("test_buildTools_throw_is_swallowed_and_the_turn_still_runs", async () => {
    const { provider, buildToolsSpy } = buildSpyProvider({ buildToolsThrows: true });
    const names = await toolNamesSeenByModel(provider);
    expect(buildToolsSpy).toHaveBeenCalledTimes(1);
    expect(names.some((n) => n.startsWith("memory_"))).toBe(false);
  });

  it("test_buildTools_receives_the_handle_init_returned", async () => {
    const { provider, buildToolsSpy, initSpy } = buildSpyProvider();
    await toolNamesSeenByModel(provider);
    expect(initSpy).toHaveBeenCalledTimes(1);
    const handle = await initSpy.mock.results[0]?.value;
    // Identity, not equality: the loop must pass the handle through rather than reconstruct it.
    expect(buildToolsSpy.mock.calls[0]?.[0]).toBe(handle);
  });
});
