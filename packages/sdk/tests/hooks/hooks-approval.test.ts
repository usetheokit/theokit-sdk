import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigurationError } from "../../src/errors.js";
import {
  fingerprintHookGate,
  hookFingerprint,
  listProjectHooks,
} from "../../src/hooks-approval.js";
import { HooksExecutor } from "../../src/internal/runtime/hooks/hooks-executor.js";

let cwd: string;
let markerA: string;
let markerB: string;

function hooksFile(command: string, timeout?: number) {
  return JSON.stringify({
    hooks: {
      PreToolUse: [
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
