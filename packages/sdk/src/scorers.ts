/**
 * Built-in scorers for `Eval.create` (Adoption Roadmap #2, ADR D203).
 *
 * Each scorer is a CURRIED FACTORY: call with config, get back a
 * `NamedScorer` ready to drop into `EvalOptions.scorers[]`.
 *
 *   import { Scorers } from "@theokit/sdk/eval";
 *   const scorers = [
 *     Scorers.containsExpected({ caseSensitive: false }),
 *     Scorers.regex(/jazz|blues/i),
 *   ];
 *
 * @public
 */

import type { ZodType, z } from "zod";

import { openRouterMemoryEmbeddingProviderAdapter } from "./internal/memory/adapters/openrouter-embedding.js";
import type { EmbeddingRuntime } from "./internal/memory/embedding-adapter.js";
import { LEVENSHTEIN_MAX_LEN, levenshteinDistance } from "./internal/scorers/levenshtein.js";
import { type LlmJudgeOptions, llmJudgeScore } from "./internal/scorers/llm-judge.js";
import { scoreToolCallAccuracy, scoreTrajectory } from "./internal/scorers/tool-calls.js";
import { LocalSandbox } from "./sandbox/local-sandbox.js";
import { shellEscapePosix } from "./sandbox/shell-escape.js";
import type { NamedScorer, Score, VerifyGateOptions } from "./types/eval.js";

/** EC-2 fix: cap JSON parse input to bound memory. 1 MB is generous for structured output. */
const JSON_SHAPE_MAX_BYTES = 1_000_000;

/** SE41 — options for the deterministic fuzzy `Scorers.levenshtein`. */
interface LevenshteinOptions {
  /** Case-sensitive compare. Default: false (fuzzy matching is usually case-insensitive). */
  caseSensitive?: boolean;
  /**
   * When set, binarize: `score = normalizedSimilarity >= threshold ? 1 : 0`.
   * When omitted, return the continuous similarity in `[0, 1]`.
   */
  threshold?: number;
}

/** SE41 — options for the deterministic `Scorers.numericDiff`. */
interface NumericDiffOptions {
  /**
   * When set, binarize: `score = |output - expected| <= tolerance ? 1 : 0`.
   * When omitted, return the continuous relative closeness in `[0, 1]`.
   */
  tolerance?: number;
}

/** SE41 — options for `Scorers.embeddingSimilarity`. */
interface EmbeddingSimilarityOptions {
  /** Embedding API key. Defaults to `OPENROUTER_API_KEY` from the environment. */
  apiKey?: string;
  /** Embedding model id (OpenRouter catalog). Default: `openai/text-embedding-3-small`. */
  model?: string;
  /** Override the embeddings HTTP base URL. */
  baseUrl?: string;
  /** When set, binarize: `score = cosine >= threshold ? 1 : 0`. Else continuous. */
  threshold?: number;
  /**
   * Inject an embedding function (DIP): `(texts) => vectors`. When provided, the
   * OpenRouter runtime is NOT constructed — used by tests and custom providers.
   */
  embed?: (texts: ReadonlyArray<string>) => Promise<number[][]>;
}

/** Cosine similarity of two vectors; 0 when either has zero magnitude. */
function cosineSimilarity(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Validate + case-normalize a string scorer's `(output, expected)` pair. Returns
 * the normalized pair, or a failure `Score` when `expected` is not a usable
 * string (shared by every string-based scorer — single source for EC-1 parity).
 */
function normalizeStringInputs(
  output: string,
  expected: unknown,
  caseSensitive: boolean,
): { o: string; e: string } | Score {
  if (typeof expected !== "string") return { score: 0, reason: "expected_not_string" };
  if (expected.length === 0) return { score: 0, reason: "expected_empty" };
  return {
    o: caseSensitive ? output : output.toLowerCase(),
    e: caseSensitive ? expected : expected.toLowerCase(),
  };
}

/** Module-level scoring body for `Scorers.levenshtein` (keeps the factory flat). */
function scoreLevenshtein(
  output: string,
  expected: unknown,
  caseSensitive: boolean,
  threshold: number | undefined,
): Score {
  const norm = normalizeStringInputs(output, expected, caseSensitive);
  if (!("o" in norm)) return norm;
  const { o, e } = norm;
  if (o.length > LEVENSHTEIN_MAX_LEN || e.length > LEVENSHTEIN_MAX_LEN) {
    return { score: 0, reason: "input_too_large" };
  }
  const sim = 1 - levenshteinDistance(o, e) / Math.max(o.length, e.length, 1);
  if (threshold === undefined) return { score: sim };
  return sim >= threshold ? { score: 1 } : { score: 0, reason: `sim=${sim.toFixed(3)}` };
}

/** Coerce a value to a finite number, or `undefined` when it is not numeric. */
function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (value === undefined || value === null) return undefined;
  const n = Number(String(value).trim());
  return Number.isFinite(n) ? n : undefined;
}

