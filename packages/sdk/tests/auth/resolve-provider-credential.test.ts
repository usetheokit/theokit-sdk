import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as barrel from "../../src/auth/index.js";
import {
  DEFAULT_PROVIDER_CANDIDATES,
  ProviderCredentialError,
  resolveProviderCredential,
} from "../../src/auth/index.js";
import { getProviderProfile } from "../../src/providers.js";

const ANT = "sk-ant-api03-secretvalue";
const OAI = "sk-proj-secretvalue";

async function codeOf(p: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ProviderCredentialError);
    return e as ProviderCredentialError;
  }
  throw new Error("did not reject");
}

describe("resolveProviderCredential", () => {
  const env = { ANTHROPIC_API_KEY: ANT, OPENAI_API_KEY: OAI };

  it("is exported from the auth barrel", () => {
    expect(typeof barrel.resolveProviderCredential).toBe("function");
    expect(DEFAULT_PROVIDER_CANDIDATES.map((c) => c.name)).toEqual([
      "openrouter",
      "anthropic",
      "openai",
    ]);
  });

  it("uses the provider the model names", async () => {
    const r = await resolveProviderCredential({ env, model: "openai/gpt-4o-mini" });
    expect(r.provider).toBe("openai");
    expect(r.origin).toEqual({ kind: "env", envVar: "OPENAI_API_KEY" });
    expect(r.baseUrl).toBe(getProviderProfile("openai")?.baseUrl);
  });

  it("picks by priority for a bare model id (anthropic before openai)", async () => {
    const r = await resolveProviderCredential({ env, model: "gpt-4o-mini" });
    expect(r.provider).toBe("anthropic");
    expect(r.baseUrl).toBe(getProviderProfile("anthropic")?.baseUrl);
  });

  it("honours custom candidates", async () => {
    const r = await resolveProviderCredential({
      env,
      providers: [
        { name: "openai", envVar: "OPENAI_API_KEY", priority: 1 },
        { name: "anthropic", envVar: "ANTHROPIC_API_KEY", priority: 2 },
      ],
    });
    expect(r.provider).toBe("openai");
  });

  it("uses a pinned variable", async () => {
    const r = await resolveProviderCredential({ env, pinnedEnvVar: "OPENAI_API_KEY" });
    expect(r.provider).toBe("openai");
    expect(r.origin).toEqual({ kind: "pinned", envVar: "OPENAI_API_KEY" });
  });

  it("rejects an empty pinned variable", async () => {
    const e = await codeOf(resolveProviderCredential({ env: { X: "" }, pinnedEnvVar: "X" }));
    expect(e.code).toBe("pinned_credential_missing");
  });

  it("reads the store when env has no key", async () => {
    const home = mkHome({ type: "api", provider: "openai", api_key: OAI });
    const r = await resolveProviderCredential({
      env: {},
      model: "openai/gpt-4o",
      store: { home, dirName: ".t", fileName: "auth.json" },
    });
    expect(r.origin.kind).toBe("store");
    expect(r.apiKey).toBe(OAI);
  });

  it("never falls back when the named provider has no key", async () => {
    const e = await codeOf(
      resolveProviderCredential({ env: { OPENAI_API_KEY: OAI }, model: "anthropic/claude-x" }),
    );
    expect(e.code).toBe("model_provider_without_credential");
    expect(e.message).toContain("ANTHROPIC_API_KEY");
    expect(e.message).not.toContain(OAI);
  });

  it("refuses a key from the wrong vendor", async () => {
    const e = await codeOf(
      resolveProviderCredential({ env: { OPENAI_API_KEY: ANT }, model: "openai/gpt-4o" }),
    );
    expect(e.code).toBe("credential_provider_mismatch");
    expect(e.message).not.toContain(ANT);
  });

  it("lists every variable checked when nothing is set", async () => {
    const e = await codeOf(resolveProviderCredential({ env: {} }));
    expect(e.code).toBe("no_provider_credential");
    for (const c of DEFAULT_PROVIDER_CANDIDATES) expect(e.message).toContain(c.envVar);
  });
});

function mkHome(body: unknown): string {
  const home = mkdtempSync(join(tmpdir(), "rpc-"));
  const dir = join(home, ".t");
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, "auth.json"), JSON.stringify(body), { mode: 0o600 });
  return home;
}
