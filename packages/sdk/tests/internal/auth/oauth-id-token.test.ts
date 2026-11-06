import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { readStoredOAuth, writeCredential } from "../../../src/internal/auth/credential-store.js";
import { openaiDeviceLogin, pollDeviceToken } from "../../../src/internal/auth/oauth-device.js";
import {
  ensureFreshCredential,
  exchangeCode,
  persistOAuthTokens,
  refreshOAuthTokens,
} from "../../../src/internal/auth/oauth-engine.js";
import type {
  CredentialStoreConfig,
  DeviceDeps,
  DeviceOAuthConfig,
  HttpDeps,
  OAuthProviderConfig,
  OpenAIDeviceConfig,
  ResolvedCredential,
} from "../../../src/internal/auth/types.js";

/**
 * The OpenAI token endpoint answers with an `id_token` beside the access and refresh tokens. A consumer that
 * drives the Codex CLI needs it (plan type, account and email are claims of it), so it is kept from the
 * response to the file and through a refresh (usetheokit/theokit-sdk#821).
 */

const FIXED_NOW = 1_000_000_000_000;
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function newStore(): CredentialStoreConfig {
  const home = mkdtempSync(join(tmpdir(), "oauth-id-token-"));
  roots.push(home);
  return { home, dirName: ".theo-auth", fileName: "auth.json" };
}

const config: OAuthProviderConfig = {
  provider: "openai",
  authorizeEndpoint: "https://auth.test/authorize",
  tokenEndpoint: "https://auth.test/token",
  clientId: "cid-1",
  scopes: ["openid"],
  redirectUri: "https://app.test/cb",
};

const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const jwt = (payload: Record<string, unknown>) => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
};

const ID_TOKEN = jwt({ email: "owner@example.com", chatgpt_plan_type: "pro" });
const answering = (body: unknown): HttpDeps => ({
  now: () => FIXED_NOW,
  fetch: (async () => okJson(body)) as unknown as typeof fetch,
});
const authFile = (store: CredentialStoreConfig) =>
  JSON.parse(readFileSync(join(store.home, store.dirName, store.fileName), "utf8")) as Record<
    string,
    unknown
  >;

describe("the token response's id_token", () => {
  it("is kept by the authorization-code exchange", async () => {
    const tokens = await exchangeCode(
      config,
      { code: "C", verifier: "V" },
      answering({ access_token: "a", refresh_token: "r", expires_in: 60, id_token: ID_TOKEN }),
    );
    expect(tokens.idToken).toBe(ID_TOKEN);
  });

  it("is kept by a refresh", async () => {
    const tokens = await refreshOAuthTokens(
      config,
      "OLD",
      answering({ access_token: "a", refresh_token: "r", expires_in: 60, id_token: ID_TOKEN }),
    );
    expect(tokens.idToken).toBe(ID_TOKEN);
  });

  it("is absent when the provider sends none", async () => {
    const tokens = await exchangeCode(
      config,
      { code: "C", verifier: "V" },
      answering({ access_token: "a", refresh_token: "r", expires_in: 60 }),
    );
    expect("idToken" in tokens).toBe(false);
  });

  it("is ignored when it is not a non-empty string", async () => {
    const tokens = await exchangeCode(
      config,
      { code: "C", verifier: "V" },
      answering({ access_token: "a", refresh_token: "r", expires_in: 60, id_token: "" }),
    );
    expect("idToken" in tokens).toBe(false);
  });

  it("is kept by the RFC 8628 device poll", async () => {
    const deviceConfig: DeviceOAuthConfig = {
      ...config,
      deviceCodeEndpoint: "https://auth.test/device",
    };
    const deps: DeviceDeps = {
      now: () => FIXED_NOW,
      sleep: async () => {},
      fetch: (async () =>
        okJson({
          access_token: "acc",
          expires_in: 3600,
          id_token: ID_TOKEN,
        })) as unknown as typeof fetch,
    };
    const grant = {
      deviceCode: "dc",
      userCode: "UC",
      verificationUri: "u",
      interval: 1,
      expiresIn: 900,
    };
    expect((await pollDeviceToken(deviceConfig, grant, deps)).idToken).toBe(ID_TOKEN);
  });

  it("is kept by the OpenAI device login", async () => {
    const oaConfig: OpenAIDeviceConfig = {
      ...config,
      deviceUsercodeEndpoint: "https://auth.test/usercode",
      devicePollEndpoint: "https://auth.test/poll",
      verificationUri: "https://auth.test/verify",
    };
    const responses = [
      okJson({ device_auth_id: "d1", user_code: "UC", interval: 1 }),
      okJson({ authorization_code: "AC", code_verifier: "CV" }),
      okJson({ access_token: "acc", refresh_token: "ref", expires_in: 3600, id_token: ID_TOKEN }),
    ];
    let i = 0;
    const deps: DeviceDeps = {
      now: () => FIXED_NOW,
      sleep: async () => {},
      fetch: (async () => responses[i++]!) as unknown as typeof fetch,
    };
    const tokens = await openaiDeviceLogin(oaConfig, deps, { onPrompt: () => {} });
    expect(tokens.idToken).toBe(ID_TOKEN);
  });
});

describe("the stored id_token", () => {
  it("is written by persistOAuthTokens and read back", () => {
    const store = newStore();
    persistOAuthTokens(
      "openai",
      { access: "a", refresh: "r", expires: 1, idToken: ID_TOKEN },
      store,
    );
    expect(authFile(store).id_token).toBe(ID_TOKEN);
    expect(readStoredOAuth(store)?.id_token).toBe(ID_TOKEN);
  });

  it("leaves the file exactly as before when there is none", () => {
    const store = newStore();
    persistOAuthTokens("openai", { access: "a", refresh: "r", expires: 1 }, store);
    expect(Object.keys(authFile(store)).sort()).toEqual([
      "access",
      "expires",
      "provider",
      "refresh",
      "type",
    ]);
  });

  const expired: ResolvedCredential = {
    kind: "oauth",
    provider: "openai",
    apiKey: "OLD",
    source: "test",
    inferred: false,
    expiresAt: FIXED_NOW,
  };
  const storedWithIdToken = (store: CredentialStoreConfig, idToken: string) =>
    writeCredential(
      {
        type: "oauth",
        provider: "openai",
        access: "OLD",
        refresh: "OLD-REF",
        expires: FIXED_NOW,
        id_token: idToken,
      },
      store,
    );

  it("survives a refresh whose response carries none", async () => {
    const store = newStore();
    storedWithIdToken(store, ID_TOKEN);
    await ensureFreshCredential(
      expired,
      { config, store },
      answering({ access_token: "NEW", refresh_token: "NEW-REF", expires_in: 3600 }),
    );
    expect(readStoredOAuth(store)).toMatchObject({ access: "NEW", id_token: ID_TOKEN });
  });

  it("is replaced by the one a refresh returns", async () => {
    const store = newStore();
    storedWithIdToken(store, ID_TOKEN);
    const newer = jwt({ email: "owner@example.com", chatgpt_plan_type: "plus" });
    await ensureFreshCredential(
      expired,
      { config, store },
      answering({
        access_token: "NEW",
        refresh_token: "NEW-REF",
        expires_in: 3600,
        id_token: newer,
      }),
    );
    expect(readStoredOAuth(store)?.id_token).toBe(newer);
  });
});
