/**
 * Record what a build actually wired, as opposed to what configuration asked for.
 *
 * A product that reads a project directory decides, while building, which of that directory's
 * entities it will honour: MCP servers, skills, hook events, commands. When a trust posture withholds
 * them, the build simply proceeds with fewer — and every surface that later asks "what is loaded?"
 * sees an empty list. Empty because nothing was configured and empty because everything was withheld
 * are the same emptiness to the reader, and only one of them is something they can act on.
 *
 * ## Why this is not a re-read
 *
 * The obvious implementation of any "what is loaded?" listing is to read the configuration again.
 * That is the defect this exists to prevent: a re-read cannot detect a disagreement between what
 * config asked for and what the build did, because it IS the config. The two disagree exactly when
 * something suppressed an entity, which is the case worth reporting.
 *
 * So this function is pure and parameterized. It performs no I/O, which is what makes "no second
 * read" checkable rather than promised — the caller passes the values it handed to the builder, at
 * the moment it handed them over, and what comes back is an observation of that moment.
 *
 * ## What is generic here, and what is not
 *
 * The RULE is generic: for each capability, active is the request when allowed and empty when not,
 * and suppression is only claimed when something was actually removed. The VOCABULARY is not —
 * which capabilities exist and what the entities are called belong to the product, and arrive as
 * data.
 *
 * @public
 */

import { TheokitAgentError } from "./errors.js";

/** Raised when a recorded capability has no entry in the gate. @public */
export class UngatedCapabilityError extends TheokitAgentError {
  override readonly name = "UngatedCapabilityError";
}

/** What one capability asked for, and what it got. @public */
export interface WiredEntity {
  /** The names actually handed to the builder. Empty when the capability was withheld. */
  readonly active: readonly string[];
  /**
   * The names configuration ASKED for. Equal to `active` when nothing was withheld; the difference
   * is exactly what the reader cannot otherwise see.
   */
  readonly requested: readonly string[];
  /**
   * True only when the gate is what emptied `active`.
   *
   * Deliberately false for a withheld capability that requested nothing: an untrusted directory with
   * no skills and a trusted one with no skills are the same emptiness, and a flag that fires when
   * nothing happened teaches the reader to ignore it.
   */
  readonly suppressedByTrust: boolean;
  /**
   * Each requested entity with the scope it came from (`personal`, `project`, `operator`, …), as
   * supplied by the caller. `scope` is undefined when the caller supplied none: the recorder never
   * invents one.
   */
  readonly entities: readonly WiredEntityScope[];
  /**
   * Why the capability is off, or undefined when it is on. `trust` wins over a caller-supplied
   * reason, since the gate is what actually emptied `active`.
   */
  readonly off: WiringOffReason | undefined;
}

/** One requested entity and where it came from. @public */
export interface WiredEntityScope {
  readonly name: string;
  readonly scope: string | undefined;
}

/** An entity name with its scope, as the caller knows it. @public */
export interface ScopedEntityName {
  readonly name: string;
  readonly scope: string;
}

/**
 * Why a capability is off. `suppressed-by-trust` and `disabled-by-config` are the SDK's own
 * reasons; any other string is a caller-defined reason.
 * @public
 */
export type WiringOffReasonCode = "suppressed-by-trust" | "disabled-by-config" | (string & {});

/** A capability's off reason, with optional human-readable detail. @public */
export interface WiringOffReason {
  readonly reason: WiringOffReasonCode;
  readonly detail?: string;
}

/** One entry of the list `offCapabilities` returns. @public */
export interface OffCapability extends WiringOffReason {
  readonly capability: string;
}

/**
 * The two halves of the observation: the gate that was applied, and what was handed to the builder.
 *
 * `requested` drives the shape of the record — the result has exactly its keys — while `posture`
 * only has to contain a gate for each of them. A posture that gates MORE than `requested` covers is
 * fine and normal; a posture that gates FEWER is refused, see `recordWiring`.
 *
 * Pass the values at the moment they go to the builder. Re-deriving them from configuration
 * afterwards would defeat the point: config is what was asked for, and the disagreement with what
 * was wired is the only thing this records.
 *
 * @public
 */
