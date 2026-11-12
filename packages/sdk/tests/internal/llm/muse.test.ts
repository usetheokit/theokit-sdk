import { chmodSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { AuthenticationError, ConfigurationError } from "../../../src/errors.js";
import {
  MuseClient,
  type MuseClientMessage,
  type MuseServerEvent,
  type MuseTransport,
} from "../../../src/internal/llm/muse.js";
import type { LlmRequest } from "../../../src/internal/llm/types.js";
import { removeTempDirRobustSync } from "../../helpers/temp-workspace.js";

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

  describe.skipIf(process.platform === "win32")("resolveMuseBinary", () => {
    const fakeBin = (mode: number) => {
      const dir = mkdtempSync(join(tmpdir(), "muse-bin-"));
      onTestFinished(() => removeTempDirRobustSync(dir));
      const file = join(dir, "muse");
      writeFileSync(file, '#!/bin/sh\nprintf \'{"type":"turn_end"}\\n\'\n');
      chmodSync(file, 0o755);
      chmodSync(dir, mode);
      return { dir, file };
    };

    it("finds an executable in a safe absolute PATH dir", async () => {
      const { resolveMuseBinary } = await import("../../../src/internal/llm/muse.js");
      const { dir, file } = fakeBin(0o755);
      expect(resolveMuseBinary("muse", ["relative", dir].join(delimiter))).toBe(file);
    });

    it("skips group/world-writable dirs, relative entries and missing binaries", async () => {
      const { resolveMuseBinary } = await import("../../../src/internal/llm/muse.js");
      const { dir } = fakeBin(0o777);
      expect(resolveMuseBinary("muse", dir)).toBeUndefined();
      expect(resolveMuseBinary("muse", "relative")).toBeUndefined();
      expect(resolveMuseBinary("muse", undefined)).toBeUndefined();
    });

    it("tries PATHEXT suffixes when given", async () => {
      const { resolveMuseBinary } = await import("../../../src/internal/llm/muse.js");
      const { dir, file } = fakeBin(0o755);
      renameSync(file, `${file}.exe`);
      expect(resolveMuseBinary("muse", dir, ".EXE;.CMD")).toBe(`${file}.exe`);
    });

    it("uses a path-like command as given", async () => {
      const { resolveMuseBinary } = await import("../../../src/internal/llm/muse.js");
      expect(resolveMuseBinary("./muse", "")).toBe("./muse");
    });

    it("uses an absolute command as given", async () => {
      const { resolveMuseBinary } = await import("../../../src/internal/llm/muse.js");
      expect(resolveMuseBinary("/opt/muse", "")).toBe("/opt/muse");
    });

    it("spawns the resolved binary and reads its events", async () => {
      const { createStdioMuseTransport } = await import("../../../src/internal/llm/muse.js");
      const { file } = fakeBin(0o755);
      const session = await createStdioMuseTransport(file).open(new AbortController().signal);
      const seen: string[] = [];
      for await (const ev of session.events) seen.push(ev.type);
      expect(seen).toEqual(["turn_end"]);
    });
  });
});
