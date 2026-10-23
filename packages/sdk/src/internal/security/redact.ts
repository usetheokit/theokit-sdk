import { diag } from "../diagnostics.js";
import { readEnv } from "../env.js";

/**
 * Canonical secret redaction module (ADRs D68-D73).
 *
 * Single source of truth for credential pattern masking across the SDK.
 * Wired at output boundaries: `ErrorMetadata.raw` (mappers/shared.ts),
 * telemetry span attributes (telemetry/tracer.ts), transcript JSONL
 * appends (agent-session-store.ts), migration logger output
 * (memory/migrate-sqlite-to-lance.ts).
 *
 * - D68: central module, single source of truth (replaces 2 duplicates)
 * - D69: env snapshot at module init (prompt-injection defense)
 * - D70: ON by default, warn on opt-out
 * - D71: two-bucket masking — short fully masked, long preserves prefix+suffix
 * - D72: `codeFile` opt-out for legitimate prefix-shaped content
 * - D73: redact at OUTPUT boundaries, not at storage
 *
 * @internal
 */

// D69: env snapshot captured at module load. Subsequent mutations of
// process.env.THEOKIT_REDACT_SECRETS are ignored — defends against
// prompt injection that tries to disable redaction mid-run.
let REDACT_ENABLED: boolean = readEnvOnce();

function readEnvOnce(): boolean {
  // `readEnv` rather than `process.env`: this module reaches the browser through `errors.ts`, and
  // a bare `process` there is a ReferenceError at module scope — a blank page, not a warning.
  const raw = readEnv("THEOKIT_REDACT_SECRETS");
  if (raw === undefined) return true; // D70: default ON
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

// D70: warn once on opt-out so the user knows they're vulnerable.
let warnedOptOut = false;
if (!REDACT_ENABLED && !warnedOptOut) {
  diag(
    "[theokit-sdk] Secret redaction is DISABLED via THEOKIT_REDACT_SECRETS. " +
      "Credentials may leak into errors, telemetry, logs, transcripts.\n",
  );
  warnedOptOut = true;
}

/**
 * One built-in masker: a global regex whose every match `redactSecrets` replaces with `maskToken`
 * of it, or a function that does its own masking in one pass over the string.
 */
type BuiltinMasker = RegExp | ((s: string) => string);

/** True for a character of a JWT segment, `[A-Za-z0-9_-]`. */
function isSegmentChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    code === 45 || // -
    code === 95 // _
  );
}

/** Index of the first character at or after `from` that is not a JWT segment character. */
function runEnd(s: string, from: number): number {
  let i = from;
  while (i < s.length && isSegmentChar(s.charCodeAt(i))) i++;
  return i;
}

/**
 * End of the JWT whose first segment is the run ending at `r1`, or -1 when none completes there:
 * `.`, `eyJ` and 4 or more segment characters running to a `.`, then a third run of 4 or more.
 */
function jwtEndAfterFirstRun(s: string, r1: number): number {
  if (s[r1] !== "." || !s.startsWith("eyJ", r1 + 1)) return -1;
  const r2 = runEnd(s, r1 + 4);
  if (r2 - (r1 + 4) < 4 || s[r2] !== ".") return -1;
  const r3 = runEnd(s, r2 + 1);
  return r3 - (r2 + 1) < 4 ? -1 : r3;
}

/**
 * Masks every three-segment JWT the regex `eyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}`
 * masks, with the same output, in time linear in the length of `s`.
 *
 * The regex retried from every `eyJ` of a run it could not complete, giving the run back one
 * character at a time, which took minutes on a few hundred thousand characters of `eyJa`. Every
 * `eyJ` in one run ends its first segment at the same character, with fewer characters than the
 * first `eyJ` has, and what must follow that character is the same for all of them. So when the
 * first `eyJ` of a run fails, every later one in that run fails too: the scan tries only the
 * first, then resumes after the run. Each run is read at most three times, as the first, second
 * and third segment.
 */
