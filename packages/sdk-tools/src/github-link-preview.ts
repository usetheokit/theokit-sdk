/**
 * `github_link_preview` — turn a github.com issue, pull request or repository URL into its title,
 * state and summary.
 *
 * The model's URL is parsed, never fetched: owner, repository and number are validated against
 * GitHub's own name charset and the request always goes to a fixed `https://api.github.com`
 * endpoint built from those parts (ADR D1). Redirects are refused, so a response can never choose
 * the next host or carry the bearer token elsewhere (ADR D2).
 *
 * Return shape (always a JSON string):
 *   - `{ ok: true, kind, url, title, state, summary }`
 *   - `{ ok: false, error: 'unsupported_url' | 'redirect_blocked' | 'not_found' | 'rate_limited' |
 *        'upstream_error' | 'timeout' | 'fetch_failed' | 'invalid_response', url, ... }`
 */

import type { CustomTool } from "@theokit/sdk";

import { Tool } from "@theokit/sdk";
import { z } from "zod";

const API_BASE = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_SUMMARY_CHARS = 500;
const MAX_BODY_BYTES = 1_048_576;
const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const NUMBER_PATTERN = /^[1-9][0-9]{0,9}$/;

/** What a previewed GitHub URL points at, taken from its path. */
export type GithubLinkKind = "repository" | "issue" | "pull_request";

/** Options for {@link createGithubLinkPreviewTool}; every one is optional. */
export interface CreateGithubLinkPreviewToolOptions {
  /** Fetch implementation with the global `fetch` signature (injectable for tests). */
  fetchImpl?: typeof fetch;
  /** Optional GitHub token, sent as `Authorization: Bearer` to api.github.com only. */
  token?: string;
  /** Name exposed to the model. Default `github_link_preview`. */
  name?: string;
  /** Description exposed to the model. */
  description?: string;
  /** Timeout covering the request and the body read, in ms. Default 10000. */
  timeoutMs?: number;
  /** Longest summary returned, in code points. Default 500. */
  maxSummaryChars?: number;
  /** Clock for `retry_after_seconds` (injectable for tests). Default `Date.now`. */
  now?: () => number;
}

/** The JSON the `github_link_preview` tool returns: a preview, or a typed failure. */
export type GithubLinkPreviewResult =
  | {
      ok: true;
      kind: GithubLinkKind;
      url: string;
      title: string;
      state: string;
      summary: string;
    }
  | {
      ok: false;
      error:
        | "unsupported_url"
        | "redirect_blocked"
        | "not_found"
        | "rate_limited"
        | "upstream_error"
        | "timeout"
        | "fetch_failed"
        | "invalid_response";
      url: string;
      status?: number;
      retry_after_seconds?: number;
      timeout_ms?: number;
      error_name?: string;
    };

interface GithubTarget {
  kind: GithubLinkKind;
  owner: string;
  repo: string;
  number?: string;
}

interface Settings {
  fetchImpl: typeof fetch;
  headers: Record<string, string>;
  timeoutMs: number;
  maxSummaryChars: number;
  now: () => number;
}

type Failure = Extract<GithubLinkPreviewResult, { ok: false }>;
type FailureError = Failure["error"];

class PreviewFailure extends Error {
  constructor(
    readonly error: FailureError,
    readonly extra: Omit<Failure, "ok" | "error" | "url"> = {},
  ) {
    super(error);
  }
}

function requirePositiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(
      `createGithubLinkPreviewTool: ${name} must be a positive integer, got ${value}`,
    );
  }
  return value;
}

function hasControlCharacter(text: string): boolean {
  return Array.from(text).some((char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}

function requireValidToken(token: string): string {
  if (token.trim() === "" || hasControlCharacter(token)) {
    throw new RangeError(
      "createGithubLinkPreviewTool: token must be non-blank and free of control characters",
    );
  }
  return token;
}

function buildHeaders(token: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "theokit-sdk-tools",
    "x-github-api-version": "2022-11-28",
  };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return headers;
}

function isGithubOrigin(parsed: URL): boolean {
  return (
    parsed.protocol === "https:" &&
    GITHUB_HOSTS.has(parsed.hostname) &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.port === ""
  );
}

function targetFromSegments(segments: string[]): GithubTarget | undefined {
  const [owner = "", repo = "", section, number = ""] = segments;
  if (!OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(repo) || repo === "." || repo === "..") {
    return undefined;
  }
  if (segments.length === 2) return { kind: "repository", owner, repo };
  if (segments.length !== 4 || !NUMBER_PATTERN.test(number)) return undefined;
  if (section === "issues") return { kind: "issue", owner, repo, number };
  if (section === "pull") return { kind: "pull_request", owner, repo, number };
  return undefined;
}

function parseGithubUrl(url: string): GithubTarget | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (!isGithubOrigin(parsed)) return undefined;
  const segments = parsed.pathname.split("/").slice(1);
  if (segments.at(-1) === "") segments.pop();
  return targetFromSegments(segments);
}

function apiUrlFor(target: GithubTarget): string {
  const base = `${API_BASE}/repos/${target.owner}/${target.repo}`;
  if (target.kind === "issue") return `${base}/issues/${target.number}`;
  if (target.kind === "pull_request") return `${base}/pulls/${target.number}`;
  return base;
}

function canonicalUrlFor(target: GithubTarget): string {
  const base = `https://github.com/${target.owner}/${target.repo}`;
  if (target.kind === "issue") return `${base}/issues/${target.number}`;
  if (target.kind === "pull_request") return `${base}/pull/${target.number}`;
  return base;
}

