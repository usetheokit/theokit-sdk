/**
 * `MemorySettings.mirror` — write the built-in fact store through to the agent's `kind: "memory"`
 * adapters, and optionally recall from them first.
 *
 * Adapter failures never propagate: a failed write is reported on the diagnostics channel with the
 * adapter id, and a failed or empty recall falls back to the local facts.
 *
 * @internal
 */

import type { MemoryMirrorOptions } from "../../types/agent.js";
import type {
  MemoryFact as AdapterFact,
  MemoryAdapter,
  MemoryContext,
} from "../../types/memory-adapter.js";
import { diagFailure } from "../diagnostics.js";
import type { MemoryFact } from "./types.js";

export interface MemoryMirror {
  /** Write one saved fact to every adapter. Never throws. */
  write(text: string): Promise<void>;
  /** Adapter facts for the prompt (capped at `limit`), or `[]` when local facts should be used. */
  recall(query: string | undefined, limit: number): Promise<MemoryFact[]>;
  readonly recallFromAdapters: boolean;
}

export interface MemoryMirrorDeps {
  options: MemoryMirrorOptions;
  /** Resolves the initialized adapters; may throw when none are registered. */
  adapters: () => Promise<ReadonlyArray<MemoryAdapter>>;
  /** The context to pass to adapters, or an error message when no userId is known. */
  context: () => MemoryContext | undefined;
}

const RECALL_QUERY = "facts about the user";

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function listFacts(
  adapter: MemoryAdapter,
  ctx: MemoryContext,
  limit: number,
): Promise<AdapterFact[]> {
  const out: AdapterFact[] = [];
  for await (const fact of adapter.list?.(ctx, { limit }) ?? []) {
    out.push(fact);
    if (out.length >= limit) break;
  }
  return out;
}

async function readAdapter(
  adapter: MemoryAdapter,
  ctx: MemoryContext,
  query: string | undefined,
  limit: number,
): Promise<AdapterFact[]> {
  if (adapter.list !== undefined) return listFacts(adapter, ctx, limit);
  return adapter.recall(query ?? RECALL_QUERY, ctx, limit);
}

export function createMemoryMirror(deps: MemoryMirrorDeps): MemoryMirror {
  const writeEnabled = deps.options.write !== false;
  const recallFromAdapters = deps.options.recall === "adapters-first";

  async function resolve(
    what: string,
  ): Promise<{ adapters: ReadonlyArray<MemoryAdapter>; ctx: MemoryContext } | undefined> {
    const ctx = deps.context();
    if (ctx === undefined) {
      diagFailure(
        `[theokit-sdk] memory mirror ${what} skipped: no userId — set memory.userId or memoryContext.userId.`,
      );
      return undefined;
    }
    try {
      return { adapters: await deps.adapters(), ctx };
    } catch (cause) {
      diagFailure(`[theokit-sdk] memory mirror ${what} skipped: ${describe(cause)}`);
      return undefined;
    }
  }

  return {
    recallFromAdapters,
    async write(text) {
      if (!writeEnabled) return;
      const r = await resolve("write");
      if (r === undefined) return;
      await Promise.all(
        r.adapters.map(async (adapter) => {
          try {
            await adapter.write(text, r.ctx);
          } catch (cause) {
            diagFailure(
              `[theokit-sdk] memory mirror write to adapter "${adapter.id}" failed; the local fact is saved: ${describe(cause)}`,
            );
          }
        }),
      );
    },
    async recall(query, limit) {
      if (!recallFromAdapters) return [];
      const r = await resolve("recall");
      if (r === undefined) return [];
      const settled = await Promise.allSettled(
        r.adapters.map((a) => readAdapter(a, r.ctx, query, limit)),
      );
      const out: MemoryFact[] = [];
      const seen = new Set<string>();
      settled.forEach((result, i) => {
        if (result.status === "rejected") {
          diagFailure(
            `[theokit-sdk] memory mirror recall from adapter "${r.adapters[i]?.id}" failed; using local facts: ${describe(result.reason)}`,
          );
          return;
        }
        for (const fact of result.value) {
          if (seen.has(fact.content)) continue;
          seen.add(fact.content);
          out.push({ text: fact.content });
        }
      });
      return out.slice(0, limit);
    },
  };
}
