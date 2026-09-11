import { describe, expect, it } from "vitest";

import type { Plugin } from "../src/internal/plugins/types.js";
import { PermissionEngine } from "../src/permission-engine.js";
import { PermissionPlugin } from "../src/permission-plugin.js";

/**
 * The floor is only a floor if the runtime consults it.
 *
 * `permissionFloorReason` was written with a docblock that says it sits "above every permission rule
 * and every mode — not a rule you can reorder", and for a while that sentence was the only thing
 * enforcing it. Measured: the module was imported by `src/index.ts` and by nothing else. The runtime
 * decision point — `permission-plugin.ts`'s `pre_tool_call` handler — asked the engine, then asked
 * the consumer's `canUseTool`, and never asked the floor.
 *
 * A tier a consumer has to remember to call is exactly as strong as their memory, which is the
 * failure mode this whole slice was written to remove. That it was committed while removing it
 * elsewhere is why the pin is here rather than in a comment.
 *
 * The `allow`-everything gate below is the point of the test: it is the strongest possible statement
 * a consumer can make, and the floor must survive it.
 */
function alwaysAllow() {
  return { behavior: "allow" as const };
}

/**
 * Collect the plugin's event handlers.
 *
 * `Plugin` is a definition object, not a class with `register` on its public type — the manager
 * calls it. Reaching for it here needs one cast, kept in ONE place with its reason, rather than
 * sprinkled at each call site where it would read as noise and stop being questioned.
 */
function registerInto(plugin: Plugin, into: Map<string, (ctx: unknown) => unknown>): void {
  const withRegister = plugin as unknown as {
    register: (ctx: { on: (event: string, fn: (ctx: unknown) => unknown) => void }) => void;
  };
  withRegister.register({ on: (event, fn) => void into.set(event, fn) });
}

describe("the protected-path floor fires from the runtime, not from the caller's memory", () => {
  it("refuses a write into .claude/ even when the engine and the gate both allow", async () => {
    const engine = new PermissionEngine([{ tool: "Write", action: "allow" }]);
    const plugin = PermissionPlugin.create(engine, { canUseTool: alwaysAllow });

    const handlers = new Map<string, (ctx: unknown) => unknown>();
    registerInto(plugin, handlers);
    const preToolCall = handlers.get("pre_tool_call");
    // A Map lookup is honestly optional, and asserting it beats silencing it: if the plugin ever
    // stops registering the event, this line names that instead of a downstream `undefined is not a
    // function` three frames away.
    expect(preToolCall, "the plugin registered no pre_tool_call handler").toBeDefined();

    const decision = await preToolCall?.({
      name: "Write",
      args: { file_path: ".claude/settings.json" },
      permissionMode: "bypassPermissions",
    });

    expect(
      decision,
      "an allow rule, an allowing gate and a bypass mode together reached the floor and passed",
    ).toMatchObject({ block: true });
    expect((decision as { message: string }).message).toContain("floor");
  });

  it("lets an ordinary write through, so the floor is not simply blocking everything", async () => {
    // The control. Without it, a handler that returned `{ block: true }` unconditionally would pass
    // the case above and prove nothing.
    const engine = new PermissionEngine([{ tool: "Write", action: "allow" }]);
    const plugin = PermissionPlugin.create(engine, { canUseTool: alwaysAllow });

    const handlers = new Map<string, (ctx: unknown) => unknown>();
    registerInto(plugin, handlers);
    const preToolCall = handlers.get("pre_tool_call");
    // A Map lookup is honestly optional, and asserting it beats silencing it: if the plugin ever
    // stops registering the event, this line names that instead of a downstream `undefined is not a
    // function` three frames away.
    expect(preToolCall, "the plugin registered no pre_tool_call handler").toBeDefined();

    const decision = await preToolCall?.({
      name: "Write",
      args: { file_path: "src/app.ts" },
      permissionMode: "default",
    });

    expect(decision, "an ordinary write was refused — the floor is over-matching").toBeUndefined();
  });
});
