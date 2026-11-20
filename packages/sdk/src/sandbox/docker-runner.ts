/** The `docker` process seam shared by `DockerSandbox` and the container helpers. */

import { spawn } from "node:child_process";

/** Result of one `docker` invocation: captured output, exit code and whether it timed out. */
export interface DockerRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

/** Seam for tests: runs `docker <args>`, optionally feeding `input` to stdin. */
export type DockerRunner = (
  args: readonly string[],
  opts: { input?: string | Buffer; timeoutMs: number; maxOutputBytes: number },
) => Promise<DockerRunResult>;

/** The runner {@link DockerSandbox} uses by default; exported so a custom runner can wrap it. */
export function defaultDockerRunner(dockerBin = "docker"): DockerRunner {
  const bin = dockerBin;
  return (args, { input, timeoutMs, maxOutputBytes }) =>
    new Promise((resolve, reject) => {
      const child = spawn(bin, [...args], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const cap = (s: string, chunk: Buffer) =>
        s.length >= maxOutputBytes ? s : s + chunk.toString("utf-8");
      child.stdout.on("data", (c: Buffer) => {
        stdout = cap(stdout, c);
      });
      child.stderr.on("data", (c: Buffer) => {
        stderr = cap(stderr, c);
      });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code, timedOut });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    });
}
