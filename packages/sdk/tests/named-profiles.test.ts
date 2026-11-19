import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigurationError } from "../src/errors.js";
import { _resetForTests, setTokens } from "../src/internal/mcp/token-storage.js";
import { applyProfile, ProfileConflictError, resolveProfile } from "../src/persistence.js";

const POSIX = process.platform !== "win32";
let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "theokit-profile-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const mode = (p: string) => statSync(p).mode & 0o777;

describe("resolveProfile", () => {
  it("maps name to directories and env", () => {
    const p = resolveProfile("work", {
      profilesRoot: tmp,
      appDirectories: { APP_WORKSPACE: "workspace" },
    });
    expect(p.env.THEOKIT_HOME).toBe(join(tmp, "work"));
    expect(p.env.THEOKIT_AUTH_HOME).toBe(join(tmp, "work"));
    expect(p.env.APP_WORKSPACE).toBe(join(tmp, "work", "workspace"));
    expect(p.directories).toEqual([join(tmp, "work"), join(tmp, "work", "workspace")]);
  });

  it.each(["../etc", "A", "", "a".repeat(17)])("rejects name %j", (name) => {
    try {
      resolveProfile(name);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigurationError);
      expect((e as ConfigurationError).code).toBe("profile_name_invalid");
      if (name) expect((e as Error).message).not.toContain(name);
    }
  });

  it.each(["../out", "/abs", "a/../b", "THEOKIT_HOME"])("rejects app directory %j", (v) => {
    const appDirectories: Record<string, string> =
      v === "THEOKIT_HOME" ? { THEOKIT_HOME: "x" } : { X: v };
    expect(() => resolveProfile("work", { profilesRoot: tmp, appDirectories })).toThrow(
      ConfigurationError,
    );
  });
});

describe("applyProfile", () => {
  it.skipIf(!POSIX)("creates 0700, tightens existing, keeps files", async () => {
    const p = resolveProfile("work", { profilesRoot: tmp, appDirectories: { W: "workspace" } });
    mkdirSync(p.directory, { recursive: true });
    chmodSync(p.directory, 0o755);
    writeFileSync(join(p.directory, "keep.txt"), "x");
    const env: NodeJS.ProcessEnv = {};
    await applyProfile(p, env);
    for (const d of p.directories) expect(mode(d)).toBe(0o700);
    expect(readFileSync(join(p.directory, "keep.txt"), "utf8")).toBe("x");
    expect(env.THEOKIT_HOME).toBe(p.directory);
  });

  it("refuses a conflict without touching env or disk", async () => {
    const p = resolveProfile("work", { profilesRoot: tmp });
    const env: NodeJS.ProcessEnv = { THEOKIT_HOME: "/x", THEOKIT_AUTH_HOME: "  " };
    const err = await applyProfile(p, env).catch((e) => e);
    expect(err).toBeInstanceOf(ProfileConflictError);
    expect(err.variables).toEqual(["THEOKIT_HOME"]);
    expect(err.message).not.toContain("/x");
    expect(env).toEqual({ THEOKIT_HOME: "/x", THEOKIT_AUTH_HOME: "  " });
    expect(() => statSync(p.directory)).toThrow();
  });

  it("names path and errno on failure and leaves env unchanged", async () => {
    const blocker = join(tmp, "file");
    writeFileSync(blocker, "");
    const p = resolveProfile("work", { profilesRoot: blocker });
    const env: NodeJS.ProcessEnv = {};
    const err = await applyProfile(p, env).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigurationError);
    expect(err.code).toBe("profile_directory_failed");
    expect(err.message).toContain(p.directory);
    expect(err.message).toMatch(/ENOTDIR|EEXIST/);
    expect(env).toEqual({});
  });

  it("makes the SDK write MCP tokens under the profile", async () => {
    const saved = { h: process.env.THEOKIT_HOME, a: process.env.THEOKIT_AUTH_HOME };
    try {
      delete process.env.THEOKIT_HOME;
      delete process.env.THEOKIT_AUTH_HOME;
      const p = resolveProfile("work", { profilesRoot: tmp });
      await applyProfile(p, process.env);
      _resetForTests();
      await setTokens("srv", { access_token: "t", token_type: "Bearer" } as never);
      expect(statSync(join(p.directory, "mcp-tokens.json")).isFile()).toBe(true);
    } finally {
      for (const [k, v] of [
        ["THEOKIT_HOME", saved.h],
        ["THEOKIT_AUTH_HOME", saved.a],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
