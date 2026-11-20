import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import type net from "node:net";
import { networkInterfaces } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  createSandboxBackend,
  LinuxSandbox,
  SandboxNotAvailableError,
} from "../../src/sandbox/index.js";

/** Why the live tests cannot run here, or `undefined` when bubblewrap and a proxy path work. */
function skipReason(): string | undefined {
  try {
    execFileSync("bwrap", ["--unshare-user", "--unshare-net", "--ro-bind", "/", "/", "/bin/true"], {
      stdio: "ignore",
      timeout: 2000,
    });
  } catch {
    return "bubblewrap with user+net namespaces is unavailable on this host";
  }
  try {
    execFileSync("curl", ["--version"], { stdio: "ignore" });
  } catch {
    return "curl is not installed";
  }
  return undefined;
}
const reason = skipReason();
if (reason) console.warn(`[skip] linux_sandbox_allowlist live tests: ${reason}`);
const live = it.skipIf(reason !== undefined);

const open: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
  for (const b of open.splice(0)) await b.dispose();
});

async function testServer(): Promise<{ port: number; close(): Promise<void> }> {
  const server = http.createServer((_req, res) => res.end("hello-from-test-host"));
  await new Promise<void>((r) => server.listen(0, "0.0.0.0", r));
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function sandbox(allow: { host: string; ports?: number[] }[]): LinuxSandbox {
  const bin = execFileSync("which", ["bwrap"], { encoding: "utf8" }).trim();
  const sb = new LinuxSandbox(
    { workDir: "/tmp" },
    { mode: "workspace-write", network: { allow }, bin },
  );
  open.push(sb);
  return sb;
}

describe("LinuxSandbox network allowlist", () => {
  it("linux_sandbox_allowlist_reports_policy", async () => {
    const sb = sandbox([{ host: "registry.npmjs.org" }, { host: "*.github.com" }]);
    expect(sb.networkPolicy).toEqual({
      mode: "allowlist",
      allow: ["registry.npmjs.org", "*.github.com"],
    });
    await sb.dispose();
    await sb.dispose(); // idempotent
  });

  it("allowlist_without_bwrap_refuses_to_run", () => {
    const detect = () => ({ ok: false as const, reason: "forced failure" });
    expect(() =>
      createSandboxBackend({ mode: "workspace-write", network: { allow: [] }, detect }),
    ).toThrow(SandboxNotAvailableError);
    expect(() =>
      createSandboxBackend({ mode: "danger-full-access", network: { allow: [] } }),
    ).toThrow(SandboxNotAvailableError);
  });

  it("dispose removes the socket directory and later commands fail closed", async () => {
    const sb = sandbox([{ host: "127.0.0.1" }]);
    const socket = /theokit-egress-[^/']+\/proxy\.sock/.exec(sb.wrapCommand("true") ?? "")?.[0];
    expect(socket).toBeDefined();
    await sb.dispose();
    expect(existsSync(`/tmp/${socket}`)).toBe(false);
    const r = await sb.execute("echo ran");
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).toBe("");
  });

  it("executeStreaming refuses to run after dispose and never calls back", async () => {
    const sb = sandbox([{ host: "127.0.0.1" }]);
    await sb.dispose();
    const lines: string[] = [];
    const r = await sb.executeStreaming("echo ran", { onStdoutLine: (l) => lines.push(l) });
    expect(r).toMatchObject({ stdout: "", exitCode: 1, timedOut: false });
    expect(r.stderr).toContain("sandbox disposed");
    expect(lines).toEqual([]);
  });

  live("linux_sandbox_allowlist_reaches_listed_host", async () => {
    const srv = await testServer();
    try {
      const sb = sandbox([{ host: "127.0.0.1", ports: [srv.port] }]);
      const ok = await sb.execute(`curl -sS --max-time 10 http://127.0.0.1:${srv.port}/`);
      expect(ok.stdout).toBe("hello-from-test-host");
      const https = await sb.execute(
        `curl -sS --max-time 10 -k -o /dev/null -w '%{http_code}' --proxytunnel https://127.0.0.1:${srv.port}/`,
      );
      expect(https.stderr).not.toContain("403"); // CONNECT was allowed (TLS to a plain server fails after)
      const refused = await sb.execute(`curl -sSf --max-time 10 http://127.0.0.2:${srv.port}/`);
      expect(refused.exitCode).not.toBe(0);
    } finally {
      await srv.close();
    }
  });

  live("linux_sandbox_allowlist_blocks_direct_socket", async () => {
    const srv = await testServer();
    try {
      const external = Object.values(networkInterfaces())
        .flat()
        .find((i) => i && !i.internal && i.family === "IPv4")?.address;
      const sb = sandbox([{ host: "127.0.0.1", ports: [srv.port] }]);
      for (const addr of [external, "127.0.0.1"].filter((a): a is string => !!a)) {
        const r = await sb.execute(
          `node -e 'const s=require("net").connect(${srv.port},"${addr}");s.on("connect",()=>{console.log("CONNECTED");process.exit(0)});s.on("error",e=>{console.log("FAILED "+e.code);process.exit(1)})'`,
        );
        expect(r.stdout).not.toContain("CONNECTED");
        expect(r.exitCode).not.toBe(0);
      }
    } finally {
      await srv.close();
    }
  });
});
