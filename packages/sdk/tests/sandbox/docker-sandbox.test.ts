import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConfigurationError } from "../../src/errors.js";
import {
  type DockerRunner,
  DockerSandbox,
  defaultDockerRunner,
} from "../../src/sandbox/docker-sandbox.js";
import { SandboxNotAvailableError, SandboxSecurityError } from "../../src/sandbox/types.js";

function recorder(code = 0, timedOut = false) {
  const calls: { args: readonly string[]; input?: string | Buffer }[] = [];
  const runner: DockerRunner = async (args, o) => {
    calls.push({ args, input: o.input });
    return { stdout: "out", stderr: "", code, timedOut };
  };
  return { calls, runner };
}

describe("DockerSandbox (fake docker)", () => {
  it("confines the container: read-only root, no network, only workDir writable", async () => {
    const { calls, runner } = recorder();
    const sb = new DockerSandbox({ workDir: "/srv/ws", runner, user: "1:1" });
    const r = await sb.execute("echo hi");
    expect(r).toEqual({ stdout: "out", stderr: "", exitCode: 0, timedOut: false });
    const a = calls[0]?.args.join(" ") ?? "";
    expect(a).toContain("--read-only");
    expect(a).toContain("--network none");
    expect(a).toContain("--cap-drop ALL");
    expect(a).toContain("-v /srv/ws:/workspace:rw");
    expect(a.match(/-v /g)).toHaveLength(1);
    expect(a).toMatch(/sh -c echo hi$/);
    expect(sb.networkPolicy.mode).toBe("none");
  });

  it("maps non-zero exit to 1 and timeout to 124, removing the container", async () => {
    expect((await new DockerSandbox({ runner: recorder(3).runner }).execute("x")).exitCode).toBe(1);
    const t = recorder(null as unknown as number, true);
    const r = await new DockerSandbox({ runner: t.runner }).execute("sleep 9", { timeoutMs: 5 });
    expect(r).toMatchObject({ exitCode: 124, timedOut: true });
    expect(t.calls[1]?.args.slice(0, 2)).toEqual(["rm", "-f"]);
  });

  it("rejects uploads outside the workspace", async () => {
    const sb = new DockerSandbox({ runner: recorder().runner });
    await expect(sb.uploadFile("../etc/x", "a")).rejects.toBeInstanceOf(SandboxSecurityError);
    await expect(sb.uploadFile("/etc/x", "a")).rejects.toBeInstanceOf(SandboxSecurityError);
    await sb.uploadFile("sub/f.txt", "a");
  });

  it("removes the container when an upload times out", async () => {
    const t = recorder(null as unknown as number, true);
    await expect(new DockerSandbox({ runner: t.runner }).uploadFile("f", "a")).rejects.toThrow(
      /uploadFile failed/,
    );
    expect(t.calls[1]?.args.slice(0, 2)).toEqual(["rm", "-f"]);
  });

  it("defaults to a private temp workDir, not host /tmp", async () => {
    const { calls, runner } = recorder();
    await new DockerSandbox({ runner, user: "1:1" }).execute("true");
    const v = calls[0]?.args[calls[0].args.indexOf("-v") + 1] ?? "";
    expect(v).not.toMatch(/^\/tmp:/);
    expect(v).toContain("theokit-docker-ws-");
  });

  it("reports an unavailable docker instead of running on the host", async () => {
    const runner: DockerRunner = async () => {
      throw new Error("ENOENT");
    };
    await expect(new DockerSandbox({ runner }).execute("ls")).rejects.toBeInstanceOf(
      SandboxNotAvailableError,
    );
  });
});