function maskJwts(s: string): string {
  let out = "";
  let copied = 0;
  let start = s.indexOf("eyJ");
  while (start >= 0) {
    const r1 = runEnd(s, start + 3);
    const end = r1 - (start + 3) >= 4 ? jwtEndAfterFirstRun(s, r1) : -1;
    if (end < 0) {
      start = s.indexOf("eyJ", r1 + 1);
      continue;
    }
    out += s.slice(copied, start) + maskToken(s.slice(start, end));
    copied = end;
    start = s.indexOf("eyJ", end);
  }
  return copied === 0 ? s : out + s.slice(copied);
}

const PEM_LABEL = "(?:RSA |EC |DSA |OPENSSH |ENCRYPTED |)";
const PEM_BEGIN = new RegExp(`-----BEGIN[ ]+${PEM_LABEL}PRIVATE KEY-----`, "g");
const PEM_END = new RegExp(`-----END[ ]+${PEM_LABEL}PRIVATE KEY-----`, "g");

/**
 * Mask each PEM private key block: a BEGIN header, then the first END header that starts at least
 * one character after it, any label on either side. Masks the same spans the lazy regex
 * `BEGIN[\s\S]+?END` did, in linear time.
 *
 * The regex retried its span at every BEGIN header, and each retry walked to the end of the string
 * when no END header followed, so many unmatched headers cost the square of the length (seconds on
 * a few hundred KB). Here a failed END search ends the scan: if no END header starts after one
 * BEGIN, none starts after a later one, so the rest of the string is left as it is, exactly as the
 * regex left it. Each search starts where the previous one ended, so every character is read a
 * bounded number of times.
 */
function maskPemBlocks(s: string): string {
  let out = "";
  let cursor = 0;
  for (;;) {
    PEM_BEGIN.lastIndex = cursor;
    const begin = PEM_BEGIN.exec(s);
    if (begin === null) break;
    PEM_END.lastIndex = begin.index + begin[0].length + 1;
    const end = PEM_END.exec(s);
    if (end === null) break;
    const blockEnd = end.index + end[0].length;
    out += s.slice(cursor, begin.index) + maskToken(s.slice(begin.index, blockEnd));
    cursor = blockEnd;
  }
  return out + s.slice(cursor);
}

/**
 * Built-in credential maskers. Order matters — more specific prefixes
 * must come before generic ones (e.g., `sk-ant-` before `sk-`). The JWT
 * and PEM shapes are the `maskJwts` and `maskPemBlocks` scans rather than
 * regexes, because each regex was quadratic on input it could not complete
 * (a long run of `eyJ`, many BEGIN headers with no END header).
 *
 * @internal
 */
