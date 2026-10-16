import { describe, expect, it } from "vitest";
import { remPhase } from "../../src/internal/memory/dreaming/phases.js";
import type { EmbeddingRuntime } from "../../src/internal/memory/embedding-adapter.js";
import type { MemoryFact } from "../../src/internal/memory/types.js";

/*
 * B-380: the fallback copy of the REM phase applies the same 500-fact cap as the sdk-memory peer,
 * and must report the facts it left out the same way. These are the peer's three `remPhase` tests,
 * run against this copy, so a change to one copy alone fails here or there.
 */
const ONE_HOT_DIMENSION = 512;

/** `count` facts whose texts are `fact number <i>`, so each maps to its own one-hot vector. */
const distinctFacts = (count: number): MemoryFact[] =>
  Array.from({ length: count }, (_, i) => ({ text: `fact number ${i}` }));

/** An embedding that gives `fact number <i>` a one-hot vector at index i: every pair has cosine 0. */
function oneHotEmbedding(): EmbeddingRuntime {
  return {
    embed: async (texts: ReadonlyArray<string>): Promise<number[][]> =>
      texts.map((text) => {
        const vector = new Array<number>(ONE_HOT_DIMENSION).fill(0);
        vector[Number(text.replace("fact number ", ""))] = 1;
        return vector;
      }),
    dimension: ONE_HOT_DIMENSION,
    providerId: "stub",
    model: "stub-model",
  } as unknown as EmbeddingRuntime;
}

describe("the fallback REM phase and its sweep cap", () => {
  it("remPhase reports one fact left out of 501", async () => {
    const rem = await remPhase(distinctFacts(501), oneHotEmbedding());
    expect(rem.factsLeftOut).toBe(1);
  });

  it("remPhase reports zero left out at 500", async () => {
    const rem = await remPhase(distinctFacts(500), oneHotEmbedding());
    expect(rem.factsLeftOut).toBe(0);
  });

  it("remPhase reports zero left out for no facts", async () => {
    const rem = await remPhase([], oneHotEmbedding());
    expect(rem.factsLeftOut).toBe(0);
  });
});