export interface WiringRecordInput<K extends string> {
  /**
   * The gate. Typically the output of `resolveTrustPosture`, which is what makes the name
   * `suppressedByTrust` accurate rather than decorative — a posture is the only thing in this
   * package that withholds a capability.
   *
   * It may gate MORE than `requested` covers: a posture also gates things that are not lists of
   * names, like durable memory. Those are not entities and do not appear in the record.
   */
  readonly posture: { readonly allows: Readonly<Record<string, boolean>> };
  /** Per capability, the entity names the build was given. Drives which keys the record has. */
  readonly requested: Readonly<Record<K, readonly string[]>>;
  /**
   * Optional, per capability: the scope of each requested entity, matched by name. Supplied by the
   * caller at wiring time; names with no entry get an undefined scope.
   */
  readonly scopes?: Readonly<Partial<Record<K, readonly ScopedEntityName[]>>>;
  /**
   * Optional, per capability: a non-trust reason the capability is off (for example
   * `disabled-by-config`). The caller must also have withheld it from the builder: this only labels
   * `off` and empties `active`. Trust suppression takes precedence when both apply.
   */
  readonly disabled?: Readonly<Partial<Record<K, WiringOffReason>>>;
}

const TRUST_OFF: WiringOffReason = { reason: "suppressed-by-trust" };

/**
 * Record what a build actually wired, per capability.
 *
 * For each key of `requested`: `active` is a copy of the requested names when the posture allows
 * that capability and an empty array when it does not, `requested` is always a copy of what was
 * asked for, and `suppressedByTrust` is true only when the gate emptied a NON-EMPTY request. A
 * withheld capability that requested nothing reports `false`, because a flag that fires when
 * nothing happened is a flag readers learn to ignore.
 *
 * Pure and synchronous — it performs no I/O, which is what makes "this is not a second read of the
 * configuration" checkable rather than promised.
 *
 * @returns one entry per key of `requested`, each a snapshot rather than a view of the caller's
 *   arrays — the record is read long after the build, and aliasing would make it answer with what
 *   the process holds now instead of with what was wired.
 * @throws UngatedCapabilityError when a key of `requested` has no entry in `posture.allows`. Absent
 *   is not read as denied: reporting a capability nobody gates as suppressed would send the reader
 *   looking for a trust setting that does not exist.
 * @public
 */
export function recordWiring<K extends string>(
  input: WiringRecordInput<K>,
): Readonly<Record<K, WiredEntity>> {
  const record = {} as Record<K, WiredEntity>;
  for (const [capability, requested] of Object.entries(input.requested) as [
    K,
    readonly string[],
  ][]) {
    const allowed = input.posture.allows[capability];
    if (allowed === undefined) {
      // Fail loudly rather than defaulting. Reading an absent gate as "not allowed" would report a
      // capability nobody gates as SUPPRESSED — a plausible answer, and wrong in the direction the
      // reader cannot check: they would go looking for a trust setting that does not exist.
      throw new UngatedCapabilityError(
        `capability \`${capability}\` was recorded as wired but the posture does not gate it; ` +
          `gated capabilities are: ${Object.keys(input.posture.allows).join(", ") || "(none)"}`,
      );
    }
    const off = allowed ? input.disabled?.[capability] : TRUST_OFF;
    record[capability] = {
      // Copied, not aliased. See the @returns note.
      active: off ? [] : [...requested],
      requested: [...requested],
      suppressedByTrust: !allowed && requested.length > 0,
      entities: requested.map((name) => ({
        name,
        scope: input.scopes?.[capability]?.find((e) => e.name === name)?.scope,
      })),
      off,
    };
  }
  return record;
}

/**
 * The capabilities of a wiring record that are off, each with its reason. Pure; reads only the
 * record.
 * @public
 */
export function offCapabilities(record: Readonly<Record<string, WiredEntity>>): OffCapability[] {
  const out: OffCapability[] = [];
  for (const [capability, entity] of Object.entries(record)) {
    if (entity.off !== undefined) out.push({ capability, ...entity.off });
  }
  return out;
}
