/**
 * Lint test (T5.2, ADR D68 derived) — bans direct references to
 * `.accessToken` in production sinks. All log/telemetry/error/transcript
 * surfaces must mask credentials via `redactSecrets` or never expose
 * the raw token.
 *
 * Allowlist:
 * - `credential-pool.ts` — the source of truth (data structure)
 * - `credential-pool-types.ts` — interface definitions
 * - `pool-aware-client.ts` — passes accessToken to the LlmClient builder
 *   only; the builder is internal (provider HTTP) and tokens are never
 *   logged from there
 * - `router.ts` — constructs PoolAware via buildClient(apiKey)
 *
 * @internal
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { expectScopeCovered } from "./_scope-sentinel.js";

const SRC_ROOT = join(__dirname, "..", "..", "src");

const ALLOWLIST = new Set<string>([
  "internal/llm/credential-pool.ts",
  "internal/llm/credential-pool-types.ts",
  "internal/llm/pool-aware-client.ts",
  "internal/llm/router.ts",
  // MCP OAuth uses its own `accessToken` field on the OAuth token (different
  // type — `OAuthTokens.accessToken`, not `PooledCredential.accessToken`).
  // OAuth tokens have their own redaction discipline via D68.
  "internal/mcp/oauth.ts",
  "internal/mcp/oauth-bearer.ts",
  "internal/mcp/oauth-types.ts",
  "internal/mcp/token-storage.ts",
  "internal/mcp/oauth-flow.ts",
  "internal/mcp/oauth-server.ts",
]);

interface Offender {
  file: string;
  line: number;
  text: string;
}

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  const entries = await readdir(dir);
  for (const name of entries) {
    const full = join(dir, name);
    const s = await stat(full);
    if (s.isDirectory()) await walk(full, out);
    else if (full.endsWith(".ts") && !full.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const PATTERN = /\.accessToken\b/;

async function scanFile(file: string): Promise<Offender[]> {
  const rel = relative(SRC_ROOT, file);
  if (ALLOWLIST.has(rel)) return [];
  const text = await readFile(file, "utf8");
  const offenders: Offender[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line !== undefined && PATTERN.test(line)) {
      offenders.push({ file: rel, line: i + 1, text: line.trim() });
    }
  }
  return offenders;
}

describe("no unredacted pool accessToken in src (T5.2)", () => {
  it("packages/sdk/src/ has no `.accessToken` references outside the credential-pool module", async () => {
    const files = await walk(SRC_ROOT);
    expectScopeCovered(files, "index.ts", SRC_ROOT);
    const offenders: Offender[] = [];
    for (const file of files) {
      offenders.push(...(await scanFile(file)));
    }
    expect(offenders).toEqual([]);
  });
});
