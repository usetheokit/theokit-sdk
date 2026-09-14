import { describe, expect, it } from "vitest";
import { SessionTranscript } from "../../../src/internal/persistence/session-transcript.js";
import { compactSessionTranscript } from "../../../src/internal/session/compact-session.js";
import type { SessionRecord } from "../../../src/types/session-record.js";
import type { SessionStore } from "../../../src/types/session-store.js";

/**
 * B-082 — the pre-compaction seam reaches the path a consumer actually calls.
 *
 * B-002 shipped `withPreCompaction` in `@theokit/agents@14.1.0` and it covers ONE of three
 * compaction paths. Measured 2026-09-14 with controls at every step:
 *
 *   1. `runner.compaction.compact(...)`        — the agents-layer strategy   → covered by B-002
 *   2. `autoCompactIfNeeded`                   — the SDK at a threshold      → this file
 *   3. `Agent.compact(sessionId, { trigger })` — the session API             → this file
 *
 * **Path 3 is the one a person reaches.** Traced rather than assumed: `/compact` → `handleCompact`
 * → `compactSession` → `Agent.compact` → `compactSessionTranscript`, and it is the only real
 * `.compact(` invocation in TheoCode's entire source.
 *
 * The two SDK paths CONVERGE on `compactSessionTranscript`, which is why one seam covers both, and
 * why this is one change rather than two.
 *
 * ## The contract is B-002's, deliberately not a second one
 *
 * Awaited before the rewrite, bounded, `AbortSignal` passed, failure reported and compaction
 * PROCEEDS. The last one is the load-bearing half: a pre-compaction hook that could block would turn
 * a consumer's bug into a runtime that cannot reclaim its context.
 *
 * The bound is re-implemented here rather than imported from `@theokit/agents`, because the
 * dependency runs the other way and inverting it to save thirty lines would be the wrong trade. The
 * cost — two implementations of one contract — is paid by testing both against the same OBSERVABLE
 * behaviours, which is what a reader compares.
 */

const LOC = { cwd: "/home/u/proj", agentId: "agent-1", model: "openai/gpt-4o-mini" };

function storeWith(initial: SessionRecord[]): SessionStore & { records: SessionRecord[] } {
  const records = [...initial];
  return {
    records,
    async readRecords() {
      return [...records];
    },
    async appendRecords(_agentId: string, delta: readonly SessionRecord[]) {
      records.push(...delta);
    },
  } as unknown as SessionStore & { records: SessionRecord[] };
}

function seedHistory(): SessionRecord[] {
  const t = new SessionTranscript({ cwd: LOC.cwd, sessionId: LOC.agentId, model: LOC.model });
  t.appendUserTurn("my favorite city is Curitiba");
  t.appendAssistantTurn({ text: "noted" });
  t.appendUserTurn("what is the weather like there?");
  t.appendAssistantTurn({ text: `mild in winter. ${"irrelevant detail ".repeat(200)}` });
  return [...t.records()];
}

const summarize = async () => "a summary";

describe("the pre-compaction seam on the session path", () => {
  it("a registered handler runs on the session path", async () => {
    let ran = 0;
    await compactSessionTranscript({
      store: storeWith(seedHistory()),
      loc: LOC,
      sessionId: LOC.agentId,
      trigger: "manual",
      summarize,
      onPreCompact: () => {
        ran += 1;
      },
    });
    expect(ran).toBe(1);
  });

  it("the handler sees which trigger caused it", async () => {
    const seen: string[] = [];
    const run = async (trigger: "manual" | "auto") => {
      await compactSessionTranscript({
        store: storeWith(seedHistory()),
        loc: LOC,
        sessionId: LOC.agentId,
        trigger,
        summarize,
        onPreCompact: (ctx) => {
          seen.push(ctx.trigger);
        },
      });
    };
    await run("manual");
    await run("auto");
    // Order asserted, not membership: swapping the two would still satisfy a set comparison, and
    // "which trigger caused THIS compaction" is exactly the fact under test.
    expect(seen).toEqual(["manual", "auto"]);
  });

  it("the rewrite waits for the handler", async () => {
    const timeline: string[] = [];
    const store = storeWith(seedHistory());
    const before = store.records.length;
    await compactSessionTranscript({
      store,
      loc: LOC,
      sessionId: LOC.agentId,
      trigger: "manual",
      summarize: async () => {
        timeline.push("summarize");
        return "a summary";
      },
      onPreCompact: async () => {
        timeline.push("handler-enter");
        await new Promise((r) => setTimeout(r, 20));
        timeline.push("handler-exit");
      },
    });
    // A recorded timeline of entry marks, never a wall-clock sleep: the claim is ORDER, and a timing
    // assertion would be the flake `rules/testing.md` § 3 calls a bug.
    expect(timeline).toEqual(["handler-enter", "handler-exit", "summarize"]);
    expect(store.records.length).toBeGreaterThan(before);
  });

  it("a failing handler does not stop compaction", async () => {
    const reported: unknown[] = [];
    const store = storeWith(seedHistory());
    const before = store.records.length;
    await compactSessionTranscript({
      store,
      loc: LOC,
      sessionId: LOC.agentId,
      trigger: "manual",
      summarize,
      onPreCompact: () => {
        throw new Error("handler boom");
      },
      onPreCompactError: (e) => {
        reported.push(e);
      },
    });
    // The report AND the completed compaction asserted in ONE test, because the claim is the
    // RELATIONSHIP between them: either alone would pass while the contract was broken.
    expect(reported).toHaveLength(1);
    expect(store.records.length).toBeGreaterThan(before);
  });

  it("a handler that never settles is abandoned at the bound", async () => {
    const reported: unknown[] = [];
    const store = storeWith(seedHistory());
    const before = store.records.length;
    await compactSessionTranscript({
      store,
      loc: LOC,
      sessionId: LOC.agentId,
      trigger: "manual",
      summarize,
      preCompactTimeoutMs: 25,
      onPreCompact: () => new Promise(() => {}),
      onPreCompactError: (e) => {
        reported.push(e);
      },
    });
    expect(reported).toHaveLength(1);
    expect(store.records.length).toBeGreaterThan(before);
  });

  it("cancellation propagates to the handler when the bound fires", async () => {
    let aborted = false;
    await compactSessionTranscript({
      store: storeWith(seedHistory()),
      loc: LOC,
      sessionId: LOC.agentId,
      trigger: "manual",
      summarize,
      preCompactTimeoutMs: 20,
      onPreCompact: (ctx) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener("abort", () => {
            aborted = true;
            resolve();
          });
        }),
      onPreCompactError: () => {},
    });
    // Asserted on the signal's STATE, not on elapsed time.
    expect(aborted).toBe(true);
  });

  it("no handler registered leaves the path byte-identical", async () => {
    const withNone = storeWith(seedHistory());
    await compactSessionTranscript({
      store: withNone,
      loc: LOC,
      sessionId: LOC.agentId,
      trigger: "manual",
      summarize,
    });
    expect(withNone.records.length).toBeGreaterThan(0);
  });
});
