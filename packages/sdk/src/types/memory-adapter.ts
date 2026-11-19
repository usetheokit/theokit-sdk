/**
 * Owner: `internal/local-agent/` (2 of 4 importers). Derived from the import graph, not declared —
 * `tests/lint/types-name-their-owner.test.ts` re-derives it.
 *
 * Public `MemoryAdapter` contract (T1.1, ADRs D141 / D147).
 *
 * The plugin extension point `{ kind: "memory" }` (ADR D98) declares a
 * `createProvider` factory; this file types its return value formally.
 * Adapters implement `write` / `recall` / `delete` plus optional methods
 * gated by `capabilities`. `MemoryId` is a branded string prefixed with
 * the adapter id so cross-adapter use throws on `extractRawId` (EC-B).
 *
 * Each provider-specific package (`@theokit-memory-supermemory`, etc)
 * exports a factory returning a `Plugin { kind: "memory" }` whose
 * `createProvider` resolves to a `MemoryAdapter` instance.
 *
 * @public
 */

/**
 * Branded provider memory ID. Format: `${adapterId}:${rawProviderId}`.
 * Use `mkMemoryId` / `extractRawId` from `../memory-adapter-helpers.js`
 * to construct and unwrap with cross-adapter safety (EC-B).
 *
 * @public
 */
export type MemoryId = string & { readonly __brand: "MemoryId" };

/**
 * Portable identity context. `userId` is the only required field —
 * the lowest common denominator across Supermemory / Honcho / Mem0.
 * Adapter implementations translate the optional fields to their
 * provider's native primitives (Honcho session, Mem0 run_id, etc).
 *
 * @public
 */
export interface MemoryContext {
  /** End-user identity. */
  userId: string;
  /** Agent / persona writing the memory. */
  agentId?: string;
  /** Logical conversation / run boundary. */
  sessionId?: string;
  /** Tenant / workspace partition. */
  tenantId?: string;
  /** Free-form tags for filtering / categorization. */
  tags?: string[];
  /** Provider-passthrough metadata. */
  metadata?: Record<string, unknown>;
}

/**
 * A single memory fact returned by `recall` or `get`.
 *
 * @public
 */
export interface MemoryFact {
  id: MemoryId;
  content: string;
  /** Semantic relevance score (provider-defined scale) when result of `recall`. */
  score?: number;
  /** ISO 8601 timestamp of creation. */
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Versioned snapshot of a memory's history. Only emitted by providers
 * with `capabilities.history === true` (Mem0 today).
 *
 * @public
 */
export interface MemoryRevision {
  id: MemoryId;
  content: string;
  version: number;
  changedAt: string;
}

/**
 * Statically declared adapter feature flags. Consumers feature-detect
 * at compile time via `if (adapter.capabilities.history)`.
 *
 * @public
 */
export interface MemoryAdapterCapabilities {
  /** Returns prior versions of a memory via `history(id)`. */
  history: boolean;
  /** First-class `sessionId` scoping. */
  sessions: boolean;
  /** First-class `tenantId` scoping. */
  tenancy: boolean;
  /** Provider performs reasoning over memory (e.g., Honcho dialectic). */
  reasoning: boolean;
  /** Exposes LLM-callable function-calling schemas. */
  toolSchemas: boolean;
  /** Supports background prefetch (currently informational). */
  prefetch: boolean;
}

/**
 * One assistant-turn message in the canonical `{role, content}` shape
 * an adapter may receive instead of a flat string when writing a turn.
 *
 * @public
 */
export interface MemoryTurnMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/**
 * OpenAI-format function-calling schema exposed to the LLM.
 *
 * @public
 */
export interface MemoryToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Portable third-party memory adapter contract. Implementations live
 * in `@theokit-memory-*` packages; the SDK never imports them.
 *
 * @public
 */
export interface MemoryAdapter {
  /** Short identifier — matches the `${adapterId}` prefix in `MemoryId`. */
  readonly id: string;
  readonly capabilities: MemoryAdapterCapabilities;

  /**
   * Synchronous availability probe — no network, no I/O. Typically "do I have the credentials I
   * need".
   *
   * `false` DISABLES the adapter: the runtime skips it when building the agent's memory, warns
   * naming this `id`, and carries on with whatever other adapters said yes. When every registered
   * adapter declines, a `write` or `recall` fails with `no_memory_adapter` and a message saying so,
   * rather than resolving without storing anything.
   *
   * It was mandatory and consulted by nothing until #360, which made it a contract that read as a
   * guarantee and provided none — a missing key surfaced mid-conversation as `auth_failed` instead.
   */
  isAvailable(): boolean;

  /** One-shot initialization. Idempotent: safe to call multiple times. */
  initialize?(): Promise<void>;

  /**
   * Persist a fact or full turn to memory. Returns the stored
   * `MemoryId`. Throws `MemoryAdapterError(code: "invalid_input")` on
   * empty content or invalid identifiers in `ctx`.
   */
  write(content: string | MemoryTurnMessage[], ctx: MemoryContext): Promise<MemoryId>;

  /**
   * Semantic recall — top-`k` facts ordered by relevance. Returns
   * empty array when `k === 0` or no matches.
   */
  recall(query: string, ctx: MemoryContext, k?: number): Promise<MemoryFact[]>;

  /**
   * Delete a memory by id. Throws `MemoryAdapterError(code:
   * "invalid_input")` when the id was minted by a different adapter
   * (EC-B). Throws `code: "not_found"` when the id does not exist.
   */
  delete(id: MemoryId): Promise<void>;

  // ── Capabilities-gated optional methods ───────────────────────────

  list?(ctx: MemoryContext, opts?: { cursor?: string; limit?: number }): AsyncIterable<MemoryFact>;
  get?(id: MemoryId): Promise<MemoryFact | null>;
  history?(id: MemoryId): Promise<MemoryRevision[]>;

  /** Empty array when `capabilities.toolSchemas === false`. */
  getToolSchemas?(): MemoryToolSchema[];
  handleToolCall?(name: string, args: Record<string, unknown>, ctx: MemoryContext): Promise<string>;

  /** Graceful shutdown — flush queues, close connections. */
  shutdown?(): Promise<void>;
}

/**
 * Direct memory API exposed on `SDKAgent.memory`. Resolves to whichever
 * memory adapter(s) are registered via `Agent.create({ plugins: [...] })`.
 *
 * @public
 */
export interface AgentMemory {
  /**
   * Persist a fact. Returns the first adapter's id; in multi-adapter
   * setups all adapters receive the write (fan-out).
   */
  write(content: string | MemoryTurnMessage[], ctx?: Partial<MemoryContext>): Promise<MemoryId>;

  /** Semantic recall — merged + deduped across registered adapters. */
  recall(query: string, ctx?: Partial<MemoryContext>, k?: number): Promise<MemoryFact[]>;

  /** Delete a memory by id — routes to the owning adapter via prefix. */
  delete(id: MemoryId): Promise<void>;

  /** Returns the first registered adapter or `null` when none exists. */
  adapter(): MemoryAdapter | null;

  /**
   * Resolves once every queued `memory.review` turn review has finished (or at once when review
   * is off). For tests and shutdown; `dispose()` already waits, bounded.
   */
  reviewsIdle(): Promise<void>;
}
