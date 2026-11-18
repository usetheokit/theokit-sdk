import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import { ConfigurationError } from "../src/errors.js";
import { fingerprintHookGate, hookFingerprint, listProjectHooks } from "../src/hooks-approval.js";
import { HooksExecutor } from "../src/internal/runtime/hooks/hooks-executor.js";

let cwd: string;
let markerA: string;
let markerB: string;

function hooksFile(command: string, timeout?: number, event = "PreToolUse") {
  return JSON.stringify({
    hooks: {
      [event]: [
        { hooks: [{ type: "command", command, ...(timeout === undefined ? {} : { timeout }) }] },
      ],
    },
  });
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "hook-allow-"));
  markerA = join(cwd, "ran-a");
  markerB = join(cwd, "ran-b");
  mkdirSync(join(cwd, ".theokit"), { recursive: true });
  writeFileSync(join(cwd, ".theokit", "hooks.json"), hooksFile(`touch ${markerA}`));
  writeFileSync(join(cwd, ".theokit", "settings.json"), hooksFile(`touch ${markerB}`, 5));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("hook allowlists", () => {
  it("pins the fingerprint format", () => {
    const expected = createHash("sha256").update("PreToolUse\necho hi\n30000").digest("hex");
    expect(
      hookFingerprint({ sourceEvent: "PreToolUse", command: "echo hi", timeoutMs: 30000 }),
    ).toBe(expected);
  });

  it("lists hooks from hooks.json and settings.json with sourcePath and default timeout", async () => {
    const hooks = await listProjectHooks(cwd);
    expect(hooks).toHaveLength(2);
    expect(hooks[0]?.sourcePath).toBe(join(cwd, ".theokit", "hooks.json"));
    expect(hooks[0]?.timeoutMs).toBe(30000);
    expect(hooks[1]?.sourcePath).toBe(join(cwd, ".theokit", "settings.json"));
    expect(hooks[1]?.timeoutMs).toBe(5000);
  });

  it("an agent gated by one fingerprint runs only that hook", async () => {
    const [first] = await listProjectHooks(cwd);
    const gate = fingerprintHookGate([(first?.fingerprint ?? "").toUpperCase()]);
    const executor = new HooksExecutor(cwd, [], gate);
    await executor.initialize(true);
    await executor.run({ event: "preToolUse", tool: "shell" });
    expect(existsSync(markerA)).toBe(true);
    expect(existsSync(markerB)).toBe(false);
  });

  it("Agent.create passes the gate through local.hooks: only the approved hook runs", async () => {
    writeFileSync(
      join(cwd, ".theokit", "hooks.json"),
      hooksFile(`touch ${markerA}`, undefined, "UserPromptSubmit"),
    );
    writeFileSync(
      join(cwd, ".theokit", "settings.json"),
      hooksFile(`touch ${markerB}`, 5, "UserPromptSubmit"),
    );
    const [first] = await listProjectHooks(cwd);
    const agent = await Agent.create({
      apiKey: "theo_test_hook_gate",
      model: { id: "openai/gpt-4o-mini" },
      local: {
        cwd,
        settingSources: ["project"],
        hooks: fingerprintHookGate([first?.fingerprint ?? ""]),
      },
    });
    const run = await agent.send("hi");
    for await (const _ of run.stream()) {
      // drain
    }
    await agent.dispose();
    expect(existsSync(markerA)).toBe(true);
    expect(existsSync(markerB)).toBe(false);
  });

  it("listProjectHooks defaults compatSources from .theokit/config.json; an explicit option overrides it", async () => {
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "settings.json"), hooksFile("echo from-claude"));
    expect(await listProjectHooks(cwd)).toHaveLength(2);
    writeFileSync(
      join(cwd, ".theokit", "config.json"),
      JSON.stringify({ compat: { adapters: ["claude-code"] } }),
    );
    const viaFile = await listProjectHooks(cwd);
    expect(viaFile.map((h) => h.command)).toContain("echo from-claude");
    const overridden = await listProjectHooks(cwd, { compatSources: [] });
    expect(overridden.map((h) => h.command)).not.toContain("echo from-claude");
  });

  it("rejects an invalid fingerprint naming its position, not its value", () => {
    try {
      fingerprintHookGate(["abc"]);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigurationError);
      expect((e as ConfigurationError).code).toBe("hook_fingerprint_invalid");
      expect((e as Error).message).toContain("1");
      expect((e as Error).message).not.toContain("abc");
    }
  });

  it("an empty gate refuses every hook", async () => {
    const executor = new HooksExecutor(cwd, [], fingerprintHookGate([]));
    await executor.initialize(true);
    await executor.run({ event: "preToolUse", tool: "shell" });
    expect(existsSync(markerA)).toBe(false);
    expect(existsSync(markerB)).toBe(false);
  });
});
