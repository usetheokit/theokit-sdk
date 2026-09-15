/**
 * Context file loaders + truncation (T1.2, ADRs D154 / D155 / D159).
 *
 * Reads context source files from disk, applies the per-file size cap
 * with 70%/20% head/tail truncation, and emits the
 * `context_files_truncated` telemetry counter when the cap fires.
 * Pure (no I/O) for `truncateWithMarker` — testable in isolation.
 *
 * @internal
 */

import { readFile } from "node:fs/promises";

const HEAD_RATIO = 0.7;
const TAIL_RATIO = 0.2;
const MARKER = "\n\n…[truncated by theokit]\n\n";

/** Default per-file cap (40k chars ≈ 10k tokens). D155. */
export const DEFAULT_MAX_BYTES_PER_FILE = 40_000;

export interface LoadedSource {
  /** Absolute path the content came from. */
  readonly source: string;
  readonly content: string;
  readonly originalBytes: number;
  readonly truncated: boolean;
}

export interface TruncateResult {
  readonly truncated: boolean;
  readonly finalContent: string;
}

/**
 * Cap `content` at `max` characters with 70%/20% head/tail truncation
 * and an explicit marker. Pure — no I/O, no telemetry.
 *
 * EC-C: when `max <= MARKER.length`, skip the marker entirely and
 * return a head-only slice. Without this guard, `budget = max -
 * MARKER.length` would go negative and `content.slice(-tailBytes)`
 * would slice from the END of the string rather than truncating.
 *
 * EC-H: codepoint integrity — `String.slice()` operates on UTF-16
 * code units, which can split surrogate pairs. We accept that
 * trailing/leading replacement chars (U+FFFD) may appear at boundaries.
 * Modern LLMs tolerate them; byte-exact safety would require Buffer
 * slicing + TextDecoder with `fatal: true` retry, which adds complexity
 * without value.
 *
 * Deliberately untagged for the public surface. A tag was here and no entry exported it, so the
 * docblock promised a symbol
 * nobody could import. Exporting it was the other option and the wrong one: this is a pure
 * truncation helper whose docblock describes implementation edge cases (EC-C, EC-H), not a
 * contract — and an export is a semver commitment somebody then has to keep.
 */
export function truncateWithMarker(content: string, max: number): TruncateResult {
  if (content.length <= max) {
    return { truncated: false, finalContent: content };
  }
  // EC-C: max too small to fit even the marker — return head-only slice.
  if (max <= MARKER.length) {
    return { truncated: true, finalContent: content.slice(0, max) };
  }
  const budget = max - MARKER.length;
  const headBytes = Math.floor(budget * (HEAD_RATIO / (HEAD_RATIO + TAIL_RATIO)));
  const tailBytes = budget - headBytes;
  return {
    truncated: true,
    finalContent: content.slice(0, headBytes) + MARKER + content.slice(-tailBytes),
  };
}

/**
 * Read a file from disk and apply the per-file cap. Emits telemetry
 * counter when truncation fires.
 *
 * EC-G: file deleted between discovery and read (FS race) → returns
 * `undefined`, never throws.
 *
 * @internal
 */
export async function loadPlainMarkdown(
  absPath: string,
  opts: { maxBytesPerFile?: number } = {},
): Promise<LoadedSource | undefined> {
  const max = opts.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE;
  let content: string;
  try {
    content = await readFile(absPath, "utf8");
  } catch {
    // EC-G: ENOENT / EACCES / etc → caller treats as missing.
    return undefined;
  }
  const { truncated, finalContent } = truncateWithMarker(content, max);
  if (truncated) {
    emitTruncationCounter(absPath);
  }
  return {
    source: absPath,
    content: finalContent,
    originalBytes: content.length,
    truncated,
  };
}

/**
 * EC-L: telemetry no-op when OTel is not imported. We import the tracer
 * lazily and use `safeCall` so the lookup never throws and never pulls
 * OTel into the import graph for users without `@opentelemetry/api`
 * installed.
 *
 * @internal
 */
function emitTruncationCounter(source: string): void {
  // Lazy resolution via globalThis avoids static import of telemetry/tracer.
  // Tests can spy via the same path; production users without OTel see no-op.
  const tracer = (
    globalThis as { __theokit_tracer?: { inc?: (k: string, attrs: unknown) => void } }
  ).__theokit_tracer;
  if (tracer?.inc === undefined) return;
  try {
    tracer.inc("context_files_truncated", { file: source });
  } catch {
    // Telemetry must never break the loader.
  }
}
