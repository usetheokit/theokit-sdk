import { createServer, type Server } from "node:http";

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  Agent,
  type GeneralPlugin,
  type HookContextMap,
  type HookHandler,
  type HookName,
  type HookResultMap,
  Plugin,
  type PluginContext,
  type PreToolCallContext,
  type TypedHookHandler,
} from "../src/index.js";
import type { RunEvent } from "../src/types/run-events.js";
import { messageDelta, sseFrame } from "./helpers/anthropic-sse.js";
import { useTempCwd } from "./helpers/temp-workspace.js";

useTempCwd();

/** Compile-time only: never called, but type-checked by the package `typecheck`. */
function typeCases(ctx: PluginContext): void {
  // `c` is inferred as PreToolCallContext and a veto is accepted.
  ctx.on("pre_tool_call", (c) => {
    expectTypeOf(c).toEqualTypeOf<PreToolCallContext>();
    return c.name.length > 0 ? undefined : { block: true, message: "x" };
  });

  // @ts-expect-error `block` is the literal `true`; `{ block: false }` is not a veto.
  ctx.on("pre_tool_call", () => ({ block: false }));

  // Backward compatibility: handlers written against `unknown` still compile.
  ctx.on("pre_tool_call", (_ctx: unknown) => undefined);
  const legacy: HookHandler = () => "anything";
  ctx.on("pre_tool_call", legacy);
  ctx.on("post_tool_call", legacy);

  // Transform hooks receive the chained value first, the context second.
  ctx.on("transform_llm_output", (out, c) => `${String(out)}${c.runId}`);
  ctx.on("transform_tool_result", (_r, c) => c.toolCalls.length);
  ctx.on("pre_user_send", (c) => ({ recalledContext: c.prompt }));
  ctx.on("on_session_start", (c) => {
    expectTypeOf(c).toEqualTypeOf<HookContextMap["on_session_start"]>();
  });
}
void typeCases;

describe("typed plugin hooks (types)", () => {
  it("exports the maps and GeneralPlugin", () => {
    expectTypeOf<HookContextMap>().toHaveProperty("pre_tool_call");
    expectTypeOf<keyof HookContextMap>().toEqualTypeOf<HookName>();
    expectTypeOf<keyof HookResultMap>().toEqualTypeOf<HookName>();
    expectTypeOf<TypedHookHandler<"post_tool_call">>().parameters.toEqualTypeOf<
      [HookContextMap["post_tool_call"]]
    >();
    expectTypeOf<GeneralPlugin["kind"]>().toEqualTypeOf<"general">();
  });
});

function startStub(): Promise<{ server: Server; url: string }> {
  let call = 0;
  const server = createServer((_req, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream");
    res.write(sseFrame("message_start", "{}"));
    call += 1;
    if (call === 1) {
      res.write(
        sseFrame(
          "content_block_start",
          JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "tu-1", name: "risky", input: {} },
          }),
        ),
      );
      res.write(
        sseFrame(
          "content_block_delta",
          JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: "{}" },
          }),
        ),
      );
      res.write(
        sseFrame("content_block_stop", JSON.stringify({ type: "content_block_stop", index: 0 })),
      );
      res.write(messageDelta("tool_use", { input_tokens: 10, output_tokens: 5 }));
    } else {
      res.write(
        sseFrame(
          "content_block_delta",
          JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "done" },
          }),
        ),
      );
      res.write(messageDelta("end_turn", { input_tokens: 20, output_tokens: 5 }));
    }
    res.write(sseFrame("message_stop", "{}"));
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      if (typeof a !== "object" || a === null) throw new Error("bind failed");
      resolve({ server, url: `http://127.0.0.1:${a.port}` });
    });
  });
}

describe("typed plugin hooks (runtime)", () => {
  it("a typed pre_tool_call handler vetoes a tool call in a run", async () => {
    const stub = await startStub();
    const prevKey = process.env.ANTHROPIC_API_KEY;
    const prevUrl = process.env.ANTHROPIC_API_BASE_URL;
    process.env.ANTHROPIC_API_KEY = "sk-stub";
    process.env.ANTHROPIC_API_BASE_URL = stub.url;
    const events: RunEvent[] = [];
    let executed = false;
    try {
      const plugin: GeneralPlugin = Plugin.create({
        kind: "general",
        name: "typed-veto",
        version: "1.0.0",
        register(ctx) {
          ctx.on("pre_tool_call", (c) =>
            c.name === "risky" ? { block: true, message: "no risky" } : undefined,
          );
        },
      }) as GeneralPlugin;
      const agent = await Agent.create({
        apiKey: "real-not-fixture",
        model: { id: "claude-sonnet-4-6" },
        tools: [
          {
            name: "risky",
            description: "gated",
            inputSchema: { type: "object", properties: {} },
            handler: () => {
              executed = true;
              return "ok";
            },
          },
        ],
        plugins: [plugin],
      });
      const run = await agent.send("do it", { onRunEvent: (e) => events.push(e) });
      for await (const _ of run.stream()) {
        // drain
      }
    } finally {
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevKey;
      if (prevUrl === undefined) delete process.env.ANTHROPIC_API_BASE_URL;
      else process.env.ANTHROPIC_API_BASE_URL = prevUrl;
      stub.server.close();
    }
    expect(executed).toBe(false);
    expect(events.find((e) => e.type === "permission_denied")).toMatchObject({ toolName: "risky" });
  });
});
