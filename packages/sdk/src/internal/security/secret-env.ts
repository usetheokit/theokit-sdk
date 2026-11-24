/** Which environment variable names hold secrets (shared by env policy and apps). */

/**
 * Secret-like variable-name patterns (case-insensitive). A parent var whose
 * name matches any of these is dropped under `inherit-scrubbed`. Conservative
 * by design — see the EC-4 false-positive test. `[_-]PWD` (not bare `PWD`)
 * catches `DB_PWD` without dropping the shell's working-directory `PWD`.
 * `CREDENTIAL` catches `GOOGLE_APPLICATION_CREDENTIALS`. #54-a extends the list to
 * the highest-signal VALUE-embedded-secret conventions — connection strings that
 * carry `user:password@` (`DATABASE_URL`, `REDIS_URL`, `MONGODB_URI`, `DB_URL`, …),
 * `DSN`, `WEBHOOK`, `COOKIE`, and `CONNECTION_STRING` — while deliberately NOT
 * dropping generic non-secret URLs (`PUBLIC_BASE_URL`, `API_URL`, `PGHOST`). A
 * denylist still cannot catch EVERY value-embedded secret — for untrusted children
 * use policy `"core"` (allowlist), the only fail-closed mode.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /KEY/i,
  /SECRET/i,
  /TOKEN/i,
  /PASSWORD/i,
  /PASSWD/i,
  /PASSPHRASE/i,
  /[_-]PWD/i,
  /CREDENTIAL/i,
  /PRIVATE/i,
  /_AUTH/i,
  // #54-a — value-embedded-secret conventions (no generic `*_URL` — see keep-list test).
  /DSN/i,
  /WEBHOOK/i,
  /COOKIE/i,
  /CONNECTION[_-]?STRING/i,
  // Known DB / message-broker connection-string vars (carry `user:pass@`).
  /(?:^|[_-])(?:DATABASE|DB|REDIS|MONGO(?:DB)?|POSTGRES(?:QL)?|MYSQL|MARIADB|AMQP|RABBITMQ|CLICKHOUSE|ELASTIC(?:SEARCH)?|CASSANDRA|COUCHDB|MEMCACHED|NATS|KAFKA)[_-]?(?:URL|URI|DSN|CONNECTION)/i,
];

/** True when an environment variable of this name should be treated as holding a secret. */
export function isSecretEnvName(name: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(name));
}

/** The trimmed values of every such variable in `env` that are at least `minLength` long. */
export function secretEnvValues(
  env: Readonly<Record<string, string | undefined>>,
  options: { minLength?: number } = {},
): string[] {
  const minLength = Math.max(1, options.minLength ?? 1);
  const out: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || !isSecretEnvName(name)) continue;
    const trimmed = value.trim();
    if (trimmed.length >= minLength) out.push(trimmed);
  }
  return out;
}
