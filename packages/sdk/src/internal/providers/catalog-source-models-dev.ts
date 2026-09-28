import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { Retry } from "../../retry.js";
import { diag } from "../diagnostics.js";
import { boundFetch } from "../runtime-fetch.js";
import { registerBuiltins } from "./builtin/index.js";
import { getCatalogModelInfo, loadProviderCatalog, patchModelInfo } from "./catalog-loader.js";
import { catalogModelSchema } from "./catalog-schema.js";
import { getProviderProfile } from "./registry.js";

/**
 * M44 — the OPTIONAL models.dev catalog source. Explicit opt-in ONLY (`refreshModelCatalog()`): the SDK
 * NEVER fetches at startup or per-request — the vendored catalog + any existing disk cache are the offline
 * base, and every failure mode fails CLOSED back to them (ROADMAP constraint: no runtime hard network dep).
 *
 * The models.dev consumption mechanism:
 * disk cache with mtime TTL, atomic tempfile+rename write, corrupt-cache delete-and-fall-through, kill-switch
 * env. Library adaptations: NO background refresh loop (a consumer composes refresh with the SDK's cron);
 * TTL 1h (not 5min — no background refresher to keep it warm); no cross-process flock v1 (atomic rename +
 * idempotent upstream content — at most one wasted fetch).
 *
 * @internal (the public surface is `refreshModelCatalog` re-exported via `@theokit/sdk/models`)
 */

const DEFAULT_URL = "https://models.dev/api.json";

/**
 * Ceiling on a fetched catalog, before it is parsed or written to the cache.
 *
 * The response body was read with `res.text()` and persisted with no bound, so a host serving a
 * multi-gigabyte document would have been materialised in memory and then written to disk. The
 * default URL is trusted, but `THEOKIT_MODELS_URL` lets an operator point this anywhere, and a
 * limit is the difference between "we only fetch from a host we trust" and "we cannot be hurt by
 * one we do not".
 *
 * 32 MiB is roughly 40x the real catalog (~800 KiB in 2026-08), so it bounds the failure without
 * being a number anyone has to tune when models.dev grows.
 */
const MAX_CATALOG_BYTES = 32 * 1024 * 1024;
const TTL_MS = 60 * 60 * 1000; // 1 hour
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Arguments to `refreshModelCatalog`, the SDK's only network trigger for model metadata.
 *
 * `url` wins over the `THEOKIT_MODELS_URL` environment variable, which in turn wins over
 * `https://models.dev/api.json`. A non-default URL gets its own cache file, named by a hash of
 * the URL, so switching sources never reads another source's cache.
 *
 * `force` skips only the freshness check — it does not skip the kill switch. When
 * `THEOKIT_DISABLE_MODELS_FETCH` is set to anything other than an empty string, `"0"` or
 * `"false"`, the call returns `source: "skipped"` with no fetch and no cache read, whatever
 * `force` says.
 *
 * Without `force`, a cache file whose mtime is under an hour old is served directly and no
 * request is made.
 *
 * `deps` exists so tests can drive the fetch and the clock; production leaves it unset.
 */
export interface RefreshModelCatalogOptions {
  /** Override the source URL (`THEOKIT_MODELS_URL` env also honored). */
  url?: string;
  /** Bypass the TTL freshness gate. */
  force?: boolean;
  /** Injected for tests. */
  deps?: { fetch?: typeof fetch; now?: () => number };
}

/**
 * What `refreshModelCatalog` did. It never throws on a failed refresh, so this is the only place
 * the outcome is reported.
 *
 * `source` is `"network"` only when a request succeeded, its body parsed as JSON, and the models
 * were patched in. Every failure path — kill switch aside — returns `"cache"`: an HTTP error
 * after retries, a timeout, an unparseable body, or a patch that threw. `"cache"` therefore means
 * "serving what was already there", which may be a fresh cache, a stale one, or nothing but the
 * vendored catalog. Read `models` to tell those apart. `"skipped"` means the kill switch was set.
 *
 * `models` counts the models patched into the index during this call, not the catalog's size. It
 * counts each model once even when the provider has aliases and the model is written under several
 * index keys, and it excludes models whose payload failed schema validation and models under
 * providers the SDK does not know. It is 0 whenever there was no cache to fall back on, and 0 for
 * `"skipped"`.
 *
 * A cache write that fails is logged and otherwise ignored: the result can still say `"network"`
 * with the data live in memory and nothing on disk.
 */
