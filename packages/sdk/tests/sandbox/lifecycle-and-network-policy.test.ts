import { describe, expect, it, vi } from "vitest";

import {
  type ExecuteResult,
  LinuxSandbox,
  LocalSandbox,
  SandboxBackend,
  type SandboxNetworkPolicy,
} from "../../src/sandbox/index.js";

const OK: ExecuteResult = { stdout: "", stderr: "", exitCode: 0, timedOut: false };

class PlainBackend extends SandboxBackend {
  async execute(): Promise<ExecuteResult> {
    return OK;
  }
  async uploadFile(): Promise<void> {}
}

class VmBackend extends PlainBackend {
  override readonly networkPolicy: SandboxNetworkPolicy = {
    mode: "allowlist",
    allow: ["github.com", "registry.npmjs.org"],
  };
  readonly stop = vi.fn();
  override async dispose(): Promise<void> {
    this.stop();
  }
}

describe("SandboxBackend.dispose", () => {
  it("is a no-op a subclass inherits, and is safe to call twice", async () => {
    const backend = new PlainBackend();

    await expect(backend.dispose()).resolves.toBeUndefined();
    await expect(backend.dispose()).resolves.toBeUndefined();
  });

  it("calls the override of a subclass that holds something", async () => {
    const backend = new VmBackend();

    await backend.dispose();

    expect(backend.stop).toHaveBeenCalledTimes(1);
  });

  it("is inherited by the shipped backends", async () => {
    await expect(new LocalSandbox().dispose()).resolves.toBeUndefined();
  });
});

describe("SandboxBackend.networkPolicy", () => {
  it("states nothing by default", () => {
    const backend: SandboxBackend = new PlainBackend();

    expect(backend.networkPolicy).toBeUndefined();
  });

  it("is readable and typed on a backend that states its egress", () => {
    const backend: SandboxBackend = new VmBackend();

    const policy: SandboxNetworkPolicy | undefined = backend.networkPolicy;

    expect(policy?.mode).toBe("allowlist");
    expect(policy?.allow).toEqual(["github.com", "registry.npmjs.org"]);
  });

  it("is unrestricted for LocalSandbox, which runs on the host", () => {
    expect(new LocalSandbox().networkPolicy).toEqual({ mode: "unrestricted" });
  });
});

describe("LinuxSandbox.networkPolicy matches the argv it builds", () => {
  const wrap = (opts: ConstructorParameters<typeof LinuxSandbox>[1]) => {
    const sandbox = new LinuxSandbox({ workDir: "/tmp" }, { bin: "/usr/bin/bwrap", ...opts });
    return { policy: sandbox.networkPolicy, wrapped: sandbox.wrapCommand("true") };
  };

  it("is none when the network is unshared (the default)", () => {
    const { policy, wrapped } = wrap({ mode: "workspace-write" });

    expect(policy).toEqual({ mode: "none" });
    expect(wrapped).toContain("--unshare-net");
  });

  it("is unrestricted when the caller keeps the network", () => {
    const { policy, wrapped } = wrap({ mode: "read-only", network: true });

    expect(policy).toEqual({ mode: "unrestricted" });
    expect(wrapped).not.toContain("--unshare-net");
  });

  it("is unrestricted under danger-full-access, where nothing is wrapped", () => {
    const { policy, wrapped } = wrap({ mode: "danger-full-access" });

    expect(policy).toEqual({ mode: "unrestricted" });
    expect(wrapped).toBeNull();
  });
});
