/**
 * Consecutive-timeout circuit breaker for Active Memory recall.
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

/**
 * Stops calling a recall path that keeps timing out.
 *
 * After `maxTimeouts` consecutive timeouts on a key (default 3) the breaker
 * opens and {@link CircuitBreaker.shouldSkip} reports `true` until `cooldownMs`
 * has elapsed (default 60s). The first `shouldSkip` after the cooldown closes
 * the breaker and resets the counter, so it re-opens only after another full run
 * of timeouts.
 *
 * It counts timeouts, not failures. An error recorded by neither
 * `recordTimeout` nor `recordSuccess` leaves the counter where it was, so a call
 * path that throws rather than hanging will never trip it.
 *
 * State is per key and held in this instance, which is what keeps two agents in
 * one process from sharing a counter. Construct one per agent and pass a stable
 * key.
 */
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
