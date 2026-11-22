import { diag } from "../diagnostics.js";
import type { CircuitBreaker } from "../retry/circuit-breaker.js";
import { HISTOGRAM_NAMES, SPAN_NAMES } from "../telemetry/span-names.js";
import { NOOP_SPAN, type OTelSpan, type TelemetryHandle } from "../telemetry/tracer.js";
import type { ActiveMemoryCache, TenantContext } from "./active-memory-cache.js";
// T4.1 / D438 — `ActiveMemoryResult` and its helpers moved to `./active-memory-types.ts`
// so `./active-memory-cache.ts` can reach them without cycling back here (cycle #10).
// Re-exported below for back-compat with in-tree consumers.
import type {
  ActiveMemoryQueryMode,
  ActiveMemoryResult,
  ActiveMemoryStatus,
} from "./active-memory-types.js";
import type { MemorySearchHit } from "./index-manager.js";
import type { MemoryIndex } from "./memory-index.js";
import { type MemoryRoot, resolveMemoryRoot } from "./storage/memory-root.js";
import { persistActiveMemoryTranscript } from "./storage/transcript-store.js";

export type { ActiveMemoryQueryMode, ActiveMemoryResult, ActiveMemoryStatus };

/**
 * Active Memory blocking recall (ADR D6 of memory-system-peer-project-parity).
 *
 * Runs BEFORE `agent.send()` assembles the system prompt. Issues a direct
 * call to `IndexManager.search` with the user message (and optional recent
 * turns per `queryMode`).
 *
 * Returns a `summary` string capped at `maxSummaryChars` (default 220 to
 * match peer-project's `DEFAULT_MAX_SUMMARY_CHARS`) which the system-prompt
 * pipeline prepends as a `<active-memory>` block (priority 5).
 *
 * @internal
 */

// T4.1 / D438 — `ActiveMemoryQueryMode`, `ActiveMemoryStatus`, and
// `ActiveMemoryResult` now live in `./active-memory-types.ts` and are
// re-exported at the top of this module for back-compat.

export interface ActiveMemoryOptions {
  /** Whether active recall is enabled. Default `false`. */
  enabled?: boolean;
  /** Query construction strategy. Default `"recent"`. */
  queryMode?: ActiveMemoryQueryMode;
  /** Hard timeout in ms. Default `15000`. */
  timeoutMs?: number;
  /** Max chars in the summary. Default `220`. */
  maxSummaryChars?: number;
  /** Number of recent user turns to include in `queryMode === "recent"`. Default `2`. */
  recentUserTurns?: number;
}

export interface RunActiveMemoryArgs {
  userText: string;
  priorMessages: ReadonlyArray<{ role: "user" | "assistant"; text: string }>;
  index: MemoryIndex | undefined;
  options: ActiveMemoryOptions;
  /** Per-agent circuit breaker (Phase 8). */
  breaker?: CircuitBreaker;
  /** Per-agent result cache (Phase 8). */
  cache?: ActiveMemoryCache;
  /** Workspace root for transcript persistence. */
  cwd?: string;
  /**
   * The memory root the caller already resolved. Falls back to the project store, which is right
   * for a caller that has no `memory.directory` and wrong for one that does — so an agent passes
   * its own (#463).
   */
  memoryRoot?: MemoryRoot;
  /** When true, write transcript JSON under `<memory root>/transcripts/active-memory/`. */
  persistTranscripts?: boolean;
  /** Stable key the breaker + cache key by (default `default`). */
  agentKey?: string;
  /** Run id for transcript file naming. */
  runId?: string;
  /**
   * T0.1 — optional telemetry handle. When provided AND telemetry is enabled,
   * `memory.recall` span is emitted with `{ userId, namespace, scope, queryMode,
   * hits, status }` attrs and `theokit_memory_recall_duration_ms` histogram is
   * recorded with the same dimension keys. T4.9 will pin `userId/namespace/scope`
   * to the cache-key invariant (cross-tenant leak fix).
   */
  telemetry?: TelemetryHandle;
  /** User id surfaced as a memory.recall span attr for cross-tenant tracing. */
  userId?: string;
  /** Memory namespace (e.g. `default`, `<orgId>`) for span/histogram dimensions. */
  namespace?: string;
  /** Memory scope (`session` / `user` / `global`) for span/histogram dimensions. */
  scope?: string;
  /**
   * T4.7 — AbortSignal propagation. When the caller's signal aborts,
   * the active-memory recall exits early with `status: "skipped"` and
   * summary `undefined`. Prevents long-running embedding calls from
   * blocking agent.dispose() or user-initiated cancellation.
   */
  signal?: AbortSignal;
}

