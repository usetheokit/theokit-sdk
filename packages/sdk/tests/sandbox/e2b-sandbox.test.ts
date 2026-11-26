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

describe("E2BSandbox openTerminal", () => {
  const idle = async () => ({ stdout: "", stderr: "", exitCode: 0 });

  it("is absent when the handle has no pty", () => {
    const { sandbox } = fake(idle);
    expect(new E2BSandbox({ sandbox }).openTerminal).toBeUndefined();
  });

  it("adapts the pty: command, input, resize, unsubscribe, kill, exit", async () => {
    const sent: string[] = [];
    const calls: string[] = [];
    let emit: (d: Uint8Array) => void = () => {};
    let finish: (r: { exitCode: number }) => void = () => {};
    const { sandbox } = fake(idle);
    sandbox.pty = {
      create: async (o) => {
        emit = o.onData as (d: Uint8Array) => void;
        calls.push(`create ${o.cols}x${o.rows} ${o.cwd}`);
        emit(new TextEncoder().encode("early"));
        return { pid: 7, wait: () => new Promise((r) => (finish = r)) };
      },
      sendInput: async (_pid, d) => {
        sent.push(new TextDecoder().decode(d));
      },
      resize: async (pid, s) => {
        calls.push(`resize ${pid} ${s.cols}x${s.rows}`);
      },
      kill: async (pid) => {
        calls.push(`kill ${pid}`);
      },
    };
    const term = await new E2BSandbox({ sandbox, workDir: "/w" }).openTerminal?.("echo hi", {
      cols: 80,
      rows: 24,
    });
    if (!term) throw new Error("no terminal");
    expect(sent[0]).toBe("exec sh -c 'echo hi'\n");
    const got: string[] = [];
    const off = term.onData((d) => got.push(new TextDecoder().decode(d)));
    expect(got).toEqual(["early"]);
    emit(new TextEncoder().encode("more"));
    off();
    emit(new TextEncoder().encode("ignored"));
    expect(got).toEqual(["early", "more"]);
    await term.write("x");
    expect(sent[1]).toBe("x");
    await term.resize(100, 40);
    await term.kill();
    expect(calls).toEqual(["create 80x24 /w", "resize 7 100x40", "kill 7"]);
    finish({ exitCode: 3 });
    expect(await term.wait()).toEqual({ exitCode: 3 });
  });

  it("maps CommandExitError from wait to its exit code", async () => {
    const { sandbox } = fake(idle);
    sandbox.pty = {
      create: async () => ({
        pid: 1,
        wait: async () => {
          throw named("CommandExitError", { exitCode: 2 });
        },
      }),
      sendInput: async () => undefined,
      resize: async () => undefined,
      kill: async () => undefined,
    };
    const term = await new E2BSandbox({ sandbox }).openTerminal?.("false", { cols: 1, rows: 1 });
    expect(await term?.wait()).toEqual({ exitCode: 2 });
  });
});