// `retry-after` is read as delta-seconds only; an HTTP-date value falls through to the epoch reset.
function retryAfterSeconds(headers: Headers, nowMs: number): number | undefined {
  const retryAfter = Number(headers.get("retry-after") ?? Number.NaN);
  if (Number.isFinite(retryAfter)) return Math.max(0, Math.ceil(retryAfter));
  const reset = Number(headers.get("x-ratelimit-reset") ?? Number.NaN);
  if (Number.isFinite(reset)) return Math.max(0, Math.ceil(reset - nowMs / 1000));
  return undefined;
}

function isRateLimited(response: Response): boolean {
  if (response.status !== 403 && response.status !== 429) return false;
  return (
    response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")
  );
}

function checkStatus(response: Response, nowMs: number): void {
  const { status } = response;
  if (status >= 200 && status < 300) return;
  if (status >= 300 && status < 400) throw new PreviewFailure("redirect_blocked", { status });
  if (status === 404) throw new PreviewFailure("not_found", { status });
  if (isRateLimited(response)) {
    const retry = retryAfterSeconds(response.headers, nowMs);
    throw new PreviewFailure("rate_limited", {
      status,
      ...(retry === undefined ? {} : { retry_after_seconds: retry }),
    });
  }
  throw new PreviewFailure("upstream_error", { status });
}

async function readCappedJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    throw new PreviewFailure("invalid_response");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    throw new PreviewFailure("invalid_response");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PreviewFailure("invalid_response");
  }
}

function cutCodePoints(text: unknown, max: number): string {
  if (typeof text !== "string") return "";
  return Array.from(text).slice(0, max).join("");
}

function stateOf(target: GithubTarget, body: Record<string, unknown>): string {
  if (target.kind === "repository") return body.archived === true ? "archived" : "active";
  if (target.kind === "pull_request" && body.merged === true) return "merged";
  if (typeof body.state !== "string") throw new PreviewFailure("invalid_response");
  return body.state;
}

function mapPreview(
  target: GithubTarget,
  body: unknown,
  maxSummaryChars: number,
): GithubLinkPreviewResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new PreviewFailure("invalid_response");
  }
  const record = body as Record<string, unknown>;
  const isRepository = target.kind === "repository";
  const title = isRepository ? record.full_name : record.title;
  if (typeof title !== "string") throw new PreviewFailure("invalid_response");
  return {
    ok: true,
    kind: target.kind,
    url: canonicalUrlFor(target),
    title,
    state: stateOf(target, record),
    summary: cutCodePoints(isRepository ? record.description : record.body, maxSummaryChars),
  };
}

function failureFor(err: unknown, timeoutMs: number): PreviewFailure {
  if (err instanceof PreviewFailure) return err;
  const name = (err as { name?: unknown } | null)?.name;
  if (name === "AbortError" || name === "TimeoutError") {
    return new PreviewFailure("timeout", { timeout_ms: timeoutMs });
  }
  return new PreviewFailure("fetch_failed", {
    error_name: typeof name === "string" ? name : "unknown",
  });
}

async function fetchPreview(
  target: GithubTarget,
  settings: Settings,
): Promise<GithubLinkPreviewResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  try {
    const response = await settings.fetchImpl(apiUrlFor(target), {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: settings.headers,
    });
    checkStatus(response, settings.now());
    const body = await readCappedJson(response);
    return mapPreview(target, body, settings.maxSummaryChars);
  } finally {
    clearTimeout(timer);
  }
}

async function preview(url: string, settings: Settings): Promise<GithubLinkPreviewResult> {
  const target = parseGithubUrl(url);
  if (target === undefined) return { ok: false, error: "unsupported_url", url };
  try {
    return await fetchPreview(target, settings);
  } catch (err) {
    const failure = failureFor(err, settings.timeoutMs);
    return { ok: false, error: failure.error, url, ...failure.extra };
  }
}

/**
 * Build the `github_link_preview` tool. Every option is optional: `createGithubLinkPreviewTool()`
 * previews public objects anonymously with a 10-second timeout and a 500-character summary.
 *
 * Only three URL shapes are accepted: `https://github.com/<owner>/<repo>`,
 * `.../issues/<n>` and `.../pull/<n>` (also on `www.github.com`; a trailing slash, query or
 * fragment is ignored). Anything else is `unsupported_url` and makes no request.
 *
 * Throws `RangeError` at construction for a non-positive or fractional `timeoutMs` or
 * `maxSummaryChars`, and for a blank token or one with a control character. Every failure after
 * construction is a typed `{ ok: false, error }` result, never a throw. The token is never
 * echoed: error bodies are not returned, and `fetch_failed` carries only the error's name.
 */
export function createGithubLinkPreviewTool(opts?: CreateGithubLinkPreviewToolOptions): CustomTool {
  const settings: Settings = {
    fetchImpl: opts?.fetchImpl ?? fetch,
    headers: buildHeaders(opts?.token === undefined ? undefined : requireValidToken(opts.token)),
    timeoutMs: requirePositiveInteger("timeoutMs", opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    maxSummaryChars: requirePositiveInteger(
      "maxSummaryChars",
      opts?.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS,
    ),
    now: opts?.now ?? Date.now,
  };

  return Tool.create({
    name: opts?.name ?? "github_link_preview",
    description:
      opts?.description ??
      "Preview a GitHub issue, pull request or repository from its github.com URL. Returns " +
        "{ ok, kind, url, title, state, summary } where state is open/closed/merged for issues and " +
        "pull requests and active/archived for repositories, or { ok: false, error }. Only " +
        "https://github.com/<owner>/<repo>, .../issues/<n> and .../pull/<n> are accepted.",
    inputSchema: z.object({
      url: z.string().min(1).describe("A github.com repository, issue or pull request URL."),
    }),
    handler: async ({ url }) => JSON.stringify(await preview(url, settings)),
  });
}
