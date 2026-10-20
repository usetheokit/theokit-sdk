/**
 * T3.10c — Model capability registry (DR3 #17).
 *
 * Typed per-model flags that let the SDK gate features at the boundary
 * (before hitting the provider) instead of letting opaque 400s surface.
 *
 * Resolution algorithm:
 *   1. Strip routing prefixes (openrouter/, vertex/, bedrock/) AND the
 *      OpenRouter `:variant` suffix (:free/:nitro/…) to find the bare vendor id.
 *   2. Exact match in the `EXACT` catalog → return entry.
 *   3. Vendor inference (e.g., `claude-*` → `anthropic/claude-*`) → return entry.
 *   4. No match → conservative defaults (all false, minimum tokens).
 *
 * Module is internal, but `ModelCapabilities` + `resolveModelCapabilities` are
 * re-exported publicly via the `@theokit/sdk/models` subpath (see their @public tags).
 */

/**
 * Per-model capability shape. Consumers use this to gate features at
 * the SDK boundary (before request construction, not after 400).
 *
 * @public
 */
export interface ModelCapabilities {
  supportsVision: boolean;
  supportsStructuredOutput: boolean;
  supportsToolUse: boolean;
  supportsCacheControl: boolean;
  maxContextTokens: number;
  maxOutputTokens: number;
}

const CONSERVATIVE_DEFAULTS: ModelCapabilities = {
  supportsVision: false,
  supportsStructuredOutput: false,
  supportsToolUse: false,
  supportsCacheControl: false,
  maxContextTokens: 4096,
  maxOutputTokens: 4096,
};

/** Routing prefixes to strip to find the underlying vendor model. */
const ROUTING_PREFIXES = ["openrouter/", "vertex/", "bedrock/"] as const;

import { getCatalogModelInfo } from "../providers/catalog-loader.js";
import type { CatalogModel } from "../providers/catalog-schema.js";

/** Map a catalog model block (models.dev shape) to the SDK's ModelCapabilities (M44 — catalog-backed). */
function capsFromCatalog(m: CatalogModel): ModelCapabilities {
  return {
    supportsVision: m.modalities?.input?.includes("image") ?? m.attachment ?? false,
    supportsStructuredOutput: m.structured_output ?? false,
    supportsToolUse: m.tool_call ?? false,
    supportsCacheControl: (m as { cache_control?: boolean }).cache_control ?? false,
    maxContextTokens: m.limit?.context ?? CONSERVATIVE_DEFAULTS.maxContextTokens,
    maxOutputTokens: m.limit?.output ?? CONSERVATIVE_DEFAULTS.maxOutputTokens,
  };
}

/**
 * Resolve per-model capability flags (vision/structured-output/tool-use/cache +
 * `maxContextTokens`/`maxOutputTokens`) for a model id. Pure, sync, offline (a
 * static catalog — no network). Strips routing prefixes (`openrouter/`/`vertex/`/
 * `bedrock/`) and OpenRouter `:variant` suffixes before lookup; unknown models get
 * conservative defaults. Public via `@theokit/sdk/models`.
 *
 * @public
 */
export function resolveModelCapabilities(modelId: string): ModelCapabilities {
  const bare = stripVariantSuffix(stripRoutingPrefix(modelId));
  // M44 — the catalog model-info index replaced the hand-curated EXACT map (single source of truth; the
  // vendored provider-catalog.json carries the migrated data — parity-tested against the old map snapshot).
  const fromIndex = getCatalogModelInfo(bare);
  if (fromIndex !== undefined) return capsFromCatalog(fromIndex);
  // Routing-prefixed models (vertex/claude-3-5-sonnet) strip to bare
  // model name without vendor. Try inferring the vendor from the name.
  const withVendor = inferVendorPrefix(bare);
  if (withVendor !== bare) {
    const vendored = getCatalogModelInfo(withVendor);
    if (vendored !== undefined) return capsFromCatalog(vendored);
  }
  return CONSERVATIVE_DEFAULTS;
}

/**
 * B-412 / B-475 — whether a model id names an Anthropic model the loop sends cacheable system
 * blocks to. Decided by the id, not by the catalog's `supportsCacheControl`, which is false for the
 * Anthropic ids measured on OpenRouter. After the same routing prefixes the capability lookup
 * strips (`openrouter/`, `vertex/`, `bedrock/`), the id must start with `anthropic/` or `claude`,
 * so Vertex Anthropic ids match and Bedrock ids (`anthropic.claude-…`) do not.
 * @internal
 */
export function isAnthropicFamilyModel(modelId: string | undefined): boolean {
  if (modelId === undefined) return false;
  return /^(anthropic\/|claude)/.test(stripRoutingPrefix(modelId));
}

function stripRoutingPrefix(modelId: string): string {
  for (const prefix of ROUTING_PREFIXES) {
    if (modelId.startsWith(prefix)) return modelId.slice(prefix.length);
  }
  return modelId;
}

/**
 * Strip an OpenRouter variant suffix (`:free`/`:nitro`/`:floor`/`:beta`/…) so the
 * catalog lookup hits the underlying model. Model slugs contain no `:` except the
 * variant separator, so cutting at the first `:` is safe.
 */
function stripVariantSuffix(modelId: string): string {
  const i = modelId.indexOf(":");
  return i >= 0 ? modelId.slice(0, i) : modelId;
}

/** Infer vendor prefix from bare model name for routing-prefixed lookups. */
function inferVendorPrefix(bare: string): string {
  if (bare.startsWith("claude")) return `anthropic/${bare}`;
  if (bare.startsWith("gpt-") || bare.startsWith("o1") || bare.startsWith("o3"))
    return `openai/${bare}`;
  if (bare.startsWith("gemini")) return `google/${bare}`;
  return bare;
}
