import { ConfigurationError } from "../../../errors.js";

/*
 * The declared fact ceiling of a memory store (B-380): one validator and one refusal, shared by
 * the markdown writer and by `@theokit/sdk-memory`'s in-memory provider through the
 * `internal/memory-store` barrel. Two write families refuse with the same code, so they refuse
 * with the same words; a second copy of either function is a second place for them to drift.
 */

/**
 * The ceiling a caller declared, or `undefined` when none was declared.
 *
 * Validated before anything touches disk, because a ceiling that cannot be met (0, a negative or
 * fractional number, a string, `null`) would otherwise surface later as a refusal of every write
 * that names the wrong cause.
 *
 * @throws ConfigurationError with code `invalid_memory_ceiling` when the value is declared and is
 *   not a positive safe integer.
 */
export function resolveMaxFacts(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  throw new ConfigurationError(
    `memory.maxFacts must be a positive integer, got ${String(value)}.`,
    {
      code: "invalid_memory_ceiling",
    },
  );
}

/**
 * The refusal of a new fact at a store's declared ceiling: where the store is, how many facts it
 * holds, the ceiling, and what to consolidate. `remedy` is the store-specific way to make room.
 *
 * Returned, not thrown, so each writer throws it at the point where it has written nothing.
 */
export function ceilingReachedError(
  where: string,
  count: number,
  maxFacts: number,
  remedy: string,
): ConfigurationError {
  return new ConfigurationError(
    `Memory at ${where} holds ${count} facts, its declared ceiling (maxFacts = ${maxFacts}). ` +
      `Nothing was written. Consolidate before writing more: ${remedy}.`,
    { code: "memory_ceiling_reached" },
  );
}