/** Module-level scoring body for `Scorers.numericDiff`. */
function scoreNumericDiff(output: string, expected: unknown, tolerance: number | undefined): Score {
  const o = toFiniteNumber(output);
  if (o === undefined) return { score: 0, reason: "output_not_numeric" };
  const e = toFiniteNumber(expected);
  if (e === undefined) return { score: 0, reason: "expected_not_numeric" };
  if (tolerance !== undefined) {
    return Math.abs(o - e) <= tolerance
      ? { score: 1 }
      : { score: 0, reason: `abs_diff=${Math.abs(o - e)}` };
  }
  const denom = Math.max(Math.abs(o), Math.abs(e));
  if (denom === 0) return { score: 1 };
  return { score: Math.max(0, 1 - Math.abs(o - e) / denom) };
}

/** Assemble the OpenRouter adapter options from the scorer opts (omitting undefineds). */
function embedderCreateOptions(opts: EmbeddingSimilarityOptions): {
  model?: string;
  apiKey?: string;
  baseUrl?: string;
} {
  return {
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
    ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
  };
}

/** Build the default (OpenRouter-backed) embedder for `embeddingSimilarity`. */
function makeDefaultEmbedder(
  opts: EmbeddingSimilarityOptions,
): (texts: ReadonlyArray<string>) => Promise<number[][]> {
  let runtime: Promise<EmbeddingRuntime> | undefined;
  return (texts) => {
    if (runtime === undefined) {
      runtime = openRouterMemoryEmbeddingProviderAdapter.create(embedderCreateOptions(opts));
    }
    return runtime.then((rt) => rt.embed(texts));
  };
}

interface ExactMatchOptions {
  /** Case-sensitive compare. Default: true. */
  caseSensitive?: boolean;
}

interface ContainsExpectedOptions {
  /** Case-sensitive compare. Default: false. */
  caseSensitive?: boolean;
}

interface JsonShapeOptions {
  /** Include Zod's error message in the failure reason. Default: false. */
  strict?: boolean;
}

function makeStringScorer(
  name: string,
  caseSensitive: boolean,
  compare: (output: string, expected: string) => Score,
): NamedScorer {
  return {
    name,
    score: (output, expected): Score => {
      const norm = normalizeStringInputs(output, expected, caseSensitive);
      return "o" in norm ? compare(norm.o, norm.e) : norm;
    },
  };
}

/**
 * The built-in scorer factories for {@link Eval}. Each call returns a fresh
 * `NamedScorer` (`{ name, score }`) to drop into `EvalOptions.scorers`; the
 * result is stateless and safe to reuse across runs.
 *
 *   import { Eval, Scorers } from "@theokit/sdk/eval";
 *   scorers: [Scorers.exactMatch(), Scorers.jsonShape(MySchema)]
 *
 * How they fail: a scorer does not throw for a bad row. A mismatch, an unusable
 * `expected`, or an output that cannot be parsed all come back as
 * `{ score: 0, reason: "<why>" }` — `expected_not_string`, `expected_empty`,
 * `mismatch`, `not_found`, `regex_no_match`, `input_too_large`,
 * `output_not_numeric`, `expected_not_numeric`, `invalid_json`, `schema_invalid`,
 * `output_too_large`, `embed_failed`, `verify_gate_empty_command`,
 * `expected_tool_calls_missing`, `expected_trajectory_missing`, `unexpected_tool_call:<name>`. When a run
 * scores 0 across the board, `reason` usually says the dataset is wrong rather
 * than the model.
 *
 * Three of these are NOT pure and NOT free: `llmJudge` and `embeddingSimilarity`
 * each make one network call PER ROW and need their own credentials, and
 * `verifyGate` runs a shell command through a `SandboxBackend` — defaulting to
 * `LocalSandbox`, which is not an isolation boundary. The rest — `exactMatch`,
 * `containsExpected`, `regex`, `levenshtein`, `numericDiff`, `jsonShape`, `toolCallAccuracy`, `trajectory` — are
 * deterministic, offline, and safe in CI.
 *
 * Trap: the default case-sensitivity is NOT uniform. `exactMatch` defaults to
 * case-SENSITIVE; `containsExpected` and `levenshtein` default to
 * case-INSENSITIVE. Pass `caseSensitive` explicitly whenever it matters.
 *
 * @public
 */