export interface RefreshModelCatalogResult {
  /** Where the data came from: a fresh network fetch, the still-fresh disk cache, or skipped entirely. */
  source: "network" | "cache" | "skipped";
  /** How many models were patched into the index. */
  models: number;
}

/** The cache file for a source URL (custom URLs get a hash-suffixed name). */
export function cachePathFor(url: string): string {
  // M44 L8 fix — honor the SDK home override so tests and multi-home setups never touch the real ~/.theokit.
  const base = process.env.THEOKIT_HOME?.trim() || join(homedir(), ".theokit");
  const dir = join(base, "cache", "models-dev");
  if (url === DEFAULT_URL) return join(dir, "api.json");
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 12);
  return join(dir, `api-${hash}.json`);
}

/** Atomic write: temp file + rename (crash mid-write never leaves a partial cache). */
function writeCacheAtomic(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(tmp, body);
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // best effort
    }
    throw err;
  }
}

/**
 * M44 H3 fix — models.dev provider ids ≠ theokit ids (google↔google-gemini, zai↔zhipu, togetherai↔together,
 * fireworks-ai↔fireworks, amazon-bedrock↔bedrock, google-vertex↔vertex). The RUNTIME mapping mirrors the
 * maintenance script's table; targets resolve against the CATALOG entries (id + aliases — the same namespace
 * the vendored index uses) first, then the registry.
 */
const MODELS_DEV_ID_MAP: Record<string, string> = {
  google: "google-gemini",
  zai: "zhipu",
  togetherai: "together",
  "fireworks-ai": "fireworks",
  "amazon-bedrock": "bedrock",
  "google-vertex": "vertex",
};

let _catalogTargets: Map<string, { keys: string[] }> | undefined;
/** external-id → the index keys (entry id + aliases) its models patch under. Lazy; catalog-first. */
function catalogTargets(): Map<string, { keys: string[] }> {
  if (_catalogTargets !== undefined) return _catalogTargets;
  _catalogTargets = new Map();
  try {
    for (const entry of Object.values(loadProviderCatalog())) {
      const keys = [entry.id, ...(entry.aliases ?? [])];
      for (const k of keys) {
        if (!_catalogTargets.has(k)) _catalogTargets.set(k, { keys });
      }
    }
  } catch {
    // catalog unavailable — registry fallback below still works
  }
  return _catalogTargets;
}

function resolvePatchKeys(externalId: string): string[] | undefined {
  const mapped = MODELS_DEV_ID_MAP[externalId] ?? externalId;
  const fromCatalog = catalogTargets().get(mapped);
  if (fromCatalog !== undefined) return fromCatalog.keys;
  const profile = getProviderProfile(mapped);
  if (profile !== undefined) return [profile.name, ...(profile.aliases ?? [])];
  return undefined;
}

