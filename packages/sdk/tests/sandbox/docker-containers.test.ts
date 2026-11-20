import { describe, expect, it } from "vitest";
import { setDiagnosticsSink } from "../../src/internal/diagnostics.js";
import {
  listSandboxContainers,
  removeSandboxContainers,
  SandboxDockerError,
} from "../../src/sandbox/docker-containers.js";
import { type DockerRunner, DockerSandbox } from "../../src/sandbox/docker-sandbox.js";

const PS =
  "aaa\tn1\texited\talpine:3\tapp=x,theokit.sandbox.keep=s1\nbbb\tn2\trunning\talpine:3\tapp=x\n";

function fake(handlers: Record<string, { stdout?: string; stderr?: string; code?: number }>) {
  const calls: string[][] = [];
  const runner: DockerRunner = async (args) => {
    calls.push([...args]);
    const h = handlers[args[0] ?? ""] ?? {};
    return { stdout: h.stdout ?? "", stderr: h.stderr ?? "", code: h.code ?? 0, timedOut: false };
  };
  return { calls, runner };
}

describe("sandbox containers", () => {
  it("lists two containers with labels", async () => {
    const { runner } = fake({ ps: { stdout: PS } });
    const r = await listSandboxContainers({ app: "x" }, { runner });
    expect(r).toEqual([
      {
        id: "aaa",
        name: "n1",
        state: "exited",
        image: "alpine:3",
        labels: { app: "x", "theokit.sandbox.keep": "s1" },
      },
      { id: "bbb", name: "n2", state: "running", image: "alpine:3", labels: { app: "x" } },
    ]);
  });

  it("skips running containers by default, removes them with includeRunning", async () => {
    const a = fake({ ps: { stdout: PS } });
    const r = await removeSandboxContainers({ app: "x" }, { runner: a.runner });
    expect(r.skippedRunning.map((c) => c.id)).toEqual(["bbb"]);
    expect(a.calls.filter((c) => c[0] === "rm")).toEqual([["rm", "aaa"]]);
    const b = fake({ ps: { stdout: PS } });
    const r2 = await removeSandboxContainers(
      { app: "x" },
      { runner: b.runner, includeRunning: true },
    );
    expect(r2.skippedRunning).toEqual([]);
    expect(b.calls).toContainEqual(["rm", "-f", "bbb"]);
  });

  it("refuses an empty label set before running any docker command", async () => {
    const { calls, runner } = fake({ ps: { stdout: PS } });
    await expect(listSandboxContainers({}, { runner })).rejects.toThrow(/label/);
    await expect(removeSandboxContainers({}, { runner, includeRunning: true })).rejects.toThrow(
      /label/,
    );
    expect(calls).toEqual([]);
  });

  it("rejects with SandboxDockerError on a timeout", async () => {
    const runner: DockerRunner = async () => ({
      stdout: "",
      stderr: "",
      code: null,
      timedOut: true,
    });
    const e = await listSandboxContainers({ app: "x" }, { runner }).catch((x) => x);
    expect(e).toBeInstanceOf(SandboxDockerError);
    expect(e.message).toContain("timed out");
  });

  it("keeps a comma inside a label value when the next piece is not a key=value", async () => {
    const { runner } = fake({ ps: { stdout: "a\tn\texited\ti\tapp=x,note=a,b=c\n" } });
    const [c] = await listSandboxContainers({ app: "x" }, { runner });
    // Documented limit: docker's rendering cannot tell `,b=c` from a second label.
    expect(c?.labels).toEqual({ app: "x", note: "a", b: "c" });
  });

  it("rejects with SandboxDockerError naming ps and stderr", async () => {
    const { runner } = fake({ ps: { code: 1, stderr: "daemon down" } });
    const e = await listSandboxContainers({ app: "x" }, { runner }).catch((x) => x);
    expect(e).toBeInstanceOf(SandboxDockerError);
    expect(e.message).toContain("ps");
    expect(e.message).toContain("daemon down");
  });
});

describe("keepLast", () => {
  it("runs without --rm, labels the key and removes the earlier container", async () => {
    const { calls, runner } = fake({ ps: { stdout: "aaa\tn1\texited\talpine:3\t\n" } });
    const sb = new DockerSandbox({ workDir: "/w", runner, user: "1:1", keepLast: { key: "s1" } });
    await sb.execute("echo");
    const run = calls.find((c) => c[0] === "run") ?? [];
    expect(run).not.toContain("--rm");
    expect(run).toContain("theokit.sandbox.keep=s1");
    expect(calls).toContainEqual(["rm", "aaa"]);
  });

  it("never removes the current container or a running one", async () => {
    const calls: string[][] = [];
    let current = "";
    const runner: DockerRunner = async (args) => {
      calls.push([...args]);
      if (args[0] === "run") current = args[args.indexOf("--name") + 1] ?? "";
      const stdout =
        args[0] === "ps"
          ? `cur\t${current}\texited\ti\t\nold\tn1\texited\ti\t\nrun\tn2\trunning\ti\t\n`
          : "";
      return { stdout, stderr: "", code: 0, timedOut: false };
    };
    await new DockerSandbox({ workDir: "/w", runner, keepLast: { key: "s1" } }).execute("echo");
    expect(calls.filter((c) => c[0] === "rm")).toEqual([["rm", "old"]]);
  });

  it("rejects the reserved keepLast label and an empty key", () => {
    const runner = fake({}).runner;
    expect(
      () =>
        new DockerSandbox({
          runner,
          labels: { "theokit.sandbox.keep": "z" },
          keepLast: { key: "a" },
        }),
    ).toThrow(/reserved/);
    expect(() => new DockerSandbox({ runner, keepLast: { key: "" } })).toThrow(/keepLast/);
  });

  it("reports a failed cleanup on diagnostics and still returns the result", async () => {
    const { runner } = fake({ ps: { code: 1, stderr: "boom" } });
    const seen: string[] = [];
    setDiagnosticsSink((m) => seen.push(m));
    try {
      const sb = new DockerSandbox({ workDir: "/w", runner, keepLast: { key: "s1" } });
      const r = await sb.execute("echo");
      expect(r.exitCode).toBe(0);
      expect(seen.join("")).toContain("boom");
    } finally {
      setDiagnosticsSink(undefined);
    }
  });
});
