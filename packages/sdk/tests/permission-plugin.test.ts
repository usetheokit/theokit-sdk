/**
 * M7-5 — PermissionPlugin wires PermissionEngine into the pre_tool_call veto.
 */
import { describe, expect, it } from "vitest";
import type { HookHandler, Plugin, PreToolCallDecision } from "../src/internal/plugins/types.js";
import { PermissionEngine } from "../src/permission-engine.js";
import { PermissionPlugin, type PermissionPluginOptions } from "../src/permission-plugin.js";

/** Register the plugin against a minimal ctx and capture its pre_tool_call handler. */
function captureHandler(engine: PermissionEngine, opts?: PermissionPluginOptions): HookHandler {
  const plugin = PermissionPlugin.create(engine, opts);
  let handler: HookHandler | undefined;
  const ctx = {
    registerTool() {},
    registerCommand() {},
    on(hook: string, h: HookHandler) {
      if (hook === "pre_tool_call") handler = h;
    },
  };
  if (plugin.kind !== "general") throw new Error("expected general plugin");
  void (plugin as Extract<Plugin, { kind: "general" }>).register(ctx as never);
  if (handler === undefined) throw new Error("no pre_tool_call handler registered");
  return handler;
}

describe("PermissionPlugin (M7-5)", () => {
  it("blocks a tool the engine denies", async () => {
    const engine = new PermissionEngine([{ tool: "shell", action: "deny" }]);
    const handler = captureHandler(engine);
    const decision = (await handler({ name: "shell", args: {} })) as
      | PreToolCallDecision
      | undefined;
    expect(decision?.block).toBe(true);
  });

  it("allows a tool the engine allows (no veto)", async () => {
    const engine = new PermissionEngine([{ tool: "read", action: "allow" }]);
    const handler = captureHandler(engine);
    expect(await handler({ name: "read", args: {} })).toBeUndefined();
  });

  it("blocks an 'ask' tool by default but honors onAsk", async () => {
    const engine = new PermissionEngine([{ tool: "edit", action: "ask" }]);
    const blocked = (await captureHandler(engine)({ name: "edit", args: {} })) as
      | PreToolCallDecision
      | undefined;
    expect(blocked?.block).toBe(true);

    const allowedViaOnAsk = await captureHandler(engine, { onAsk: () => undefined })({
      name: "edit",
      args: {},
    });
    expect(allowedViaOnAsk).toBeUndefined();
  });

  it("default-deny engine blocks an unlisted tool through the plugin", async () => {
    const engine = new PermissionEngine([{ tool: "read", action: "allow" }], {
      defaultAction: "deny",
    });
    const handler = captureHandler(engine);
    const decision = (await handler({ name: "unlisted", args: {} })) as
      | PreToolCallDecision
      | undefined;
    expect(decision?.block).toBe(true);
  });
});

describe("PermissionPlugin floor cwd", () => {
  it("checks a destructive command against the cwd it is given", async () => {
    const { PermissionPlugin } = await import("../src/permission-plugin.js");
    const { PermissionEngine } = await import("../src/permission-engine.js");
    const plugin = PermissionPlugin.create(new PermissionEngine([])) as unknown as {
      register: (c: { on: (e: string, f: (x: unknown) => unknown) => void }) => void;
    };
    const handlers: Array<(x: unknown) => unknown> = [];
    plugin.register({ on: (_e, f) => void handlers.push(f) });
    const handler = handlers[0];
    const dir = "/tmp/some-workspace-for-floor";
    const decision = await handler?.({
      name: "shell",
      args: { command: `rm -rf ${dir}` },
      cwd: dir,
    });
    expect(decision).toMatchObject({ block: true });
  });
});