const DEFAULTS: Required<Omit<ActiveMemoryOptions, "enabled">> = {
  queryMode: "recent",
  timeoutMs: 15000,
  maxSummaryChars: 220,
  recentUserTurns: 2,
};

export async function runActiveMemory(args: RunActiveMemoryArgs): Promise<ActiveMemoryResult> {
  const started = Date.now();
  // T0.1 — `memory.recall` span emitted around the entire body so skipped /
  // cached / no-recall paths still surface in telemetry with the correct status.
  // userId/namespace/scope come from `args` (LocalAgentMemory threads them).
  const span = startMemoryRecallSpan(args);
  try {
    // T4.7 — early exit on abort before any I/O (embedding / search).
    if (args.signal?.aborted === true) {
      return endRecallSpan(span, args, {
        summary: undefined,
        durationMs: 0,
        status: "skipped",
        hits: [],
      });
    }
    if (args.options.enabled !== true || args.index === undefined) {
      return endRecallSpan(span, args, {
        summary: undefined,
        durationMs: 0,
        status: "skipped",
        hits: [],
      });
    }
    const cfg = { ...DEFAULTS, ...args.options };
    const breakerKey = args.agentKey ?? "default";
    if (args.breaker?.shouldSkip(breakerKey) === true) {
      return endRecallSpan(span, args, {
        summary: undefined,
        durationMs: 0,
        status: "skipped",
        hits: [],
      });
    }
    // T4.9 wiring (#56) — pass the tenant tuple so two callers with the same
    // query text but different identity never share a cache entry. The cache
    // key infra already supports this; only the wiring was missing.
    const tenantCtx: TenantContext = {
      namespace: args.namespace,
      userId: args.userId,
      scope: args.scope,
    };
    const cached = args.cache?.get(args.userText, cfg.queryMode, tenantCtx);
    if (cached !== undefined) return endRecallSpan(span, args, cached);

    const query = buildQuery(args.userText, args.priorMessages, cfg.queryMode, cfg.recentUserTurns);
    if (query.trim().length === 0) {
      const finalized = await finalize(args, cfg.queryMode, {
        summary: undefined,
        durationMs: Date.now() - started,
        status: "no-recall",
        hits: [],
      });
      return endRecallSpan(span, args, finalized);
    }
    const result = await searchOnce(args, cfg, query, started);
    notifyBreaker(args.breaker, breakerKey, result.status);
    const finalized = await finalize(args, cfg.queryMode, result);
    return endRecallSpan(span, args, finalized);
  } catch (cause) {
    span.recordException(cause);
    span.setStatus({ code: 2, message: cause instanceof Error ? cause.message : String(cause) });
    span.end();
    throw cause;
  }
}

/** Extract optional identity attributes from recall args (shared by span + histogram). */
function recallIdentityAttrs(args: RunActiveMemoryArgs): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (args.userId !== undefined) attrs.userId = args.userId;
  if (args.namespace !== undefined) attrs.namespace = args.namespace;
  if (args.scope !== undefined) attrs.scope = args.scope;
  return attrs;
}

function startMemoryRecallSpan(args: RunActiveMemoryArgs): OTelSpan {
  const telemetry: TelemetryHandle | undefined = args.telemetry;
  if (telemetry === undefined) {
    return NOOP_SPAN;
  }
  return telemetry.startSpan(SPAN_NAMES.MEMORY_RECALL, {
    queryMode: args.options.queryMode ?? "recent",
    ...recallIdentityAttrs(args),
  });
}

