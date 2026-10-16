/**
 * B-380: the in-memory provider refuses a new fact over its declared ceiling.
 *
 * This family never reaches the markdown writer, so a ceiling enforced only there would leave
 * both of its write paths unbounded: the adapter's `write` and the `memory_remember` tool. Each
 * refusal is asserted with what recall returns afterwards, because a guard that throws after the
 * `Map.set` would pass a test that checks only the error.
 */

import type { MemoryId } from "@theokit/sdk";
import { createInMemoryMarkdownProvider } from "@theokit/sdk-memory";
import { describe, expect, it } from "vitest";
import { textHandler } from "./text-handler.js";

const CTX = { userId: "u1" };
const FAKE_AGENT = { agentId: "test-agent", model: undefined } as Parameters<
  ReturnType<typeof createInMemoryMarkdownProvider>["buildTools"]
>[1];

/*
 * The options are passed through this alias so the file compiles against the declarations of the
 * commit it runs on: before the ceiling exists the factory takes no argument, and the file has to
 * fail by behaviour rather than by not compiling.
 */
const createProvider: (options?: {
  maxFacts?: number;
}) => ReturnType<typeof createInMemoryMarkdownProvider> = createInMemoryMarkdownProvider;

async function providerAt(maxFacts: number) {
  const provider = createProvider({ maxFacts });
  const handle = await provider.init({ cwd: "/tmp" });
  const tools = provider.buildTools(handle, FAKE_AGENT);
  const rememberTool = tools.find((t) => t.name === "memory_remember");
  if (rememberTool === undefined) throw new Error("memory_remember is not registered");
  return { adapter: handle.adapter, remember: { handler: textHandler(rememberTool) } };
}

describe("a declared ceiling on the in-memory provider", () => {
  it("rejects an adapter write at the ceiling and recall still returns the first N facts", async () => {
    const { adapter } = await providerAt(2);
    await adapter.write("a", CTX);
    await adapter.write("b", CTX);
    const third = adapter.write("c", CTX);
    await expect(third).rejects.toMatchObject({ code: "memory_ceiling_reached" });
    const recalled = await adapter.recall("", CTX);
    expect(recalled.map((f) => f.content)).toEqual(["a", "b"]);
  });

  it("memory_remember returns ok false with the refusal and stores nothing", async () => {
    const { adapter, remember } = await providerAt(2);
    await adapter.write("a", CTX);
    await adapter.write("b", CTX);
    const raw = await remember.handler({ content: "c" });
    const reply = JSON.parse(raw) as { ok: boolean; code?: string; error?: string };
    expect(reply).toMatchObject({ ok: false, code: "memory_ceiling_reached" });
    expect(reply.error).toContain("maxFacts");
    const recalled = await adapter.recall("", CTX);
    expect(recalled).toHaveLength(2);
  });

  it("accepts a write again after delete frees a slot", async () => {
    const { adapter } = await providerAt(2);
    const firstId = await adapter.write("a", CTX);
    await adapter.write("b", CTX);
    await adapter.delete(firstId as MemoryId);
    const id = await adapter.write("c", CTX);
    expect(String(id)).toMatch(/^in-memory-md:/);
    const recalled = await adapter.recall("", CTX);
    expect(recalled.map((f) => f.content)).toEqual(["b", "c"]);
  });

  it("refuses a ceiling that is not a positive integer at construction", () => {
    for (const value of [0, -1, 2.5, "3", null] as unknown[]) {
      const build = () => createProvider({ maxFacts: value as number });
      expect(build).toThrow(expect.objectContaining({ code: "invalid_memory_ceiling" }));
    }
  });

  it("admits exactly one fact under a ceiling of 1", async () => {
    const { adapter } = await providerAt(1);
    const first = await adapter.write("a", CTX);
    expect(String(first)).toMatch(/^in-memory-md:/);
    const second = adapter.write("b", CTX);
    await expect(second).rejects.toMatchObject({ code: "memory_ceiling_reached" });
  });

  it("admits exactly one of two concurrent writes at one below the ceiling", async () => {
    const { adapter, remember } = await providerAt(2);
    await adapter.write("a", CTX);
    const results = await Promise.allSettled([
      adapter.write("x", CTX),
      remember.handler({ content: "y" }),
    ]);
    const admitted = results.filter(
      (r) => r.status === "fulfilled" && !String(r.value).includes('"ok":false'),
    );
    expect(admitted).toHaveLength(1);
    const recalled = await adapter.recall("", CTX);
    expect(recalled).toHaveLength(2);
  });
});
