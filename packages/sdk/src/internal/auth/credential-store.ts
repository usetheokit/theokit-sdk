import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { AuthenticationError } from "../../errors.js";

/**
 * M42 — the SDK credential store. Promoted DOWN from agent-builder's hardened `agents/lib/credentials.ts`
 * (M37), generalized from a closed `openrouter|anthropic|openai` union to an open `provider: string` and
 * driven by a caller-supplied {@link CredentialStoreConfig} (no hardcoded `.agent-builder`/`auth.json` /
 * `AGENT_BUILDER_HOME`). The security-critical file mechanics are ported VERBATIM (ADR D3 of the M42 plan):
 * atomic O_EXCL + rename + fsync write, 0700/0600 mode gates, `env` is always a PARAMETER (never an ambient
 * `process.env` read).
 *
 * The env-precedence + key-prefix-inference + declared-provider rungs of the agent-builder resolver are
 * APP POLICY and deliberately stay UP in the consumer; this module owns only the on-disk store + the
 * `api|oauth` discriminated union. See {@link resolveCredential} (SDK) for the store-read + refresh path.
 *
 * Re-exported from `@theokit/sdk/auth`, and therefore PUBLIC, under semver.
 *
 * NOTE — no internal-visibility tag in this block. `tsconfig.base.json` sets `stripInternal: true`,
 * and TypeScript scans EVERY leading comment range of the declaration that follows, including the
 * import right below this one. The tag that used to sit here deleted that import from the emitted
 * `.d.ts`, leaving the types it binds unresolvable for any consumer running type-aware lint
 * (usetheodev/theokit-sdk#283 records the same trap on a declaration).
 */
import type { CredentialStoreConfig, StoredCredential, StoredOAuthCredential } from "./types.js";

/** The store directory, honoring an optional `homeEnvVar` override. */
export function credentialHome(
  config: CredentialStoreConfig,
  env: Record<string, string | undefined> = {},
): string {
  const override = config.homeEnvVar !== undefined ? env[config.homeEnvVar]?.trim() : undefined;
  return override !== undefined && override.length > 0
    ? override
    : join(config.home, config.dirName);
}

/** The credential file path inside the (possibly overridden) store directory. */
export function authFilePath(
  config: CredentialStoreConfig,
  env: Record<string, string | undefined> = {},
): string {
  return join(credentialHome(config, env), config.fileName);
}

/**
 * A credential problem the caller can act on. Never carries the key value.
 *
 * M78 — this used to extend bare `Error`, which quietly disabled classification for the entire auth
 * path: `isTransientError` is `err instanceof TheokitAgentError && err.isRetryable === true`
 * (`errors.ts:443`), so a credential failure could never be judged transient OR permanent. The
 * predicate was not "forgotten" downstream — it was unusable there by construction.
 *
 * Extending `AuthenticationError` is ADDITIVE: the class still exists, still reports
 * `name: "CredentialError"`, and every existing `instanceof CredentialError` stays true. It only
 * gains ancestors. `AuthenticationError` pins `isRetryable: false`, so gaining the ability to be
 * classified does NOT turn a revoked credential into a retry loop.
 *
 * The single reference does the same thing with one root type: Codex routes every domain failure
 * through `CodexErr` with `is_retryable()` as a method (`protocol/src/error.rs:176`), rather than
 * parallel classes extending the language's `Error`.
 */
export class CredentialError extends AuthenticationError {
  // Field, not an assignment in the constructor: `AuthenticationError.name` is `override readonly`
  // (`errors.ts:174`), so `this.name = …` does not compile. Caught by `tsc`, not by vitest — the
  // suite was green with the broken assignment because the transpiler strips the type.
  override readonly name: string = "CredentialError";
}

/**
 * The on-disk store — a discriminated union on `type`. A legacy file with NO
 * `type` (or `type: 'api'`) is the API-key variant — read unchanged, no migration. The `oauth` variant
 * carries the token pair + expiry.
 */
const apiFileSchema = z
  .object({
    type: z.literal("api").optional(),
    provider: z.string().min(1).optional(),
    api_key: z.string(),
  })
  .strict();

const oauthFileSchema = z
  .object({
    type: z.literal("oauth"),
    provider: z.string().min(1),
    access: z.string().min(1),
    refresh: z.string().min(1),
    expires: z.number(),
    account_id: z.string().optional(),
    id_token: z.string().min(1).optional(),
  })
  .strict();

// oauth first (it requires `type: 'oauth'`); a legacy `{provider?, api_key}` falls through to api.
const fileSchema = z.union([oauthFileSchema, apiFileSchema]);

/**
 * The 0700-dir / 0600-file mode gates (ported verbatim). The DIRECTORY matters as much as the file:
 * `mkdirSync(mode)` applies only at creation, so a pre-existing store dir keeps whatever mode it had, and a
 * writable dir lets an attacker replace the credential file with a symlink to their own 0600 file — the
 * agent then runs on THEIR account.
 */
export function assertSecureModes(dirPath: string, path: string): void {
  // Windows has no POSIX mode bits. `statSync().mode` there is SYNTHETIC — 0666 for any writable
  // entry, whatever the ACLs actually say — so `mode & 0o022` was non-zero for every valid store and
  // this gate refused all of them, which made the credential path unreadable on that platform
  // rather than protected. A check that cannot observe the real permission system must not report a
  // verdict about it; ACL enforcement is a separate mechanism and not one this function can fake.
  if (process.platform === "win32") return;

  const dirMode = statSync(dirPath).mode & 0o777;
  if ((dirMode & 0o022) !== 0) {
    throw new CredentialError(
      `${dirPath} is writable by other users (mode ${dirMode.toString(8)}), so the credential file ` +
        `inside it can be replaced. Fix it with:  chmod 700 ${dirPath}`,
    );
  }
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new CredentialError(
      `${path} is readable by other users (mode ${mode.toString(8)}). ` +
        `A credential file must not be. Fix it with:  chmod 600 ${path}`,
    );
  }
}

