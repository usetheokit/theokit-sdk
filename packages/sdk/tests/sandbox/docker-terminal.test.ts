import { describe, expect, it } from "vitest";
import { dockerEndpoint, openDockerTerminal } from "../../src/sandbox/docker-terminal.js";

describe("dockerEndpoint", () => {
  it("defaults to the unix socket", () => {
    expect(dockerEndpoint({})).toEqual({ socketPath: "/var/run/docker.sock" });
  });
  it("reads unix:// and tcp://", () => {
    expect(dockerEndpoint({ DOCKER_HOST: "unix:///x.sock" })).toEqual({ socketPath: "/x.sock" });
    expect(dockerEndpoint({ DOCKER_HOST: "tcp://h:2376" })).toEqual({ host: "h", port: 2376 });
  });
  it("rejects ssh", () => {
    expect(() => dockerEndpoint({ DOCKER_HOST: "ssh://h" })).toThrow(/unsupported/);
  });
});

describe("openDockerTerminal", () => {
  it("rejects when the daemon is unreachable", async () => {
    await expect(
      openDockerTerminal({
        endpoint: { socketPath: "/nonexistent/docker.sock" },
        container: "c",
        command: "sh",
        cols: 80,
        rows: 24,
        onEnd: async () => undefined,
      }),
    ).rejects.toThrow(/ENOENT/);
  });
});
