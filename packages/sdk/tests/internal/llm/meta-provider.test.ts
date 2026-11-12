import { describe, expect, it } from "vitest";

import { parseModelId } from "../../../src/internal/llm/model-identifier.js";
import type { MuseClientMessage, MuseTransport } from "../../../src/internal/llm/muse.js";
import { resolveProviderChain } from "../../../src/internal/llm/router.js";
import { getProviderProfile, registerBuiltins } from "../../../src/internal/providers/index.js";

describe("meta provider", () => {
  it("parses meta/<model> and the muse/ alias to the meta provider", () => {
    expect(parseModelId("meta/muse-code")).toEqual({ provider: "meta", name: "muse-code" });
    registerBuiltins();
    expect(getProviderProfile("meta")?.authType).toBe("none");
    expect(getProviderProfile("muse")?.name).toBe("meta");
  });

  it("the router builds a Muse client and hands approvals to the caller's callback", async () => {
    const sent: MuseClientMessage[] = [];
    const transport: MuseTransport = {
      open: async () => ({
        send: (m) => {
          sent.push(m);
        },
        close: () => {},
        events: {
          async *[Symbol.asyncIterator]() {
            yield { type: "permission_request", id: "a", tool: "bash", input: {} } as const;
            yield { type: "text_delta", text: "ok" } as const;
            yield { type: "turn_end" } as const;
          },
        },
      }),
    };
    const asked: string[] = [];
    const [client] = resolveProviderChain({
      primary: "meta",
      muse: {
        transport,
        onApproval: (r) => {
          asked.push(r.tool);
          return true;
        },
      },
    });
    expect(client?.name).toBe("meta");
    const gen = (client as NonNullable<typeof client>).stream(
      { model: "muse-code", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] },
      new AbortController().signal,
    );
    let r = await gen.next();
    while (!r.done) r = await gen.next();
    expect(r.value.text).toBe("ok");
    expect(asked).toEqual(["bash"]);
    expect(sent).toContainEqual({ type: "permission_response", id: "a", allow: true });
  });
});