/**
 * A `z.union` reports a generic "Invalid input" at the root, hiding WHAT is wrong. Pick the sub-schema the
 * file was CLEARLY aiming at (by its `type` discriminant) and surface that schema's specific issue.
 */
function describeUnionError(parsed: unknown, err: unknown, path: string): CredentialError {
  const looksOAuth =
    typeof parsed === "object" &&
    parsed !== null &&
    (parsed as { type?: unknown }).type === "oauth";
  const specific = looksOAuth ? oauthFileSchema.safeParse(parsed) : apiFileSchema.safeParse(parsed);
  let issue: z.ZodIssue | undefined;
  if (!specific.success) {
    issue = specific.error.issues[0];
  } else if (err instanceof z.ZodError) {
    issue = err.issues[0];
  }
  return new CredentialError(
    `${path}: ${issue?.message ?? String(err)} [${issue?.path.join(".") || "root"}]`,
  );
}

/** Parse the raw file into the store union, surfacing the SPECIFIC sub-schema issue (not a generic union error). */
function parseStoredFile(raw: string, path: string): StoredCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The parser's message embeds a snippet of the INPUT — up to the raw key when a user pastes the bare
    // key instead of JSON. The position is not actionable anyway, so the expected shape is more useful.
    throw new CredentialError(
      `${path} is not valid JSON. Expected:  {"provider": "<name>", "api_key": "..."}`,
    );
  }
  try {
    return fileSchema.parse(parsed);
  } catch (err) {
    throw describeUnionError(parsed, err, path);
  }
}

/**
 * Read the credential file. Absent ⇒ `undefined` (the normal case). Present-but-wrong is a typed error
 * naming the file: a malformed credential store must not surface as a raw parse crash. Enforces the
 * 0700 dir / 0600 file mode gates (ported verbatim — a writable dir lets an attacker swap the file for a
 * symlink to their own account).
 */
export function readAuthFile(
  config: CredentialStoreConfig,
  env: Record<string, string | undefined> = {},
): StoredCredential | undefined {
  const path = authFilePath(config, env);

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new CredentialError(`cannot read ${path}: ${(err as Error).message}`);
  }

  assertSecureModes(credentialHome(config, env), path);
  return parseStoredFile(raw, path);
}

/**
 * Read the stored OAuth credential (with its refresh token), or `undefined` when the store is absent or
 * holds an api credential. The oauth engine needs the refresh token, which the resolved bearer does not
 * carry. Enforces the same 0600/0700 gates as every other read.
 */
export function readStoredOAuth(
  config: CredentialStoreConfig,
  env: Record<string, string | undefined> = {},
): StoredOAuthCredential | undefined {
  const stored = readAuthFile(config, env);
  return stored !== undefined && stored.type === "oauth" ? stored : undefined;
}

/** Narrows a writable credential to the oauth variant. */
function isOAuthWrite(
  c: { provider: string; apiKey: string } | StoredOAuthCredential,
): c is StoredOAuthCredential {
  return "type" in c && c.type === "oauth";
}

/** Build the on-disk JSON payload for the credential variant, validating non-empty tokens. */
function buildStorePayload(
  cred: { provider: string; apiKey: string } | StoredOAuthCredential,
): Record<string, unknown> {
  if (isOAuthWrite(cred)) {
    if (cred.access.length === 0 || cred.refresh.length === 0) {
      throw new CredentialError(
        "refusing to write an oauth credential with an empty access/refresh token",
      );
    }
    return {
      type: "oauth",
      provider: cred.provider,
      access: cred.access,
      refresh: cred.refresh,
      expires: cred.expires,
      ...(cred.account_id !== undefined ? { account_id: cred.account_id } : {}),
      ...(cred.id_token !== undefined ? { id_token: cred.id_token } : {}),
    };
  }
  if (typeof cred.apiKey !== "string" || cred.apiKey.length === 0) {
    throw new CredentialError("refusing to write an empty API key");
  }
  return { provider: cred.provider, api_key: cred.apiKey };
}

/**
 * Persist a credential atomically at mode `0600`. Ported VERBATIM (ADR D3): write to a random-named temp
 * file in the same directory with `wx` (O_EXCL), fsync, close, chmod, then `rename` (atomic on POSIX) —
 * so a crash mid-write leaves whatever was there untouched, and a pre-planted symlink cannot capture the
 * key. The api variant persists the unchanged `{provider, api_key}` (back-compat, no `type` key); the
 * oauth variant persists `{type:'oauth', provider, access, refresh, expires, account_id?, id_token?}`.
 */
export function writeCredential(
  cred: { provider: string; apiKey: string } | StoredOAuthCredential,
  config: CredentialStoreConfig,
  env: Record<string, string | undefined> = {},
): string {
  const payload = buildStorePayload(cred);

  const dir = credentialHome(config, env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700); // unconditional: mkdirSync's mode applies only at creation

  const path = authFilePath(config, env);
  // RANDOM name + `wx` (O_EXCL): a predictable temp name with a plain write follows a pre-planted SYMLINK,
  // landing the key in an attacker's file while reporting success. O_EXCL refuses any pre-existing file or
  // link; the random suffix also removes the pid collision two containers sharing a bind-mounted home make.
  const tmp = `${path}.tmp-${randomBytes(8).toString("hex")}`;
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600); // explicit: the mode argument is subject to umask
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // the temp file may not exist; its absence is not a failure of the write
    }
    throw new CredentialError(`cannot write ${path}: ${(err as Error).message}`);
  }
  return path;
}
