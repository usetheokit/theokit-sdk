import { trimTrailingSlashes } from "../trim-trailing-slashes.js";
import { parseModelId } from "./model-identifier.js";

/**
 * A UI-friendly model option — the shape a `<select>`/dropdown consumes.
 *
 * Public via `@theokit/sdk/models`.
 *
 * @public
 */
export interface ModelOption {
  /** The original model id (what you pass back to the SDK). */
  value: string;
  /** Best-effort human label (see {@link humanizeModelName}). */
  label: string;
  /** Provider from the slug prefix, or `undefined` when none. */
  provider: string | undefined;
}

/** Tokens rendered upper-case rather than title-case. */
const ACRONYMS = new Set(["gpt", "ai", "hd", "ui", "api", "sdk", "llm", "xl"]);

function prettyToken(token: string): string {
  if (ACRONYMS.has(token.toLowerCase())) return token.toUpperCase();
  return token.charAt(0).toUpperCase() + token.slice(1);
}

/**
 * Turn a model id into a best-effort human label: strip the routing/vendor
 * prefix to the core model segment, split on `-`/`_`/`.`/whitespace, title-case
 * each token (known acronyms upper-cased), and append an OpenRouter `:variant`
 * in parentheses. Deterministic, pure, dependency-free.
 *
 * Best-effort, NOT vendor-canonical: `"anthropic/claude-3-5-sonnet"` →
 * `"Claude 3 5 Sonnet"`. A UI wanting exact marketing names overrides per id.
 *
 * Public via `@theokit/sdk/models`.
 *
 * @public
 */
export function humanizeModelName(modelId: string): string {
  const { name } = parseModelId(modelId);
  if (name.length === 0) return "";
  const colon = name.indexOf(":");
  // Strip a trailing slash so a typo'd `gpt-4o/` keeps its name (not lost to an
  // empty last segment).
  //
  // Done by index rather than with `/\/+$/`, and the difference is not stylistic: that pattern
  // consumes slashes to the end of the string at every start position and then backtracks
  // looking for an end-anchor that is not there (CodeQL js/polynomial-redos #6). This function
  // is `@public` and takes a caller-supplied model id. Measured on a run of slashes followed by
  // one other character: 25_000 took 496 ms, 100_000 took 31_305 ms — half a minute of pinned
  // CPU to render a label. Walking back from the end is linear and cannot backtrack.
  const base = trimTrailingSlashes(colon >= 0 ? name.slice(0, colon) : name);
  const variant = colon >= 0 ? name.slice(colon + 1) : "";
  const lastSlash = base.lastIndexOf("/");
  const core = lastSlash >= 0 ? base.slice(lastSlash + 1) : base;
  const label = core
    .split(/[-_.\s]+/)
    .filter((t) => t.length > 0)
    .map(prettyToken)
    .join(" ");
  if (label.length === 0) return variant; // no base label (e.g. ":free") → bare variant
  return variant.length > 0 ? `${label} (${variant})` : label;
}

/**
 * Build a {@link ModelOption} (`{ value, label, provider }`) for a model id —
 * a dropdown-ready entry composing {@link humanizeModelName} + `parseModelId`.
 *
 * Public via `@theokit/sdk/models`.
 *
 * @public
 */
export function toModelOption(modelId: string): ModelOption {
  return {
    value: modelId,
    label: humanizeModelName(modelId),
    provider: parseModelId(modelId).provider,
  };
}
