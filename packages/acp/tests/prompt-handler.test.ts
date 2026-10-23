import type * as acp from "@agentclientprotocol/sdk";
import { type Run, type SDKAgent, UnknownAgentError } from "@theokit/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `handlePrompt` orchestrates three collaborators. Two of them talk to the
// outside world (the JSON-RPC connection, the plugin registry), so they are
// replaced here: what is under test is the ROUTING between them and the stop
// reason derived from the run — not their own behaviour, which has its own
// suites (translator.test.ts, permission-plugin.test.ts).
const translateStream = vi.fn(async () => undefined);
const installPermissionPlugin = vi.fn(async () => undefined);

vi.mock("../src/translator.js", () => ({
  translateStream: (...args: unknown[]) => translateStream(...(args as [])),
}));
vi.mock("../src/permission-plugin.js", () => ({
  installPermissionPlugin: (...args: unknown[]) => installPermissionPlugin(...(args as [])),
}));

/**
 * Measured before this file existed: `handlePrompt` was 0/44 lines with all six
 * functions at `FNDA:0`.
 *
 * That is "no coverage", which is not quite "no exercise": `serve-smoke.test.ts`
 * did drive this code end to end — but it spawns `bin/theokit-acp.mjs` as a
 * separate process, so v8 never attributed a single line to it and no assertion
 * ever reached the stop-reason mapping or the permission veto. The behaviour was
 * running in the dark.
 */

import { ACP_ERR } from "../src/lifecycle.js";
import { handlePrompt } from "../src/prompt-handler.js";
import { type AcpSession, SessionStore } from "../src/session-store.js";

type RunResult = {
  status: string;
  error?: { code?: string };
};

const makeRun = (result: RunResult): Run =>
  ({
    stream: () =>
      (async function* () {
        // No frames: the translator is mocked, so the stream's content is not
        // the oracle here. The stop reason is.
      })(),
    wait: async () => result,
  }) as unknown as Run;

interface Harness {
  store: SessionStore;
  session: AcpSession;
  deps: Parameters<typeof handlePrompt>[1];
  send: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
}

const SESSION_ID = "sess-1";

function makeHarness(
  opts: {
    runResult?: RunResult;
    sendImpl?: () => Promise<Run>;
    permissionMode?: "auto" | "deny" | "ask";
  } = {},
): Harness {
  const run = makeRun(opts.runResult ?? { status: "finished" });
  const send = vi.fn(opts.sendImpl ?? (async () => run));
  const log = vi.fn();
  const agent = { agentId: "a-1", send } as unknown as SDKAgent;
  const session: AcpSession = {
    sessionId: SESSION_ID,
    agent,
    createdAt: 0,
    lastUsedAt: 0,
    abortController: new AbortController(),
    cwd: "/tmp",
  };
  const store = new SessionStore();
  store.create(session);
  return {
    store,
    session,
    send,
    log,
    deps: {
      store,
      conn: {} as acp.AgentSideConnection,
      maxPromptBytes: 1024,
      permissionMode: opts.permissionMode ?? "auto",
      permissionTimeoutMs: 1000,
      trustedTools: new Set<string>(),
      log,
    },
  };
}

const promptWith = (text: string): acp.PromptRequest =>
  ({
    sessionId: SESSION_ID,
    prompt: [{ type: "text", text }],
  }) as unknown as acp.PromptRequest;

beforeEach(() => {
  vi.clearAllMocks();
  translateStream.mockImplementation(async () => undefined);
  installPermissionPlugin.mockImplementation(async () => undefined);
});

