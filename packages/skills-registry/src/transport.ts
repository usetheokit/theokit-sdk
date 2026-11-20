import { SkillsRegistryError } from "./package-format.js";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Parses a registry base URL: `https:`, or `http:` for loopback only. Throws `insecure_url`. */
export function parseRegistryUrl(registryUrl: string): URL {
  let url: URL;
  try {
    url = new URL(registryUrl);
  } catch (cause) {
    throw new SkillsRegistryError("insecure_url", "invalid registry URL", { cause });
  }
  const ok =
    url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname));
  if (!ok) {
    throw new SkillsRegistryError(
      "insecure_url",
      "registry URL must be https:, or http: for localhost only",
    );
  }
  return url;
}

/** `<origin><path without trailing slash>/v1/skills` of a registry base URL. */
export function skillsRoot(base: URL): string {
  return `${base.origin}${base.pathname.replace(/\/+$/, "")}/v1/skills`;
}

/**
 * Runs `run` with a deadline. The deadline holds even when `fetch` ignores the abort signal.
 * Any failure that is not a `SkillsRegistryError` becomes `unreachable` with a fixed message.
 */
export async function withDeadline<T>(
  timeoutMs: number,
  what: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new SkillsRegistryError("unreachable", `${what} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(ctrl.signal), timeout]);
  } catch (cause) {
    if (cause instanceof SkillsRegistryError) throw cause;
    throw new SkillsRegistryError("unreachable", `${what} failed`, { cause });
  } finally {
    clearTimeout(timer);
  }
}

/** Reads a response body, refusing more than `cap` bytes. Throws `too_large`. */
export async function readCapped(res: Response, cap: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) {
    await res.body?.cancel();
    throw new SkillsRegistryError("too_large", `response exceeds ${cap} bytes`);
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      throw new SkillsRegistryError("too_large", `response exceeds ${cap} bytes`);
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
