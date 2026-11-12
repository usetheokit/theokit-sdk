import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { AuthenticationError, ConfigurationError } from "../../../src/errors.js";
import {
  createStdioMuseTransport,
  MuseClient,
  type MuseClientMessage,
  type MuseServerEvent,
  type MuseTransport,
  resolveMuseBinary,
} from "../../../src/internal/llm/muse.js";
import type { LlmRequest } from "../../../src/internal/llm/types.js";

const REQUEST: LlmRequest = {
  model: "muse-code",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
};

function fake(events: MuseServerEvent[], sent: MuseClientMessage[]): MuseTransport {
  return {
    open: async () => ({
      send: (m) => {
        sent.push(m);
      },
      close: () => {},
      events: {
        async *[Symbol.asyncIterator]() {
          yield* events;
        },
      },
    }),
  };
}

async function run(client: MuseClient) {
  const gen = client.stream(REQUEST, new AbortController().signal);
  for (;;) {
    const r = await gen.next();
    if (r.done) return r.value;
  }
}

describe("MuseClient", () => {
  it("returns the model text for a turn", async () => {
    const sent: MuseClientMessage[] = [];
    const client = new MuseClient({
      transport: fake(
        [
          { type: "text_delta", text: "hel" },
          { type: "text_delta", text: "lo" },
          { type: "turn_end" },
        ],
        sent,
      ),
    });
    const finish = await run(client);
    expect(finish.text).toBe("hello");
    expect(finish.stopReason).toBe("end_turn");
    expect(sent[0]).toMatchObject({ type: "turn", model: "muse-code", prompt: "hi" });
  });

  it("routes a tool approval through the caller", async () => {
    const sent: MuseClientMessage[] = [];
    const seen: string[] = [];
    const client = new MuseClient({
      transport: fake(
        [
          { type: "permission_request", id: "p1", tool: "bash", input: { cmd: "ls" } },
          { type: "turn_end" },
        ],
        sent,
      ),
      onApproval: (r) => {
        seen.push(r.tool);
        return true;
      },
    });
    await run(client);
    expect(seen).toEqual(["bash"]);
    expect(sent).toContainEqual({ type: "permission_response", id: "p1", allow: true });
  });

  it("denies approvals when no callback is given", async () => {
    const sent: MuseClientMessage[] = [];
    await run(
      new MuseClient({
        transport: fake(
          [{ type: "permission_request", id: "p", tool: "bash", input: {} }, { type: "turn_end" }],
          sent,
        ),
      }),
    );
    expect(sent).toContainEqual({ type: "permission_response", id: "p", allow: false });
  });

  it("raises a typed error when muse is not signed in", async () => {
    const client = new MuseClient({
      transport: fake([{ type: "error", code: "not_signed_in", message: "no session" }], []),
    });
    const err = await run(client).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect((err as AuthenticationError).code).toBe("muse_not_signed_in");
  });

  it("raises a typed error when muse is not installed", async () => {
    const client = new MuseClient({
      transport: {
        open: async () => {
          throw new ConfigurationError("x", { code: "muse_not_installed" });
        },
      },
    });
    const err = await run(client).catch((e: unknown) => e);
    expect((err as ConfigurationError).code).toBe("muse_not_installed");
  });

  it("the default transport reports a missing binary", async () => {
    const { createStdioMuseTransport } = await import("../../../src/internal/llm/muse.js");
    const err = await createStdioMuseTransport("muse-does-not-exist-976")
      .open(new AbortController().signal)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigurationError);
    expect((err as ConfigurationError).code).toBe("muse_not_installed");
  });
});

describe("resolveMuseBinary and the stdio transport", () => {
  const dir = mkdtempSync(join(tmpdir(), "muse-bin-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function script(name: string, body: string, mode = 0o755): string {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, mode);
    return path;
  }

  it("finds an executable on an absolute PATH entry", () => {
    const path = script("muse-a", "exit 0");
    expect(resolveMuseBinary("muse-a", `relative:${dir}`)).toBe(path);
  });

  it("ignores relative, empty, missing and non-executable candidates", () => {
    script("muse-noexec", "exit 0", 0o644);
    expect(resolveMuseBinary("muse-noexec", `${dir}`)).toBeUndefined();
    expect(resolveMuseBinary("muse-a", `.::relative`)).toBeUndefined();
    expect(resolveMuseBinary("muse-a", undefined)).toBeUndefined();
    expect(resolveMuseBinary(dir, "")).toBeUndefined();
  });

  it("accepts an absolute command", () => {
    const path = script("muse-abs", "exit 0");
    expect(resolveMuseBinary(path, "")).toBe(path);
    expect(resolveMuseBinary(join(dir, "nope"), "")).toBeUndefined();
  });

  it("runs a turn against a real child process", async () => {
    const bin = script(
      "muse-serve",
      `read line
echo '{"type":"text_delta","text":"hi"}'
echo 'not json'
echo '{"type":"turn_end","inputTokens":1,"outputTokens":2}'`,
    );
    const client = new MuseClient({ transport: createStdioMuseTransport(bin) });
    const finish = await run(client);
    expect(finish.text).toBe("hi");
    expect(finish.stopReason).toBe("end_turn");
  });

  it("fails when the child exits before the turn ends", async () => {
    const bin = script("muse-quit", "exit 0");
    const client = new MuseClient({ transport: createStdioMuseTransport(bin) });
    const err = await run(client).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("provider_unreachable");
  });
});
