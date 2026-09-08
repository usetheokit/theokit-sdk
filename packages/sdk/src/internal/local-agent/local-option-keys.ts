import { diag } from "../diagnostics.js";

/**
 * Every key {@link import("../../types/agent.js").LocalOptions} declares.
 *
 * Kept beside the runtime check rather than derived from the type, because a TypeScript interface
 * does not exist at runtime — and the call sites that matter most are the ones TypeScript never
 * sees: a `local` object assembled from JSON, forwarded by another package, or written against a
 * different version of this SDK.
 *
 * `tests/lint/local-option-keys-are-complete.test.ts` fails when the interface gains a key this set
 * does not have. Without that, the set going stale is the only way this check can rot: a new option
 * would be reported as unknown, which is worse than the silence it replaced.
 */
const KNOWN_LOCAL_OPTION_KEYS: ReadonlySet<string> = new Set([
  "cwd",
  "settingSources",
  "compatSources",
  "hooks",
  "sandboxOptions",
  "sessionDir",
  "baseDir",
  "sessionStore",
]);

/** Keys already reported, so a long-lived host says each one once rather than once per agent. */
const reported = new Set<string>();

/**
 * Levenshtein distance, capped: only "did you mean" answers are wanted, not a ranking.
 *
 * Bounded at 3 because beyond that the suggestion stops being a suggestion — `cwd` is within 3 of
 * most short words, and a wrong pointer costs more than no pointer.
 */
function distance(a: string, b: string): number {
  // One row at a time: the full matrix needs `noUncheckedIndexedAccess` guards on every read, and
  // two rows carry the same information for a distance.
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i, ...new Array<number>(b.length).fill(0)];
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

function nearest(key: string): string | undefined {
  let best: string | undefined;
  let bestDistance = 4;
  for (const known of KNOWN_LOCAL_OPTION_KEYS) {
    const d = distance(key.toLowerCase(), known.toLowerCase());
    if (d < bestDistance) {
      bestDistance = d;
      best = known;
    }
  }
  return best;
}

/**
 * Reports keys under `local` that this SDK does not recognise.
 *
 * ## Why this is a warning and not a refusal
 *
 * Measured on 2026-09-02 (#526): `Agent.create({ local: { compatSourcess: [...] } })` — one letter
 * wrong — created the agent with no throw, no warning, nothing anywhere. A typo and an SDK too old
 * to know the option produce the identical silence, which is why `usetheokit/theokit#634` is
 * blocked: a forward written against a published SDK would be inert and nothing would say so.
 *
 * Refusing the key would break every consumer passing a forward-compatible extra — the ordinary way
 * to write code that runs against two SDK versions — and turn a diagnostic problem into an outage.
 * So it goes on the interceptable channel, once per key, with the nearest known name: a warning
 * that says only "unknown key" sends the reader to the documentation, and one letter wrong is the
 * case this exists for.
 *
 * @internal
 */
export function reportUnknownLocalOptions(local: Readonly<Record<string, unknown>> | undefined) {
  if (local === undefined) return;
  for (const key of Object.keys(local)) {
    if (KNOWN_LOCAL_OPTION_KEYS.has(key)) continue;
    if (reported.has(key)) continue;
    reported.add(key);
    const guess = nearest(key);
    const hint = guess === undefined ? "" : ` Did you mean \`${guess}\`?`;
    diag(
      `[theokit] \`local.${key}\` is not an option this SDK version knows, so it was ignored.${hint}\n`,
    );
  }
}

/** The declared surface, for the lint that keeps it in step with the interface. */
export function knownLocalOptionKeys(): ReadonlySet<string> {
  return KNOWN_LOCAL_OPTION_KEYS;
}