/** Parse + patch the index from an api.json payload. Unknown providers are skipped with WARN (once each). */
// PRE-EXISTING debt, exposed when M75 fixed the Biome config that used to abort before
// sweeping these files (a nested root under refactor/). It is not new code and was not touched
// by M75; refactoring SDK internals without review would trade a visible problem for a diff
// risky. Tracked in usetheodev/theokit-sdk#151.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: validates and merges an UNTRUSTED upstream payload (models.dev api.json) shape by shape, dropping a single bad model rather than the file. Each branch is a distinct malformed input; merging them loses which one was seen.
function patchIndexFromApiJson(raw: unknown): number {
  if (typeof raw !== "object" || raw === null) return 0;
  let patched = 0;
  const skipped: string[] = [];
  for (const [providerId, provider] of Object.entries(raw as Record<string, unknown>)) {
    const models = (provider as { models?: Record<string, unknown> })?.models;
    if (models === undefined || typeof models !== "object") continue;
    // Enrich ONLY providers the SDK knows — models.dev's npm/api fields cannot be mapped to a theokit
    // apiMode/authType safely, so unknown providers are data we cannot route.
    const keys = resolvePatchKeys(providerId);
    if (keys === undefined) {
      skipped.push(providerId);
      continue;
    }
    for (const [modelId, rawModel] of Object.entries(models)) {
      const parsed = catalogModelSchema.safeParse(rawModel);
      if (!parsed.success) continue; // malformed model — drop silently (live data, additive drift expected)
      for (const key of keys) patchModelInfo(`${key}/${modelId}`, parsed.data);
      patched++;
    }
  }
  if (skipped.length > 0) {
    diag(
      `[theokit-sdk] WARN: models-dev refresh skipped ${skipped.length} unknown provider(s) (e.g. ${skipped.slice(0, 3).join(", ")})\n`,
    );
  }
  return patched;
}

/**
 * Load an existing disk cache into the index (called by refresh when fresh, or opportunistically by a
 * consumer at startup — NEVER fetches). Corrupt cache → delete + fall through to vendored data.
 */
export function loadCacheIntoIndex(url: string = DEFAULT_URL): number {
  const path = cachePathFor(url);
  let body: string;
  try {
    body = readFileSync(path, "utf-8");
  } catch {
    return 0; // no cache — vendored data only
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // corrupt cache: delete and fall through to the vendored catalog.
    // M44 L9 fix — only a PARSE failure is cache corruption; a patch error must never delete a valid cache.
    try {
      unlinkSync(path);
    } catch {
      // best effort
    }
    diag(`[theokit-sdk] WARN: corrupt models-dev cache deleted (${path})\n`);
    return 0;
  }
  try {
    return patchIndexFromApiJson(parsed);
  } catch (err) {
    diag(`[theokit-sdk] WARN: models-dev cache patch failed (${(err as Error).message})\n`);
    return 0;
  }
}

/**
 * The kill switch, read from the environment.
 *
 * Truthy-only by design (M44 L11): a presence check would treat `THEOKIT_DISABLE_MODELS_FETCH=0`
 * and `=false` as "disabled", which is the opposite of what anyone writing them means.
 */
function fetchDisabledByEnv(): boolean {
  const kill = process.env.THEOKIT_DISABLE_MODELS_FETCH;
  return kill !== undefined && kill !== "" && kill !== "0" && kill.toLowerCase() !== "false";
}

/**
 * The TTL gate: a cache file younger than {@link TTL_MS} serves without touching the network.
 *
 * Returns `undefined` when there is no usable cache — including when `statSync` throws, which is
 * how "no cache file" arrives. That is the ONE failure this step owns, and its fallback is simply
 * to let the caller proceed to the fetch.
 */
function servedFromFreshCache(
  url: string,
  path: string,
  now: () => number,
): RefreshModelCatalogResult | undefined {
  try {
    if (now() - statSync(path).mtimeMs >= TTL_MS) return undefined;
  } catch {
    return undefined; // no cache — proceed to fetch
  }
  return { source: "cache", models: loadCacheIntoIndex(url) };
}

/**
 * Fetch the catalog, bound its size, and prove it parses before anyone persists it.
 *
 * Returns `undefined` after logging when ANY of that fails — timeout, non-2xx, oversize, unparseable
 * body. The fallback this step owns is "serve what we already have", and the caller applies it.
 * Splitting the step from its fallback was the objection recorded in the suppression this replaces;
 * the fallback is not separated, it is named — `undefined` means "this step could not produce a
 * body", and there is exactly one thing to do about that.
 */
