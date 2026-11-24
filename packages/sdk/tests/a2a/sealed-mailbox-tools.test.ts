import { describe, expect, it } from "vitest";
import { inMemoryTransport, sealedMailboxTools } from "../../src/a2a/index.js";

type Handler = (input: Record<string, unknown>) => unknown;

function setup() {
  const transport = inMemoryTransport();
  const { tools, wrapAgent } = sealedMailboxTools({
    transport,
    trusted: new Map([["bob", "key"]]),
  });
  const get = (n: string) => tools.find((t) => t.name === n)?.handler as Handler;
  return {
    transport,
    tools,
    wrapAgent,
    send: get("mailbox_send"),
    receive: get("mailbox_receive"),
  };
}

describe("sealedMailboxTools", () => {
  it("refuses send after receive in the same turn, allows it next turn", async () => {
    const { transport, wrapAgent, send, receive } = setup();
    await transport.send({ type: "message", payload: "hi", from: "bob", to: "self", timestamp: 1 });
    const agent = wrapAgent({
      async send(_prompt: string) {
        return "ok";
      },
    });
    await agent.send("turn 1");
    expect(await receive({})).toContain("From peer bob: hi");
    await expect(send({ to: "bob", text: "x" })).rejects.toThrow(/later turn/);
    await agent.send("turn 2");
    await send({ to: "bob", text: "y" });
    expect((await transport.poll("bob")).map((m) => m.payload)).toEqual(["y"]);
  });

  it("an empty receive does not engage the guard; unknown peers are refused", async () => {
    const { send, receive } = setup();
    expect(await receive({})).toBe("No messages.");
    await send({ to: "bob", text: "x" });
    await expect(send({ to: "http://evil", text: "x" })).rejects.toThrow(/Unknown peer/);
  });

  it("names are overridable", () => {
    const { tools } = sealedMailboxTools({
      transport: inMemoryTransport(),
      trusted: new Map(),
      names: { send: "s", receive: "r" },
    });
    expect(tools.map((t) => t.name)).toEqual(["s", "r"]);
  });
});
