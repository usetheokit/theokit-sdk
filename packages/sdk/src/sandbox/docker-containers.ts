/**
 * Helpers for the containers a {@link DockerSandbox} leaves behind: list them by label, remove them,
 * and (internally) tidy earlier containers of a `keepLast` key.
 *
 * @public
 */

import { TheokitAgentError } from "../errors.js";
import { type DockerRunner, defaultDockerRunner } from "./docker-sandbox.js";

/** Label `keepLast` puts on a container; its value is the key. */
export const KEEP_LABEL = "theokit.sandbox.keep";

const DOCKER_TIMEOUT_MS = 30_000;
const DOCKER_MAX_OUTPUT = 5 * 1024 * 1024;

/** A container started by a `DockerSandbox`, as `docker ps -a` reports it. */
export interface SandboxContainer {
  id: string;
  name: string;
  state: string;
  image: string;
  labels: Record<string, string>;
}

/** A `docker` subcommand failed or timed out. */
export class SandboxDockerError extends TheokitAgentError {
  override readonly name = "SandboxDockerError";
  override readonly code = "sandbox_docker_error" as const;
  readonly subcommand: string;
  readonly exitCode: number | null;
  readonly stderr: string;
  constructor(subcommand: string, exitCode: number | null, stderr: string, timedOut = false) {
    const how = timedOut ? "timed out" : `failed with exit code ${exitCode}`;
    super(`docker ${subcommand} ${how}: ${stderr.trim() || "no stderr"}`, {
      code: "sandbox_docker_error",
      isRetryable: false,
    });
    this.subcommand = subcommand;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

async function docker(runner: DockerRunner, args: string[]): Promise<string> {
  const sub = args[0] ?? "";
  let r: Awaited<ReturnType<DockerRunner>>;
  try {
    r = await runner(args, { timeoutMs: DOCKER_TIMEOUT_MS, maxOutputBytes: DOCKER_MAX_OUTPUT });
  } catch (e) {
    throw new SandboxDockerError(sub, null, e instanceof Error ? e.message : String(e));
  }
  if (r.timedOut || r.code !== 0) throw new SandboxDockerError(sub, r.code, r.stderr, r.timedOut);
  return r.stdout;
}

const FORMAT = "{{.ID}}\t{{.Names}}\t{{.State}}\t{{.Image}}\t{{.Labels}}";

/** Parses docker's `k=v,k2=v2` label rendering; a piece without `=` continues the previous value. */
function parseLabels(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  let last: string | undefined;
  for (const piece of raw.split(",")) {
    const eq = piece.indexOf("=");
    if (eq > 0 && /^[a-z0-9][a-z0-9._-]*$/i.test(piece.slice(0, eq))) {
      last = piece.slice(0, eq);
      out[last] = piece.slice(eq + 1);
    } else if (last !== undefined) {
      out[last] += `,${piece}`;
    }
  }
  return out;
}

function parseContainers(stdout: string): SandboxContainer[] {
  return stdout
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((line) => {
      const [id = "", name = "", state = "", image = "", labels = ""] = line.split("\t");
      return { id, name, state, image, labels: parseLabels(labels) };
    });
}

/** Lists containers (running or not) that carry every one of `labels`. */
export async function listSandboxContainers(
  labels: Record<string, string>,
  options: { runner?: DockerRunner } = {},
): Promise<SandboxContainer[]> {
  const runner = options.runner ?? defaultDockerRunner();
  const filters = Object.entries(labels).flatMap(([k, v]) => ["--filter", `label=${k}=${v}`]);
  return parseContainers(await docker(runner, ["ps", "-a", ...filters, "--format", FORMAT]));
}

/**
 * Removes containers carrying every one of `labels`. A running container is left alone unless
 * `includeRunning` is true; the ones left are returned in `skippedRunning`.
 */
export async function removeSandboxContainers(
  labels: Record<string, string>,
  options: { runner?: DockerRunner; includeRunning?: boolean } = {},
): Promise<{ removed: SandboxContainer[]; skippedRunning: SandboxContainer[] }> {
  const runner = options.runner ?? defaultDockerRunner();
  const all = await listSandboxContainers(labels, { runner });
  const running = all.filter((c) => c.state === "running");
  const stopped = all.filter((c) => c.state !== "running");
  if (stopped.length > 0) await docker(runner, ["rm", ...stopped.map((c) => c.id)]);
  if (options.includeRunning && running.length > 0) {
    await docker(runner, ["rm", "-f", ...running.map((c) => c.id)]);
  }
  return options.includeRunning
    ? { removed: [...stopped, ...running], skippedRunning: [] }
    : { removed: stopped, skippedRunning: running };
}

/** Removes exited containers of `key` other than `exceptName`; used by `keepLast`. */
export async function removeEarlierKept(
  runner: DockerRunner,
  key: string,
  exceptName: string,
): Promise<void> {
  const all = await listSandboxContainers({ [KEEP_LABEL]: key }, { runner });
  const old = all.filter((c) => c.name !== exceptName && c.state !== "running");
  if (old.length > 0) await docker(runner, ["rm", ...old.map((c) => c.id)]);
}