export const Scorers = {
  /**
   * `output.trim() === expected.trim()`. Refuses empty `expected` (EC-1
   * — two empties would otherwise pass silently).
   */
  exactMatch(opts: ExactMatchOptions = {}): NamedScorer {
    return makeStringScorer("exact-match", opts.caseSensitive ?? true, (o, e) =>
      o.trim() === e.trim() ? { score: 1 } : { score: 0, reason: "mismatch" },
    );
  },

  /**
   * `output.includes(expected)`. Refuses empty `expected` (EC-1 —
   * `"".includes("")` is always `true`, would inflate pass ratio).
   */
  containsExpected(opts: ContainsExpectedOptions = {}): NamedScorer {
    return makeStringScorer("contains-expected", opts.caseSensitive ?? false, (o, e) =>
      o.includes(e) ? { score: 1 } : { score: 0, reason: "not_found" },
    );
  },

  /**
   * `pattern.test(output)`.
   *
   * **ReDoS caveat (EC-10):** the regex is applied to LLM output, which
   * may be adversarial. Patterns with catastrophic backtracking (e.g.
   * `/(a+)+$/`) can hang the eval. Test your pattern against worst-case
   * inputs before using in production.
   */
  regex(pattern: RegExp): NamedScorer {
    return {
      name: `regex(${pattern.source})`,
      score: (output): Score => {
        const ok = pattern.test(output);
        return ok ? { score: 1 } : { score: 0, reason: "regex_no_match" };
      },
    };
  },

  /**
   * SE41 — normalized Levenshtein similarity: `1 - editDistance / max(len)`.
   * Deterministic (no LLM), so it always runs in CI. `threshold` binarizes.
   *
   * Refuses empty/non-string `expected` (EC-1 parity) and caps input at
   * {@link LEVENSHTEIN_MAX_LEN} chars to bound the O(n*m) cost on adversarial output.
   */
  levenshtein(opts: LevenshteinOptions = {}): NamedScorer {
    const caseSensitive = opts.caseSensitive ?? false;
    const { threshold } = opts;
    return {
      name: threshold !== undefined ? `levenshtein(>=${threshold})` : "levenshtein",
      score: (output, expected): Score =>
        scoreLevenshtein(output, expected, caseSensitive, threshold),
    };
  },

  /**
   * SE41 — numeric closeness. Parses `output` and `expected` as numbers and
   * scores continuous relative closeness `1 - |o-e| / max(|o|,|e|)` (both 0 ⇒ 1),
   * or a binary pass when `tolerance` is set. Deterministic (no LLM).
   */
  numericDiff(opts: NumericDiffOptions = {}): NamedScorer {
    const { tolerance } = opts;
    return {
      name: "numeric-diff",
      score: (output, expected): Score => scoreNumericDiff(output, expected, tolerance),
    };
  },

  /**
   * SE41 — semantic similarity via embeddings: cosine of `embed(output)` vs
   * `embed(expected)`, clamped to `[0, 1]` (negatives → 0). `threshold` binarizes.
   *
   * By default routes through OpenRouter's embeddings endpoint
   * (`OPENROUTER_API_KEY`); inject `embed` to use another provider or to test
   * deterministically. Each scored row costs one embeddings call.
   */
  embeddingSimilarity(opts: EmbeddingSimilarityOptions): NamedScorer {
    const { threshold } = opts;
    const embed = opts.embed ?? makeDefaultEmbedder(opts);
    return {
      name:
        threshold !== undefined ? `embedding-similarity(>=${threshold})` : "embedding-similarity",
      score: async (output, expected): Promise<Score> => {
        if (typeof expected !== "string") return { score: 0, reason: "expected_not_string" };
        const [vo, ve] = await embed([output, expected]);
        if (vo === undefined || ve === undefined) return { score: 0, reason: "embed_failed" };
        const score = Math.max(0, cosineSimilarity(vo, ve));
        if (threshold === undefined) return { score };
        return score >= threshold ? { score: 1 } : { score: 0, reason: `cos=${score.toFixed(3)}` };
      },
    };
  },

  /**
   * LLM-as-judge scorer (ADR D205).
   *
   * **Cost note (EC-12):** every row with this scorer adds ~1 LLM call
   * for the judge. For 1000 rows × gpt-4o-mini, expect ~2x the baseline
   * token spend. The eval `aggregate.tokensInTotal` only reflects the
   * EVAL agent's tokens, not the judge's — forecast accordingly.
   *
   * **Bias note (D205):** `apiKey` is intentionally separate so callers
   * cannot accidentally judge their own output. Pass a different key
   * (can target the same provider, but explicit by design).
   *
   * **EC-8 (parser robustness):** the regex accepts JSON inside markdown
   * code fences and prose-wrapped JSON — common LLM output shapes.
   */
  llmJudge(opts: LlmJudgeOptions): NamedScorer {
    return {
      name: "llm-judge",
      score: (output, expected) => {
        const callOpts: LlmJudgeOptions & { output: string; expected?: unknown } =
          expected !== undefined ? { ...opts, output, expected } : { ...opts, output };
        return llmJudgeScore(callOpts);
      },
    };
  },

  /**
   * Verify-gate scorer (M6-2): runs the project's tests in the provisioned
   * repo via `SandboxBackend.execute` and scores `1` iff the command exits `0`,
   * else `0` with the exit code + truncated stderr in `reason`. Grades the
   * artifact captured by `captureArtifact` (D2 — rides `execute`, never a
   * direct `child_process`).
   *
   * SECURITY: `command` is REQUIRED and the caller's builder owns shell-safety
   * of the (potentially untrusted, dataset-derived) test identifiers. There is
   * NO default that runs bare test names — that would interpolate untrusted
   * `failToPass`/`passToPass` straight into a shell. `repoDir` is shell-escaped
   * by the SDK; the test list is the builder's responsibility to render safely.
   *
   * PORTABILITY: the command is wrapped as `cd <repoDir> && <cmd>`, which
   * assumes a shell-backed `SandboxBackend` (LocalSandbox/Docker). A backend
   * that rejects shell metacharacters in `execute` is unsupported for this scorer.
   */
  verifyGate(opts: VerifyGateOptions): NamedScorer {
    const { sandbox = new LocalSandbox(), repoDir, failToPass, passToPass, command } = opts;
    return {
      name: "verify-gate",
      score: async (): Promise<Score> => {
        const cmd = command([...failToPass, ...passToPass]).trim();
        if (cmd.length === 0) {
          return { score: 0, reason: "verify_gate_empty_command" };
        }
        const r = await sandbox.execute(`cd ${shellEscapePosix(repoDir)} && ${cmd}`);
        if (r.exitCode === 0) return { score: 1 };
        return { score: 0, reason: `exit=${r.exitCode} ${r.stderr.slice(0, 200)}`.trim() };
      },
    };
  },

  /**
   * Parse `output` as JSON and validate against a Zod schema.
   *
   * - EC-2 fix: output is bounded by `JSON_SHAPE_MAX_BYTES` (1e6) BEFORE
   *   `JSON.parse` to avoid OOM on runaway LLM responses. The bound is applied to
   *   `output.length` — UTF-16 code units, not bytes, despite the constant's name.
   * - `strict: true` includes Zod's first error message in `reason`.
   */
  jsonShape<T extends ZodType>(schema: T, opts: JsonShapeOptions = {}): NamedScorer {
    return {
      name: "json-shape",
      score: (output): Score => {
        if (output.length > JSON_SHAPE_MAX_BYTES) {
          return { score: 0, reason: "output_too_large" };
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(output);
        } catch {
          return { score: 0, reason: "invalid_json" };
        }
        const result = schema.safeParse(parsed);
        if (result.success) return { score: 1 };
        if (opts.strict === true) {
          const issue = (result.error as z.ZodError).issues?.[0];
          return { score: 0, reason: `schema_invalid: ${issue?.message ?? "?"}` };
        }
        return { score: 0, reason: "schema_invalid" };
      },
    };
  },
  /**
   * Fraction of the expected tool calls that happened. `expected` is
   * `{ toolCalls: [{ name, input? }] }` (or `metadata.expectedToolCalls`). `matchInput`
   * defaults to `"subset"` (expected input keys must match, extra keys are fine); `allowExtra`
   * defaults to `true` — with `false`, an unexpected call scores 0 with
   * `unexpected_tool_call:<name>`. A missing or malformed expected value scores 0 with
   * `expected_tool_calls_missing`. Deterministic, offline.
   */
  toolCallAccuracy(
    opts: { matchInput?: "exact" | "subset" | "ignore"; allowExtra?: boolean } = {},
  ): NamedScorer {
    const resolved = {
      matchInput: opts.matchInput ?? "subset",
      allowExtra: opts.allowExtra ?? true,
    };
    return {
      name: "tool-call-accuracy",
      score: (_output, expected, context): Score =>
        scoreToolCallAccuracy(resolved, expected, context),
    };
  },

  /**
   * 1 or 0: did the run's tool names follow `expected.trajectory` (`string[]`)? `order`
   * defaults to `"subsequence"` (expected names in order, extras allowed); `"strict"` is an
   * exact sequence; `"any"` ignores order. The reason names the first divergence position.
   * A missing or malformed expected value scores 0 with `expected_trajectory_missing`.
   */
  trajectory(opts: { order?: "strict" | "subsequence" | "any" } = {}): NamedScorer {
    const order = opts.order ?? "subsequence";
    return {
      name: "trajectory",
      score: (_output, expected, context): Score => scoreTrajectory(order, expected, context),
    };
  },
};