async function fetchCatalogBody(url: string, fetchImpl: typeof fetch): Promise<string | undefined> {
  try {
    const res = await Retry.run(
      async () => {
        const r = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r;
      },
      // 2 transient retries with backoff; every error here is worth one more try —
      // the whole call is already fail-closed at the caller.
      { retries: 2, isRetryable: () => true, initialDelayMs: 200 },
    );
    const declaredLength = Number(res.headers.get("content-length") ?? Number.NaN);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_CATALOG_BYTES) {
      throw new Error(`catalog too large: ${declaredLength} bytes declared`);
    }
    const body = await res.text();
    // Checked again after reading: `content-length` is the server's claim, and a server that
    // omits it or lies about it is exactly the one worth bounding. Both checks are cheap and
    // neither alone is sufficient.
    if (body.length > MAX_CATALOG_BYTES) {
      throw new Error(`catalog too large: ${body.length} bytes received`);
    }
    JSON.parse(body); // validate before persisting — never cache garbage
    return body;
  } catch (err) {
    diag(
      `[theokit-sdk] WARN: models-dev refresh failed (${(err as Error).message}) — serving existing data\n`,
    );
    return undefined;
  }
}

/**
 * Persist the fetched body and patch it into the index.
 *
 * Two independent failures with two different consequences, which is why they are two try blocks
 * and not one: a cache write that fails costs the NEXT process a fetch and nothing more, so the run
 * continues; a patch that fails means this body never reached the index, so the index is whatever it
 * was and the result says `cache`.
 */
function persistAndPatch(path: string, body: string): RefreshModelCatalogResult {
  try {
    writeCacheAtomic(path, body);
  } catch (err) {
    diag(`[theokit-sdk] WARN: models-dev cache write failed (${(err as Error).message})\n`);
  }
  try {
    return { source: "network", models: patchIndexFromApiJson(JSON.parse(body)) };
  } catch (err) {
    diag(
      `[theokit-sdk] WARN: models-dev patch failed (${(err as Error).message}) — serving existing data\n`,
    );
    return { source: "cache", models: 0 };
  }
}

/**
 * Explicitly refresh the model catalog from models.dev (the ONLY network trigger in the subsystem).
 * Fail-closed: any failure keeps serving the current index (cache or vendored). Kill-switch:
 * `THEOKIT_DISABLE_MODELS_FETCH`.
 *
 * The sequence carried a cognitive-complexity suppression whose reason said splitting it would
 * "separate a step from the fallback it owns". The four helpers above each KEEP their fallback: the
 * TTL gate owns "no cache", the fetch owns every network and validation failure, the persist owns
 * the write and the patch. What is left here is the order they run in, which is what this function
 * was always for.
 *
 * Still true, and NOT fixed by the split: three of the paths return `{ source: "cache" }`, so a
 * caller cannot tell a timeout from an unparseable body from a patch failure. Distinguishing them
 * means adding a field to the PUBLIC `RefreshModelCatalogResult`, which is a release decision rather
 * than a refactor. The `diag` line already names the cause for an operator.
 */
export async function refreshModelCatalog(
  opts: RefreshModelCatalogOptions = {},
): Promise<RefreshModelCatalogResult> {
  // M44 M4 fix — self-initialize provider registration so the `@theokit/sdk/models` subpath works
  // standalone (without the consumer having built an Agent first).
  registerBuiltins();
  if (fetchDisabledByEnv()) return { source: "skipped", models: 0 };

  const url = opts.url ?? process.env.THEOKIT_MODELS_URL ?? DEFAULT_URL;
  const path = cachePathFor(url);
  const now = opts.deps?.now ?? (() => Date.now());

  if (opts.force !== true) {
    const cached = servedFromFreshCache(url, path, now);
    if (cached !== undefined) return cached;
  }

  const body = await fetchCatalogBody(url, boundFetch(opts.deps?.fetch));
  // fail-closed: serve whatever we already have (stale cache if present, else vendored)
  if (body === undefined) return { source: "cache", models: loadCacheIntoIndex(url) };

  return persistAndPatch(path, body);
}

/** The enriched per-model view (public via `@theokit/sdk/models`): index lookup by (possibly prefixed) id. */
export function getModelInfo(modelId: string): ReturnType<typeof getCatalogModelInfo> {
  return getCatalogModelInfo(modelId);
}
