import { createHash } from "node:crypto";

// T4.1 / D438 — import from leaf to break the active-memory cluster cycle (#10).
import type { ActiveMemoryResult } from "./active-memory-types.js";

/**
 * TTL-bounded cache for `runActiveMemory` results. Keyed by
 * `sha256(userText + queryMode)` so two identical sends within `cacheTtlMs`
 * (default 15s, matching peer-project's `DEFAULT_CACHE_TTL_MS`) share a single
 * search.
 *
 * Bounded size; oldest entries evicted first when capacity is exceeded.
 *
 */

export interface ActiveMemoryCacheOptions {
  ttlMs?: number;
  capacity?: number;
  now?: () => number;
}

interface CacheEntry {
  expiresAtMs: number;
  result: ActiveMemoryResult;
}

const DEFAULT_TTL_MS = 15_000;
const DEFAULT_CAPACITY = 1000;

export class ActiveMemoryCache {
  private readonly map = new Map<string, CacheEntry>();

  constructor(private readonly opts: ActiveMemoryCacheOptions = {}) {}

  get(
    userText: string,
    queryMode: string,
    tenantCtx?: TenantContext,
  ): ActiveMemoryResult | undefined {
    const key = cacheKey(userText, queryMode, tenantCtx);
    const entry = this.map.get(key);
    if (entry === undefined) return undefined;
    if (this.now() >= entry.expiresAtMs) {
      this.map.delete(key);
      return undefined;
    }
    // LRU bump
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.result;
  }

  set(
    userText: string,
    queryMode: string,
    result: ActiveMemoryResult,
    tenantCtx?: TenantContext,
  ): void {
    const key = cacheKey(userText, queryMode, tenantCtx);
    if (this.map.size >= (this.opts.capacity ?? DEFAULT_CAPACITY)) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, {
      expiresAtMs: this.now() + (this.opts.ttlMs ?? DEFAULT_TTL_MS),
      result,
    });
  }

  size(): number {
    return this.map.size;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }
}

/**
 * T4.9 — Tenant isolation context for cache key derivation.
 * Pre-T4.9 the key was `sha256(queryMode + userText)` — two users
 * sharing a process with the same query got each other's results.
 * CRITICAL cross-tenant data leak (DR4 finding #9).
 *
 */
export interface TenantContext {
  namespace?: string;
  userId?: string;
  scope?: string;
}

// T4.9 — cache key now includes namespace, userId, scope separated by
// NUL bytes to prevent collision between `user: "ab"` + `scope: "cd"`
// and `user: "a"` + `scope: "bcd"` (without separator these hash identically).
function cacheKey(userText: string, queryMode: string, ctx?: TenantContext): string {
  const parts = [queryMode, ctx?.namespace ?? "", ctx?.userId ?? "", ctx?.scope ?? "", userText];
  return createHash("sha256").update(parts.join("\x00")).digest("hex");
}