function endRecallSpan(
  span: OTelSpan,
  args: RunActiveMemoryArgs,
  result: ActiveMemoryResult,
): ActiveMemoryResult {
  span.setAttributes({
    hits: result.hits.length,
    status: result.status,
    durationMs: result.durationMs,
  });
  span.end();
  args.telemetry?.recordHistogram(HISTOGRAM_NAMES.MEMORY_RECALL_DURATION_MS, result.durationMs, {
    status: result.status,
    ...recallIdentityAttrs(args),
  });
  return result;
}

interface ResolvedConfig {
  queryMode: ActiveMemoryQueryMode;
  timeoutMs: number;
  maxSummaryChars: number;
  recentUserTurns: number;
}

async function searchOnce(
  args: RunActiveMemoryArgs,
  cfg: ResolvedConfig,
  query: string,
  started: number,
): Promise<ActiveMemoryResult> {
  if (args.index === undefined) {
    return { summary: undefined, durationMs: 0, status: "skipped", hits: [] };
  }
  try {
    const hits = await withTimeout(args.index.search(query, { maxResults: 5 }), cfg.timeoutMs);
    if (hits === "timeout") {
      return { summary: undefined, durationMs: Date.now() - started, status: "timeout", hits: [] };
    }
    if (hits.length === 0) {
      return {
        summary: undefined,
        durationMs: Date.now() - started,
        status: "no-recall",
        hits: [],
      };
    }
    const summary = formatSummary(hits, cfg.maxSummaryChars);
    return { summary, durationMs: Date.now() - started, status: "ok", hits };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    diag(`[theokit-sdk] active-memory recall failed: ${message}\n`);
    return { summary: undefined, durationMs: Date.now() - started, status: "error", hits: [] };
  }
}

function notifyBreaker(
  breaker: CircuitBreaker | undefined,
  key: string,
  status: ActiveMemoryStatus,
): void {
  if (breaker === undefined) return;
  if (status === "timeout") breaker.recordTimeout(key);
  else if (status === "ok" || status === "no-recall") breaker.recordSuccess(key);
}

async function finalize(
  args: RunActiveMemoryArgs,
  queryMode: ActiveMemoryQueryMode,
  result: ActiveMemoryResult,
): Promise<ActiveMemoryResult> {
  // #56 — key the cache entry by tenant identity (see get-side wiring above).
  const tenantCtx: TenantContext = {
    namespace: args.namespace,
    userId: args.userId,
    scope: args.scope,
  };
  args.cache?.set(args.userText, queryMode, result, tenantCtx);
  if (args.persistTranscripts === true && args.cwd !== undefined) {
    await persistActiveMemoryTranscript(args.memoryRoot ?? resolveMemoryRoot(args.cwd), {
      runId: args.runId ?? `run-${Date.now()}`,
      startedAtMs: Date.now() - result.durationMs,
      userText: args.userText,
      queryMode,
      status: result.status,
      durationMs: result.durationMs,
      summary: result.summary,
      hits: result.hits.map((h) => ({
        path: h.path,
        startLine: h.startLine,
        endLine: h.endLine,
        score: h.score,
        snippet: h.snippet,
      })),
    });
  }
  return result;
}

function buildQuery(
  userText: string,
  priorMessages: ReadonlyArray<{ role: "user" | "assistant"; text: string }>,
  queryMode: ActiveMemoryQueryMode,
  recentUserTurns: number,
): string {
  if (queryMode === "message") return userText;
  if (queryMode === "full") {
    const allUserTurns = priorMessages.filter((m) => m.role === "user").map((m) => m.text);
    return [...allUserTurns, userText].join("\n");
  }
  // recent
  const recent = priorMessages
    .filter((m) => m.role === "user")
    .slice(-recentUserTurns)
    .map((m) => m.text);
  return [...recent, userText].join("\n");
}

function formatSummary(hits: ReadonlyArray<MemorySearchHit>, maxChars: number): string {
  const lines = hits.map((h) => `- ${h.citation}: ${h.snippet}`);
  let summary = lines.join("\n");
  if (summary.length > maxChars) summary = `${summary.slice(0, maxChars - 1)}…`;
  return summary;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const winner = await Promise.race([promise, timeout]);
    return winner;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