describe("handlePrompt — session guard", () => {
  it("rejects an unknown session with INVALID_SESSION and never reaches the agent", async () => {
    const h = makeHarness();
    const params = { sessionId: "does-not-exist", prompt: [{ type: "text", text: "hi" }] };

    const out = await handlePrompt(params as unknown as acp.PromptRequest, h.deps);

    expect(out).toEqual({
      error: { code: ACP_ERR.INVALID_SESSION, message: "unknown session: does-not-exist" },
    });
    expect(h.send).not.toHaveBeenCalled();
  });

  // § 4.2 — the accepted input. Without this row a guard that rejected EVERY
  // session id would pass the rejection test above for the wrong reason.
  it("accepts a known session and runs the prompt", async () => {
    const h = makeHarness();

    const out = await handlePrompt(promptWith("hello"), h.deps);

    expect(out).toEqual({ response: { stopReason: "end_turn" } });
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("stamps lastUsedAt on the session it served", async () => {
    const h = makeHarness();
    expect(h.session.lastUsedAt).toBe(0);

    await handlePrompt(promptWith("hello"), h.deps);

    expect(h.session.lastUsedAt).toBeGreaterThan(0);
  });
});

describe("handlePrompt — prompt extraction", () => {
  it("rejects an empty prompt with INVALID_REQUEST and never reaches the agent", async () => {
    const h = makeHarness();

    const out = await handlePrompt(promptWith(""), h.deps);

    expect(out).toEqual({
      error: { code: ACP_ERR.INVALID_REQUEST, message: "empty prompt" },
    });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("maps an oversized prompt to INVALID_REQUEST carrying the extractor's own message", async () => {
    const h = makeHarness();
    h.deps.maxPromptBytes = 4;

    const out = await handlePrompt(promptWith("a".repeat(500)), h.deps);

    expect(out).toHaveProperty("error");
    const { error } = out as { error: { code: number; message: string } };
    expect(error.code).toBe(ACP_ERR.INVALID_REQUEST);
    // The extractor's OWN message must survive verbatim rather than being
    // flattened into a generic string: the limit and the actual size are the
    // only things telling the caller what to change. Asserting merely that
    // *some* non-empty message came back would pass on "invalid request".
    expect(error.message).toBe("prompt exceeds 4 bytes (got 500)");
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("prompt extract rejected"));
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe("handlePrompt — permission veto (SEC-M0-03, fail-closed)", () => {
  it("skips plugin installation entirely when the mode is auto", async () => {
    const h = makeHarness({ permissionMode: "auto" });

    await handlePrompt(promptWith("hello"), h.deps);

    expect(installPermissionPlugin).not.toHaveBeenCalled();
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("installs the plugin before sending when the mode is not auto", async () => {
    const h = makeHarness({ permissionMode: "ask" });

    await handlePrompt(promptWith("hello"), h.deps);

    expect(installPermissionPlugin).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("REFUSES the prompt when the permission plugin cannot be installed", async () => {
    const h = makeHarness({ permissionMode: "deny" });
    installPermissionPlugin.mockRejectedValueOnce(new Error("runtime cannot enforce permissions"));

    const out = await handlePrompt(promptWith("hello"), h.deps);

    expect(out).toEqual({
      error: {
        code: ACP_ERR.INTERNAL_ERROR,
        message: "runtime cannot enforce permissions",
      },
    });
    // The point of fail-closed: the agent must NOT run unsupervised when the
    // veto could not be attached. A response here instead of an error would be
    // the whole vulnerability.
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe("handlePrompt — stop reason derivation", () => {
  const cases: Array<[string, RunResult, acp.StopReason]> = [
    ["a finished run ends the turn", { status: "finished" }, "end_turn"],
    ["a cancelled run reports cancelled", { status: "cancelled" }, "cancelled"],
    [
      "an aborted error code reports cancelled",
      { status: "error", error: { code: "aborted" } },
      "cancelled",
    ],
    [
      "a safety block reports refusal",
      { status: "error", error: { code: "safety_blocked" } },
      "refusal",
    ],
    [
      "an exhausted context reports max_tokens",
      { status: "error", error: { code: "context_length_exceeded" } },
      "max_tokens",
    ],
    [
      "a max_tokens error reports max_tokens",
      { status: "error", error: { code: "max_tokens" } },
      "max_tokens",
    ],
    [
      "an iteration cap reports max_turn_requests",
      { status: "error", error: { code: "max_iterations" } },
      "max_turn_requests",
    ],
  ];

  for (const [name, runResult, expected] of cases) {
    it(name, async () => {
      const h = makeHarness({ runResult });

      const out = await handlePrompt(promptWith("hello"), h.deps);

      expect(out).toEqual({ response: { stopReason: expected } });
    });
  }
});

describe("handlePrompt — failure paths", () => {
  // B-125 — the stop-reason mapping used to fall through to `end_turn` for any
  // error code it didn't recognize, so an errored run was reported to the ACP
  // client as a normal, successful end of turn: the failure was invisible on
  // the wire. `StopReason` (from `@agentclientprotocol/sdk`) has no value that
  // means "error" — `"end_turn" | "max_tokens" | "max_turn_requests" |
  // "refusal" | "cancelled"` — so a run status the mapping can't place must
  // surface through the protocol's OTHER failure channel: the JSON-RPC
  // `{ error: AcpError }` response `handlePrompt` already uses for every other
  // rejection in this file, not through the `StopReason` enum.
  it("test_an_unmapped_error_code_reaches_the_client_as_a_failure_not_end_turn", async () => {
    const h = makeHarness({
      runResult: { status: "error", error: { code: "provider_5xx" } },
    });

    const out = await handlePrompt(promptWith("hello"), h.deps);

    expect(out).toEqual({
      error: {
        code: ACP_ERR.INTERNAL_ERROR,
        message: expect.stringContaining("provider_5xx"),
      },
    });
  });

  it("converts an AbortError from agent.send into a cancelled response, not an error", async () => {
    const abort = new Error("the run was stopped");
    abort.name = "AbortError";
    const h = makeHarness({
      sendImpl: async () => {
        throw abort;
      },
    });

    const out = await handlePrompt(promptWith("hello"), h.deps);

    expect(out).toEqual({ response: { stopReason: "cancelled" } });
  });

  it("treats a message mentioning 'aborted' as a cancellation even without the AbortError name", async () => {
    const h = makeHarness({
      sendImpl: async () => {
        throw new Error("stream aborted by peer");
      },
    });

    const out = await handlePrompt(promptWith("hello"), h.deps);

    expect(out).toEqual({ response: { stopReason: "cancelled" } });
  });

  it("surfaces a non-abort failure from agent.send as INTERNAL_ERROR", async () => {
    const h = makeHarness({
      sendImpl: async () => {
        throw new Error("model provider unreachable");
      },
    });

    const out = await handlePrompt(promptWith("hello"), h.deps);

    expect(out).toEqual({
      error: { code: ACP_ERR.INTERNAL_ERROR, message: "model provider unreachable" },
    });
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("agent.send threw"));
  });

  it("still resolves the stop reason when the translator throws mid-stream", async () => {
    const h = makeHarness({ runResult: { status: "finished" } });
    translateStream.mockRejectedValueOnce(new Error("conn closed"));

    const out = await handlePrompt(promptWith("hello"), h.deps);

    // The translator's failure is contained: the run is still awaited and the
    // client still gets a terminal frame. Losing it would hang the ACP client.
    expect(out).toEqual({ response: { stopReason: "end_turn" } });
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("translator threw mid-stream"));
  });

  it("passes the session abort signal to both agent.send and the translator", async () => {
    const h = makeHarness();

    await handlePrompt(promptWith("hello"), h.deps);

    expect(h.send).toHaveBeenCalledWith("hello", { signal: h.session.abortController.signal });
    expect(translateStream).toHaveBeenCalledWith(
      expect.objectContaining({ signal: h.session.abortController.signal }),
    );
  });
});

// B-498, D4: a consumer whose agent was created with `throwOnError: true` gets a run whose
// `wait()` rejects on a failed run. The handler maps that rejection as it maps a resolved
// error run, and lets every other rejection reach its existing failure path.
describe("handlePrompt — a run whose wait() rejects", () => {
  const rejectingRun = (status: string, error: unknown): Run =>
    ({
      status,
      stream: () => (async function* () {})(),
      wait: async () => {
        throw error;
      },
    }) as unknown as Run;

  it("maps_a_rejected_run_to_the_same_stop_reason", async () => {
    const failure = new UnknownAgentError("limit reached", { code: "max_iterations" });
    const h = makeHarness({ sendImpl: async () => rejectingRun("error", failure) });

    const out = await handlePrompt(promptWith("hello"), h.deps);

    expect(out).toEqual({ response: { stopReason: "max_turn_requests" } });
  });

  it("answers_cancelled_when_wait_rejects_with_an_abort", async () => {
    const abort = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    const h = makeHarness({ sendImpl: async () => rejectingRun("cancelled", abort) });

    const out = await handlePrompt(promptWith("hello"), h.deps);

    expect(out).toEqual({ response: { stopReason: "cancelled" } });
  });
});
