import { describe, expect, it } from "vitest";
import type {
  AuthProvider,
  OAuthTransaction,
  SessionManager,
} from "../../../src/server/auth/index.js";
import {
  Auth,
  AuthCallbackError,
  AuthCancelledError,
  clearTransactionCookie,
  readTransactionCookie,
  writeTransactionCookie,
} from "../../../src/server/auth/index.js";

const SECRET = "test-secret-32-chars-abcdefghijK";
const ORIGIN = "https://app.example.com";

function fakeProvider(seen: { req?: unknown } = {}): AuthProvider<{ id: string }, "fake"> {
  return {
    name: "fake",
    createAuthorizationURL: (tx) => new URL(`https://idp.example.com/auth?state=${tx.state}`),
    async handleCallback(req) {
      seen.req = req;
      return { profile: { id: "u1" }, providerName: "fake" };
    },
  };
}

function session(): SessionManager<{ id: string }> {
  return {
    getSession: async () => null,
    createSession: async () => {},
    destroySession: () => {},
    rotateSession: async () => null,
    getCookieSecret: () => SECRET,
    async createSessionWeb(headers, data) {
      headers.append("Set-Cookie", `sid=${data.id}; HttpOnly`);
    },
  };
}

function auth(seen?: { req?: unknown }, sm: SessionManager<{ id: string }> = session()) {
  return Auth.create<{ id: string }>({
    session: sm,
    providers: [fakeProvider(seen)],
    onSignIn: async ({ profile }) => ({ id: (profile as { id: string }).id }),
  });
}

async function start(a = auth()) {
  const res = await a.startSignInWeb("fake", new Request(`${ORIGIN}/login`));
  const cookie = res.headers.get("set-cookie") ?? "";
  const state = new URL(res.headers.get("location") ?? "").searchParams.get("state") ?? "";
  return { res, cookie, state, pair: cookie.split(";")[0] ?? "" };
}

function callback(query: string, cookie?: string): Request {
  return new Request(`${ORIGIN}/cb?${query}`, { headers: cookie ? { cookie } : {} });
}

describe("Web orchestrator", () => {
  it("startSignInWeb sets the hardened transaction cookie; finishSignInWeb completes", async () => {
    const seen: { req?: unknown } = {};
    const a = auth(seen);
    const { res, cookie, state, pair } = await start(a);
    expect(res.status).toBe(302);
    expect(cookie).toMatch(/^__Host-theo_oauth_tx=/);
    for (const attr of ["HttpOnly", "Secure", "SameSite=Lax", "Max-Age=600", "Path=/"]) {
      expect(cookie).toContain(attr);
    }
    const headers = new Headers();
    const out = await a.finishSignInWeb("fake", callback(`code=c&state=${state}`, pair), headers);
    expect(out.session).toEqual({ id: "u1" });
    expect(seen.req).toBeInstanceOf(Request);
    const lines = headers.getSetCookie();
    expect(lines).toContain("sid=u1; HttpOnly");
    expect(
      lines.some((l) => l.startsWith("__Host-theo_oauth_tx=;") && l.includes("Max-Age=0")),
    ).toBe(true);
  });

  it("round-trips a transaction through the public helpers", async () => {
    const now = Date.now();
    const tx: OAuthTransaction = {
      state: "s",
      pkceVerifier: "p",
      returnTo: "/x",
      createdAt: now,
      expiresAt: now + 1000,
    };
    const headers = new Headers([["Set-Cookie", "other=1"]]);
    await writeTransactionCookie(headers, tx, SECRET);
    expect(headers.getSetCookie()[0]).toBe("other=1");
    const pair = (headers.getSetCookie()[1] ?? "").split(";")[0] ?? "";
    expect(await readTransactionCookie(callback("", pair), SECRET)).toEqual(tx);
    clearTransactionCookie(headers);
    expect(headers.getSetCookie()).toHaveLength(2);
  });

  it("rejects a state mismatch", async () => {
    const { pair } = await start();
    await expect(
      auth().finishSignInWeb("fake", callback("code=c&state=nope", pair), new Headers()),
    ).rejects.toMatchObject({ code: "oauth_state_mismatch" });
  });

  it("rejects a missing or tampered cookie as expired", async () => {
    const a = auth();
    const { pair, state } = await start(a);
    await expect(
      a.finishSignInWeb("fake", callback(`state=${state}`), new Headers()),
    ).rejects.toMatchObject({ code: "oauth_transaction_expired" });
    const bad = `${pair.slice(0, -2)}AA`;
    expect(await readTransactionCookie(callback("", bad), SECRET)).toBeNull();
    const err = await a
      .finishSignInWeb("fake", callback(`state=${state}`, bad), new Headers())
      .catch((e) => e);
    expect(err).toBeInstanceOf(AuthCallbackError);
    expect(err.code).toBe("oauth_transaction_expired");
  });

  it("maps provider errors", async () => {
    const a = auth();
    await expect(
      a.finishSignInWeb("fake", callback("error=access_denied"), new Headers()),
    ).rejects.toBeInstanceOf(AuthCancelledError);
    await expect(
      a.finishSignInWeb("fake", callback("error=server_error"), new Headers()),
    ).rejects.toMatchObject({ code: "oauth_provider_error" });
  });

  it("fails clearly when the session manager has no Web write", async () => {
    const sm = session();
    sm.createSessionWeb = undefined;
    const a = auth(undefined, sm);
    const { pair, state } = await start(a);
    await expect(
      a.finishSignInWeb("fake", callback(`state=${state}`, pair), new Headers()),
    ).rejects.toMatchObject({ code: "session_web_unsupported" });
  });
});