const BUILTIN_PATTERNS: readonly BuiltinMasker[] = [
  // T5.4: 30+ vendor prefixes (was 12 pre-T5.4). Order matters — more
  // specific prefixes precede generic ones (e.g., sk-ant-admin01 before
  // sk-ant-, sk-proj- before sk-). PEM block deliberately first so its
  // multi-line span runs before any per-line patterns can fire. A scan
  // rather than a regex: the regex was quadratic on many BEGIN headers with
  // no END header (B-544).
  maskPemBlocks,
  // JWT — exact 3-segment base64url. Dotted; the body floor of 4 chars per
  // segment matches the minimum legal payload while skipping `a.b.c` noise.
  // A scan rather than a regex: the regex was quadratic on a long run of
  // `eyJ` it could not complete (B-554).
  maskJwts,
  // Azure Storage SAS — match the sig= component (URL-encoded base64).
  /(?<=[?&]sig=)[A-Za-z0-9%+/]{20,}/g,
  // Anthropic
  /sk-ant-admin01-[A-Za-z0-9_-]{10,}/g, //   Anthropic admin keys (must precede sk-ant-)
  /sk-ant-[A-Za-z0-9_-]{10,}/g, //           Anthropic regular
  // OpenAI family + clones (sk- generic must come AFTER all sk-foo- variants)
  /sk-proj-[A-Za-z0-9_-]{10,}/g, //  OpenAI project key (must precede sk- generic)
  /sk-[A-Za-z0-9_-]{10,}/g, //       OpenAI / OpenRouter / DeepInfra / Together / DeepSeek
  // Provider prefixes (alphabetized for maintainability)
  /AIza[A-Za-z0-9_-]{35}/g, //       Google API key
  /AKIA[A-Z0-9]{16}/g, //            AWS access key
  /fw_[A-Za-z0-9]{20,}/g, //         Fireworks
  /glpat-[A-Za-z0-9_-]{20}/g, //     GitLab PAT
  /ghp_[A-Za-z0-9]{36}/g, //         GitHub PAT classic
  /github_pat_[A-Za-z0-9_]{82}/g, // GitHub PAT fine-grained
  /gsk_[A-Za-z0-9]{20,}/g, //        Groq
  /hf_[A-Za-z0-9]{20,}/g, //         HuggingFace
  /\bpa-[A-Za-z0-9_-]{20,}/g, //     Voyage AI (word-boundary to skip CSS / kebab IDs)
  /pcsk_[A-Za-z0-9_-]{20,}/g, //     Pinecone
  /pplx-[A-Za-z0-9_-]{20,}/g, //     Perplexity
  /r8_[A-Za-z0-9_-]{20,}/g, //       Replicate
  /rk_live_[A-Za-z0-9]{20,}/g, //    Stripe restricted
  /sk_live_[A-Za-z0-9]{20,}/g, //    Stripe secret
  /sntrys_[A-Za-z0-9]{40,}/g, //     Sentry user auth
  /xai-[A-Za-z0-9_-]{20,}/g, //      xAI (Grok)
  /xox[bpasr]-[A-Za-z0-9-]{10,}/g, //Slack tokens
  // Additional unique-prefix tokens with low false-positive risk
  /npm_[A-Za-z0-9]{36}/g, //         npm access token
  /SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g, // SendGrid
  /\bSK[A-Za-z0-9]{32}\b/g, //       Twilio API SID (word-boundary to skip CSS class noise)
  /\bkey-[a-f0-9]{32}\b/g, //        Mailgun (hex-only narrows false positives)
  /MT[A-Za-z0-9_-]{23}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27}/g, // Discord bot
  /\b(?:sdk|mob)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/g, // LaunchDarkly
];

// `Bearer <token>` matched as its own first-class pattern so PARAM_PATTERN
// doesn't have to handle the unusual `Authorization: Bearer xxx` shape
// (no `:` or `=` between "Bearer" and the value — bare whitespace).
const BEARER_PATTERN = /\b(Bearer\s+)([A-Za-z0-9_\-.+/=]{8,})/g;

