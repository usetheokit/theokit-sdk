/**
 * Doom-loop guard — detects consecutive IDENTICAL tool calls (same name + same canonical input)
 * and escalates `ok` → `soft` (one-time nudge) → `hard` (stop). Inspection is TOTAL — `signatureOf`
 * and `inspect` never throw on any tool-call input. The constructor validates thresholds and throws
 * a typed `ConfigurationError` on invalid config (fail-fast at the boundary — a 0/negative/non-integer
 * threshold is a caller bug, not a loop input). Ported in shape from a peer `LoopDetectionTracker`.
 * Complements the empty-round `no_progress` terminal (a DIFFERENT failure mode: model stuck repeating
 * vs model gone silent).
 * @internal
 */

import { ConfigurationError } from "../../errors.js";

/** Verdict from {@link DoomLoopTracker.inspect}. `soft` carries a guidance message, `hard` a stop message. */
export interface DoomLoopVerdict {
  kind: "ok" | "soft" | "hard";
  message?: string;
}

/** Consecutive-identical thresholds. `soft` fires once (at exactly the count); `hard` stops. */
export interface DoomLoopConfig {
  softThreshold: number;
  hardThreshold: number;
  /** Consecutive same-tool calls with CHANGING arguments but an unchanged result (argument churn).
   *  Soft nudge at `churnThreshold - 2`, hard stop at `churnThreshold`. */
  churnThreshold: number;
}

/** Public config on a send: `false` disables the guard; an object tunes the thresholds; absent = on. */
export type DoomLoopOption = false | Partial<DoomLoopConfig>;

/** Resolve the per-send config to a tracker instance (default ON) or `undefined` when disabled. @internal */
export function createDoomLoopTracker(option?: DoomLoopOption): DoomLoopTracker | undefined {
  if (option === false) return undefined;
  return new DoomLoopTracker(option);
}

const DEFAULT_CONFIG: DoomLoopConfig = { softThreshold: 3, hardThreshold: 5, churnThreshold: 6 };

/** Fail-fast on caller misconfig: both thresholds must be positive integers. A `0` / negative /
 *  non-integer would silently misbehave (stop on turn 1, or never fire). `soft >= hard` is NOT
 *  rejected — it is a valid "stop hard with no earlier nudge" config (hard is checked first, so it
 *  just wins and the nudge is suppressed), which also keeps `{ hardThreshold: N }` ergonomic. @internal */
function assertValidThresholds(soft: number, hard: number, churn: number): void {
  for (const [label, value] of [
    ["softThreshold", soft],
    ["hardThreshold", hard],
    ["churnThreshold", churn],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new ConfigurationError(
        `doomLoop.${label} must be a positive integer (received ${value}).`,
        { code: "invalid_doom_loop_threshold" },
      );
    }
  }
}

/** Recursively key-sort an object so `{a,b}` and `{b,a}` canonicalize identically. */
function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return out;
}

/** Canonical identity of a tool call: `name` + NUL delimiter + key-sorted JSON of `input`.
 *  The `\u0000` delimiter is collision-proof (it cannot occur in a tool name), so
 *  `{name:"a b", input:"c"}` and `{name:"a", input:"b c"}` never alias. Order-insensitive and
 *  total (circular / non-serializable input falls back to `String()`, never throws). @internal */
export function signatureOf(call: { name: string; input: unknown }): string {
  const { input } = call;
  let inputSig: string;
  if (input === null || input === undefined) inputSig = "null";
  else if (typeof input !== "object") inputSig = String(input);
  else {
    try {
      inputSig = JSON.stringify(sortKeys(input)) ?? "null";
    } catch {
      inputSig = String(input);
    }
  }
  return `${call.name}\u0000${inputSig}`;
}

/** Per-run detector of consecutive identical tool calls. Owned by one agent-loop run, inspected
 *  sequentially per turn (no shared state across concurrent runs). @internal */
export class DoomLoopTracker {
  readonly #config: DoomLoopConfig;
  #lastSignature = "";
  #count = 0;
  #lastName = "";
  #lastResult: string | undefined;
  #churn = 0;

  constructor(config?: Partial<DoomLoopConfig>) {
    const softThreshold = config?.softThreshold ?? DEFAULT_CONFIG.softThreshold;
    const hardThreshold = config?.hardThreshold ?? DEFAULT_CONFIG.hardThreshold;
    const churnThreshold = config?.churnThreshold ?? DEFAULT_CONFIG.churnThreshold;
    assertValidThresholds(softThreshold, hardThreshold, churnThreshold);
    this.#config = { softThreshold, hardThreshold, churnThreshold };
  }

  inspect(call: { name: string; input: unknown; result?: string }): DoomLoopVerdict {
    const signature = signatureOf(call);
    const identical = signature === this.#lastSignature;
    const churning =
      !identical &&
      call.name === this.#lastName &&
      call.result !== undefined &&
      call.result === this.#lastResult;
    this.#churn = churning ? this.#churn + 1 : 1;
    this.#lastName = call.name;
    this.#lastResult = call.result;
    this.#count = identical ? this.#count + 1 : 1;
    this.#lastSignature = signature;
    const count = this.#count;
    const churn = this.#churn;
    const churnHard = this.#config.churnThreshold;
    if (churn >= churnHard) {
      return {
        kind: "hard",
        message: `Detected argument churn: ${churn} consecutive calls to \`${call.name}\` with different arguments and no change in the result; stopping to avoid a loop.`,
      };
    }
    if (churn > 1 && churn === Math.max(2, churnHard - 2)) {
      return {
        kind: "soft",
        message: `Detected argument churn: ${churn} consecutive calls to \`${call.name}\` with different arguments and no change in the result; try a different approach.`,
      };
    }
    if (count >= this.#config.hardThreshold) {
      return {
        kind: "hard",
        message: `Detected ${count} consecutive identical calls to \`${call.name}\`; stopping to avoid a loop.`,
      };
    }
    // `soft` fires ONLY at ==softThreshold (not `>=`) so the nudge cannot spam between soft/hard (EC-1).
    if (count === this.#config.softThreshold) {
      return {
        kind: "soft",
        message: `Detected ${count} consecutive identical calls to \`${call.name}\`; try a different approach.`,
      };
    }
    return { kind: "ok" };
  }

  reset(): void {
    this.#lastSignature = "";
    this.#count = 0;
    this.#lastName = "";
    this.#lastResult = undefined;
    this.#churn = 0;
  }
}

/**
 * Inspect a turn's tool calls in order, returning the FIRST non-`ok` verdict (a `hard` stop wins
 * over a `soft` nudge encountered earlier in the same turn). Every call advances the tracker, so a
 * turn emitting the same call twice counts as two. Pure over the tracker's state; never throws.
 * @internal
 */
export function firstDoomLoopVerdict(
  tracker: DoomLoopTracker,
  calls: readonly { name: string; input: unknown; result?: string }[],
): DoomLoopVerdict {
  let escalation: DoomLoopVerdict = { kind: "ok" };
  for (const call of calls) {
    const v = tracker.inspect(call);
    if (v.kind === "hard") return v;
    if (v.kind === "soft" && escalation.kind === "ok") escalation = v;
  }
  return escalation;
}
