/**
 * Consecutive-failure circuit breaker — a cross-cutting resilience primitive.
 *
 * Used by Active Memory recall (timeout-driven) and the LLM credential pool
 * (429/terminal-failure-driven). Domain-neutral: it counts consecutive
 * failure events per key and trips after N, staying open for `cooldownMs`.
 *
 * Mirrors peer-project's `circuitBreakerMaxTimeouts` + `circuitBreakerCooldownMs`
 * config: after N consecutive timeouts the breaker trips and `shouldSkip`
 * returns `true` until `cooldownMs` has elapsed. A successful recall resets
 * the counter immediately.
 *
 * Per-key isolation so two agents in the same process don't share a counter.
 *
 * @internal
 */

export interface CircuitBreakerOptions {
  maxTimeouts?: number;
  cooldownMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

interface KeyState {
  consecutiveTimeouts: number;
  cooldownUntilMs: number;
}

const DEFAULT_MAX_TIMEOUTS = 3;
const DEFAULT_COOLDOWN_MS = 60_000;

export class CircuitBreaker {
  private readonly states = new Map<string, KeyState>();

  constructor(private readonly opts: CircuitBreakerOptions = {}) {}

  /** @returns true when the breaker is open and the call should be skipped. */
  shouldSkip(key: string): boolean {
    const state = this.states.get(key);
    if (state === undefined) return false;
    if (state.cooldownUntilMs === 0) return false;
    if (this.now() < state.cooldownUntilMs) return true;
    // Cooldown elapsed — close the breaker.
    state.cooldownUntilMs = 0;
    state.consecutiveTimeouts = 0;
    return false;
  }

  recordSuccess(key: string): void {
    const state = this.states.get(key);
    if (state === undefined) return;
    state.consecutiveTimeouts = 0;
    state.cooldownUntilMs = 0;
  }

  recordTimeout(key: string): void {
    const state = this.states.get(key) ?? { consecutiveTimeouts: 0, cooldownUntilMs: 0 };
    state.consecutiveTimeouts += 1;
    if (state.consecutiveTimeouts >= (this.opts.maxTimeouts ?? DEFAULT_MAX_TIMEOUTS)) {
      state.cooldownUntilMs = this.now() + (this.opts.cooldownMs ?? DEFAULT_COOLDOWN_MS);
    }
    this.states.set(key, state);
  }

  /** @internal — tests inspect counter state. */
  inspect(key: string): Readonly<KeyState> {
    return this.states.get(key) ?? { consecutiveTimeouts: 0, cooldownUntilMs: 0 };
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }
}
