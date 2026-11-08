import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type DockerRunner, DockerSandbox } from "../../src/sandbox/docker-sandbox.js";
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
  },
);
