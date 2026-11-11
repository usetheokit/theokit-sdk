import { describe, expect, it } from "vitest";
import { E2B_CA_BUNDLE, E2BSandbox, type E2BSandboxHandle } from "../../src/sandbox/index.js";
import { SandboxNotAvailableError } from "../../src/sandbox/types.js";

function named(name: string, extra: object = {}) {
  return Object.assign(new Error(name), { name, ...extra });
}

function fake(run: E2BSandboxHandle["commands"]["run"]) {
  const writes: { path: string; data: unknown }[] = [];
  let killed = 0;
  const sandbox: E2BSandboxHandle = {
    commands: { run },
    files: {
      write: async (path, data) => {
        writes.push({ path, data });
      },
    },
    kill: async () => {
      killed++;
    },
  };
  return { sandbox, writes, killed: () => killed };
}

describe("E2BSandbox", () => {
  it("passes envs and the CA bundle, returns output", async () => {
    let seen: unknown;
    const { sandbox } = fake(async (_c, o) => {
      seen = o;
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });
    const sb = new E2BSandbox({ sandbox, envs: { HOME: "/home/user" } });
    expect(await sb.execute("x")).toEqual({
      stdout: "ok",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });
    expect(seen).toMatchObject({
      envs: { HOME: "/home/user", NODE_EXTRA_CA_CERTS: E2B_CA_BUNDLE },
    });
  });

  it("maps CommandExitError to its exit code", async () => {
    const { sandbox } = fake(async () => {
      throw named("CommandExitError", { exitCode: 3, stdout: "a", stderr: "b" });
    });
    expect(await new E2BSandbox({ sandbox }).execute("x")).toEqual({
      stdout: "a",
      stderr: "b",
      exitCode: 3,
      timedOut: false,
    });
  });

  it("maps TimeoutError to 124", async () => {
    const { sandbox } = fake(async () => {
      throw named("TimeoutError");
    });
    expect(await new E2BSandbox({ sandbox }).execute("x")).toMatchObject({
      exitCode: 124,
      timedOut: true,
    });
  });

  it("does not report a dead sandbox as a timeout", async () => {
    for (const n of ["SandboxNotRunningError", "SandboxUnreachableError"]) {
      const { sandbox } = fake(async () => {
        throw named(n);
      });
      await expect(new E2BSandbox({ sandbox }).execute("x")).rejects.toBeInstanceOf(
        SandboxNotAvailableError,
      );
    }
  });

  it("rethrows unknown errors, uploads relative to workDir, disposes, exposes policy", async () => {
    const boom = new Error("boom");
    const f = fake(async () => {
      throw boom;
    });
    const policy = { mode: "allowlist", allow: ["github.com"] } as const;
    const sb = new E2BSandbox({ sandbox: f.sandbox, networkPolicy: policy, workDir: "/w" });
    await expect(sb.execute("x")).rejects.toBe(boom);
    await sb.uploadFile("a/b.txt", "hi");
    expect(f.writes[0]).toEqual({ path: "/w/a/b.txt", data: "hi" });
    expect(sb.networkPolicy).toBe(policy);
    await sb.dispose();
    expect(f.killed()).toBe(1);
  });
});