// Parametric: matches `key=value` and `key: value` (with optional quote
// between the key and the separator, to handle JSON: `"api_key": "..."`)
// in URLs, query strings, JSON-like bodies, HTTP headers. Captures the
// prefix so we keep it visible while masking the value.
//
// `authorization` deliberately excluded — BEARER_PATTERN handles the
// common `Authorization: Bearer xxx` shape. Including it here causes
// double-masking ("Authorization: *** ***") after Bearer fires.
// T5.4: keyword set expanded from 6 → 16 to cover the OAuth / JWT / generic
// credential vocabulary surfaced by DR6 finding #4. `authorization`,
// `auth`, `bearer` stay excluded — BEARER_PATTERN handles the
// `Authorization: Bearer xxx` shape and including these here would
// re-catch the post-BUILTIN-masked form (D71 prefix-preservation
// contract) and double-mask to `***`.
//
// Value class includes `.` so JWT / `.env` / dotted base64url values
// match; the callback skips already-masked values (containing the
// `...` D71 separator) to preserve the BUILTIN prefix-mask result.
const PARAM_PATTERN =
  /(\b(?:access_token|api_key|api-key|client_secret|credential|credentials|id_token|jwt|password|private_key|refresh_token|secret|service_account|session_token|token|x-api-key)\b["']?\s*[:=]\s*["']?)([A-Za-z0-9_\-.+/]+)/gi;

const _extraPatterns: RegExp[] = [];

/**
 * Register an extra pattern for `redactSecrets` to mask, on top of the built-in vendor set.
 *
 * Additive and irreversible for the life of the process: patterns accumulate in module scope,
 * builtins are never replaced or reordered, and there is no way to remove one. Registering the
 * same regex twice registers it twice.
 *
 * Throws immediately when the regex has no `/g` flag. That is not pedantry — `String.replace`
 * with a non-global regex substitutes only the FIRST match, so a pattern registered without it
 * would mask the first credential in a payload and let every later one through, which reads as
 * working.
 *
 * Extras run after the builtins and before the parametric `key=value` sweep, and each whole match
 * is replaced by `maskToken` of that match. Anchor and bound the pattern with care: a regex that
 * matches more than the secret masks more than the secret, and one that backtracks badly runs on
 * every string crossing an output boundary.
 *
 * Registering a pattern does not enable redaction. When `THEOKIT_REDACT_SECRETS` was off at
 * module load, `redactSecrets` returns its input untouched and extras never run.
 *
 * Also exposed publicly, and under semver, as `Security.addPattern` in `src/security.ts`; the
 * direct export here additionally reaches the semver-exempt `@theokit/sdk/internal/security`
 * sub-path.
 */
export function addPattern(re: RegExp): void {
  if (!re.global) {
    // A BARE Error here, deliberately, and this is the one place in the package where that is the
    // right answer. `errors.ts` imports `redactSecrets` from this module for the anti-leak invariant
    // on `providerError`, so this module must stay below it — importing ConfigurationError closes a
    // cycle (measured: `madge --circular` reports `errors.ts > internal/security/redact.ts`).
    //
    // The typed error lives at the surface a consumer touches: `Security.addPattern` in
    // `src/security.ts` validates first and throws ConfigurationError with a code. This throw is the
    // backstop for the semver-exempt `@theokit/sdk/internal/security` sub-path.
    throw new Error("addPattern: regex must have /g flag for replace-all semantics");
  }
  _extraPatterns.push(re);
}

/**
 * Mask one string, keeping enough of it to be recognizable in a log.
 *
 * Under 18 characters the whole string becomes the literal `***`; the length is not preserved and
 * nothing of the input survives. From 18 characters up, the result is the first 6 characters, the
 * literal `...`, and the last 4 — so exactly 10 characters of the input are RETAINED IN CLEAR and
 * the middle is dropped. That is the trade the threshold encodes: short strings could be brute
 * forced from a partial, long ones cannot, and the surviving prefix is usually the vendor tag
 * (`sk-ant`, `ghp_de`) that tells an operator which credential misbehaved.
 *
 * Be clear about what this is and is not. It is a readability aid for logs, not an anonymizer and
 * not a security boundary. The retained prefix and suffix identify the credential's issuer and
 * often the credential itself to anyone who has seen it before, so a masked value still belongs in
 * a trusted log and not in a bug report or a support ticket.
 *
 * It masks whatever it is handed. There is no check that the argument is a secret, so calling it
 * on ordinary text mangles the text, and calling it on something the caller merely hopes is a
 * secret proves nothing about what leaked.
 *
 * `redactSecrets` applies it to the ENTIRE match of a pattern, not to a captured group. For a
 * match like `Bearer sk-ant-...` the first 6 characters retained are `Bearer`, not the key's
 * prefix.
 *
 * Semver-exempt: reachable via the `@theokit/sdk/internal/security` sub-path, which the package
 * declares in `exports` but does NOT cover with its semver contract.
 */
export function maskToken(token: string): string {
  if (token.length < 18) return "***";
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

// issue #117 — the EXACT shape of a `maskToken` output (`slice(0,6)+"..."+slice(-4)`
// = 6 chars, literal `...`, 4 chars). Used to detect a value PARAM_PATTERN would
// otherwise re-mask, WITHOUT skipping a raw secret that merely contains `...`.
const MASK_SHAPE = /^.{6}\.\.\..{4}$/s;

// Coerce arbitrary input to a string for redaction. Returns `null`
// sentinel when the value is null/undefined/non-stringifiable, so the
// caller can short-circuit with `""`. EC-7 fix: circular refs go through
// the try/catch and produce the sentinel marker, never throwing.
function coerceToString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return null;
  if (typeof value === "object") {
    try {
      const s = JSON.stringify(value);
      return s === undefined ? null : s;
    } catch {
      return "[unredactable: circular]";
    }
  }
  return String(value);
}

/**
 * Redact known credential patterns from `text`. Default behavior masks
 * builtins + extras + parametric `key=value` sinks.
 *
 * With `{ codeFile: true }` (D72), skips PARAM_PATTERN to avoid mangling
 * `.env.example`, schema JSON, or test fixtures that legitimately contain
 * prefix-like strings.
 *
 * Returns the redacted string. Coerces non-strings via JSON.stringify;
 * EC-7 fix (edge-case review): wraps in try/catch so circular references
 * never propagate — returns sentinel `"[unredactable: circular]"`.
 *
 * `null` and `undefined` return `""`. When redaction was switched off at module load via
 * `THEOKIT_REDACT_SECRETS`, the coerced input is returned with no masking at all — the value is
 * still stringified, but nothing is removed from it.
 *
 * Masking is best-effort against a list of known shapes. A credential in a format no pattern
 * covers passes through unchanged, so a redacted string is not a string proven free of secrets.
 */
export function redactSecrets(text: unknown, opts?: { codeFile?: boolean }): string {
  const coerced = coerceToString(text);
  if (coerced === null) return "";
  if (!REDACT_ENABLED) return coerced;

  let s = coerced;
  for (const masker of BUILTIN_PATTERNS) {
    s = typeof masker === "function" ? masker(s) : s.replace(masker, (m) => maskToken(m));
  }
  for (const re of _extraPatterns) {
    s = s.replace(re, (m) => maskToken(m));
  }
  if (!opts?.codeFile) {
    // Bearer first (preserves "Bearer " prefix, masks the token after).
    // Must run before PARAM_PATTERN so the bare-whitespace shape doesn't
    // get mis-handled as a value.
    s = s.replace(BEARER_PATTERN, (_, prefix: string) => `${prefix}***`);
    // T5.4: skip if value already contains the D71 bucket-mask separator
    // (`...`) — BUILTIN ran first and produced a prefix-preserved mask;
    // re-masking would lose the prefix and degrade debuggability.
    s = s.replace(PARAM_PATTERN, (whole, prefix: string, value: string) => {
      // issue #117 — skip ONLY when the value is already a mask that a BUILTIN
      // pattern produced (maskToken's exact `6chars...4chars` shape), so we don't
      // re-mask and lose the prefix. The old `value.includes("...")` was too broad:
      // a REAL secret that happens to contain `...` (e.g. `L_-cxw-.2UI_..._`) was
      // skipped and LEAKED. The mask shape is exact (maskToken: slice(0,6)+"..."+
      // slice(-4)), so a raw secret with `...` elsewhere is now masked.
      if (MASK_SHAPE.test(value)) return whole;
      return `${prefix}***`;
    });
  }
  return s;
}

/**
 * Test-only helper exported for `_test-reset.ts`. NOT included in the
 * `index.ts` barrel — vitest setup imports the dedicated module via
 * explicit path to discourage production callers.
 *
 * @internal
 */
export function _resetForTests(opts: { enabled?: boolean; clearExtras?: boolean }): void {
  if (opts.enabled !== undefined) REDACT_ENABLED = opts.enabled;
  if (opts.clearExtras === true) _extraPatterns.length = 0;
}

/**
 * T5.4 — Test-only count of BUILTIN_PATTERNS. Exposed so the count-floor
 * assertion can run without re-deriving the array shape in test land.
 * NOT included in the public barrel.
 *
 * @internal
 */
export function __TESTING__BUILTIN_PATTERN_COUNT(): number {
  return BUILTIN_PATTERNS.length;
}