function dockerUsable(): boolean {
  try {
    execFileSync("docker", ["image", "inspect", "alpine:3"], { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

// Real backend: runs only where a Docker daemon with alpine:3 is present (skipped otherwise).
// THEOKIT_REQUIRE_DOCKER=1 (set it in a Docker-equipped CI job) turns the skip into a failure.
describe.skipIf(!dockerUsable() && process.env.THEOKIT_REQUIRE_DOCKER !== "1")(
  "DockerSandbox (real docker)",
  () => {
    it("has docker when required", () => {
      expect(dockerUsable()).toBe(true);
    });

    it("cannot write outside its workspace", async () => {
      const ws = mkdtempSync(join(tmpdir(), "dsb-ws-"));
      const outside = mkdtempSync(join(tmpdir(), "dsb-out-"));
      try {
        const sb = new DockerSandbox({ workDir: ws });
        const ok = await sb.execute("echo inside > in.txt");
        expect(ok.exitCode).toBe(0);
        expect(readFileSync(join(ws, "in.txt"), "utf-8")).toBe("inside\n");
        const bad = await sb.execute(
          `echo x > /etc/pwned; echo x > /usr/pwned; echo x > ${outside}/pwned; echo x > ../pwned`,
        );
        expect(bad.exitCode).toBe(1);
        expect(existsSync(join(outside, "pwned"))).toBe(false);
        expect(existsSync(join(ws, "..", "pwned"))).toBe(false);
        expect((await sb.execute("test -e /etc/pwned")).exitCode).toBe(1);
        expect((await sb.execute("test -e /usr/pwned")).exitCode).toBe(1);
        await sb.uploadFile("a/b.txt", "hello");
        expect(readFileSync(join(ws, "a/b.txt"), "utf-8")).toBe("hello");
      } finally {
        rmSync(ws, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    }, 60_000);

    describe("openTerminal", () => {
      const text = (chunks: Uint8Array[]) => Buffer.concat(chunks).toString("utf-8");
      const openTerm = async (cmd: string, o: { cols: number; rows: number }) => {
        const t = await new DockerSandbox().openTerminal?.(cmd, o);
        if (!t) throw new Error("DockerSandbox has no openTerminal");
        return t;
      };
      const until = async (f: () => boolean) => {
        for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 100));
      };

      it("streams both ways and reports the exit code", async () => {
        const term = await openTerm("sh", { cols: 80, rows: 24 });
        const got: Uint8Array[] = [];
        term.onData((d) => got.push(d));
        await term.write("echo ready\n");
        await until(() => text(got).includes("ready"));
        expect(text(got)).toContain("ready");
        await term.write("exit\n");
        expect(await term.wait()).toEqual({ exitCode: 0 });
      }, 60_000);

      it("resize changes stty size", async () => {
        const term = await openTerm("sh", { cols: 80, rows: 24 });
        const got: Uint8Array[] = [];
        term.onData((d) => got.push(d));
        await term.resize(100, 40);
        await term.write("stty size\n");
        await until(() => text(got).includes("40 100"));
        expect(text(got)).toContain("40 100");
        await term.kill();
        await term.wait();
      }, 60_000);

      it("kill ends a running command", async () => {
        const term = await openTerm("sleep 600", { cols: 80, rows: 24 });
        await term.kill();
        await term.wait();
      }, 60_000);

      it("the unsubscribe function stops further calls", async () => {
        const term = await openTerm("sh", { cols: 80, rows: 24 });
        let calls = 0;
        const off = term.onData(() => calls++);
        await term.write("echo one\n");
        await until(() => calls > 0);
        off();
        const seen = calls;
        await term.write("echo two\n");
        await new Promise((r) => setTimeout(r, 500));
        expect(calls).toBe(seen);
        await term.kill();
        await term.wait();
      }, 60_000);
    });
  },
);

describe("DockerSandbox read-only workspace and labels", () => {
  it("mounts the workspace read-only", async () => {
    const { calls, runner } = recorder();
    await new DockerSandbox({ workDir: "/srv/ws", runner, readOnlyWorkspace: true }).execute("x");
    const args = calls[0]?.args ?? [];
    expect(args).toContain("/srv/ws:/workspace:ro");
    expect(args.join(" ")).not.toContain(":rw");
  });

  it("puts labels before the image", async () => {
    const { calls, runner } = recorder();
    await new DockerSandbox({
      workDir: "/srv/ws",
      runner,
      image: "img:1",
      labels: { "theoclaw.session": "s1" },
    }).execute("x");
    const args = calls[0]?.args ?? [];
    const i = args.indexOf("--label");
    expect(args[i + 1]).toBe("theoclaw.session=s1");
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeLessThan(args.indexOf("img:1"));
  });

  it("rejects invalid labels at construction", () => {
    const bad = (labels: Record<string, string>) => () => new DockerSandbox({ labels });
    expect(bad({ "Bad Key": "x" })).toThrow(ConfigurationError);
    expect(bad({ "Bad Key": "x" })).toThrow(/Bad Key/);
    try {
      bad({ "Bad Key": "x" })();
    } catch (e) {
      expect((e as ConfigurationError).code).toBe("invalid_docker_label");
    }
    expect(bad({ ok: "a\nb" })).toThrow(/ok/);
    expect(bad({ ok: "a\rb" })).toThrow(ConfigurationError);
  });

  it("exports the default runner", () => {
    expect(typeof defaultDockerRunner()).toBe("function");
  });
});

describe("DockerSandbox.openTerminal (fake docker)", () => {
  it("keeps its container out of the keepLast set and builds argv with -d and --rm", async () => {
    vi.stubEnv("DOCKER_HOST", "unix:///nonexistent/docker.sock");
    const { calls, runner } = recorder();
    const sb = new DockerSandbox({ runner, user: "1:1", keepLast: { key: "k1" } });
    await expect(sb.openTerminal?.("sh", { cols: 80, rows: 24 })).rejects.toBeInstanceOf(Error);
    const run = calls[0]?.args ?? [];
    expect(run.slice(0, 3)).toEqual(["run", "--rm", "-d"]);
    expect(run.join(" ")).not.toContain("theokit.sandbox.keep");
    // the failed exec (no daemon socket) removes the container it created
    expect(calls.some((c) => c.args[0] === "rm" && c.args[1] === "-f")).toBe(true);
    // a later execute on the keepLast sandbox still labels its own container
    await sb.execute("true");
    expect(calls.some((c) => c.args.join(" ").includes("theokit.sandbox.keep=k1"))).toBe(true);
    vi.unstubAllEnvs();
  });

  it("removes the container and reports SandboxNotAvailableError when docker run fails", async () => {
    const { calls, runner } = recorder(125);
    const sb = new DockerSandbox({ runner });
    await expect(sb.openTerminal?.("sh", { cols: 1, rows: 1 })).rejects.toBeInstanceOf(
      SandboxNotAvailableError,
    );
    expect(calls.at(-1)?.args.slice(0, 2)).toEqual(["rm", "-f"]);
  });
});
