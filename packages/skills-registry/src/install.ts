import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  assertSkillName,
  assertSkillVersion,
  assertValidPackageContent,
  compareSkillVersions,
  isPrerelease,
  MAX_PACKAGE_BYTES,
  ORIGIN_FILE,
  SkillsRegistryError,
  type VerifiedSkillPackage,
  verifySkillPackage,
} from "./package-format.js";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const DEFAULT_TIMEOUT_MS = 30_000;

function assertRegistryUrl(registryUrl: string): URL {
  let url: URL;
  try {
    url = new URL(registryUrl);
  } catch (cause) {
    throw new SkillsRegistryError("insecure_url", `invalid registry URL: ${registryUrl}`, {
      cause,
    });
  }
  const ok =
    url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname));
  if (!ok) {
    throw new SkillsRegistryError(
      "insecure_url",
      "registry URL must be https:, or http: on localhost only",
    );
  }
  return url;
}

async function readCapped(res: Response, cap: number): Promise<Uint8Array> {
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
    total += value.length;
    if (total > cap) {
      await reader.cancel();
      throw new SkillsRegistryError("too_large", `response exceeds ${cap} bytes`);
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function get(
  doFetch: typeof fetch,
  url: string,
  timeoutMs: number,
  cap: number,
  what: string,
): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await doFetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  } catch (cause) {
    throw new SkillsRegistryError("unreachable", `cannot reach registry for ${what}`, { cause });
  }
  if (res.status === 404) {
    await res.body?.cancel();
    throw new SkillsRegistryError("not_found", `${what} not found`);
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new SkillsRegistryError("unreachable", `registry answered ${res.status} for ${what}`);
  }
  try {
    return await readCapped(res, cap);
  } catch (cause) {
    if (cause instanceof SkillsRegistryError) throw cause;
    throw new SkillsRegistryError("unreachable", `registry connection failed for ${what}`, {
      cause,
    });
  }
}

interface ListedVersion {
  version: string;
  sha256: string;
}

function parseListing(bytes: Uint8Array, name: string): ListedVersion[] {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch (cause) {
    throw new SkillsRegistryError("unreachable", "registry listing is not valid JSON", { cause });
  }
  const versions = (raw as { versions?: unknown } | null)?.versions;
  if (!Array.isArray(versions)) {
    throw new SkillsRegistryError("unreachable", "registry listing has no versions array");
  }
  const out: ListedVersion[] = [];
  for (const v of versions) {
    if (v && typeof v.version === "string" && typeof v.sha256 === "string") {
      assertSkillVersion(v.version);
      out.push({ version: v.version, sha256: v.sha256 });
    }
  }
  if (out.length === 0) throw new SkillsRegistryError("not_found", `${name} has no versions`);
  return out;
}

function parseSpec(spec: string): { name: string; version?: string } {
  const at = spec.indexOf("@");
  const name = at < 0 ? spec : spec.slice(0, at);
  assertSkillName(name);
  if (at < 0) return { name };
  const version = spec.slice(at + 1);
  assertSkillVersion(version);
  return { name, version };
}

/** Highest stable release; falls back to the highest prerelease when only prereleases exist. */
function pickVersion(listed: ListedVersion[], name: string, wanted?: string): ListedVersion {
  if (wanted) {
    const hit = listed.find((v) => v.version === wanted);
    if (!hit) throw new SkillsRegistryError("not_found", `${name}@${wanted} not found`);
    return hit;
  }
  const stable = listed.filter((v) => !isPrerelease(v.version));
  const pool = stable.length > 0 ? stable : listed;
  return pool.reduce((best, v) => (compareSkillVersions(v.version, best.version) > 0 ? v : best));
}

export async function downloadSkill(
  registryUrl: string,
  spec: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<VerifiedSkillPackage> {
  const base = assertRegistryUrl(registryUrl).href.replace(/\/+$/, "");
  const { name, version } = parseSpec(spec);
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const listing = await get(
    doFetch,
    `${base}/v1/skills/${name}`,
    timeoutMs,
    MAX_PACKAGE_BYTES,
    name,
  );
  const chosen = pickVersion(parseListing(listing, name), name, version);
  const body = await get(
    doFetch,
    `${base}/v1/skills/${name}/${encodeURIComponent(chosen.version)}/package`,
    timeoutMs,
    MAX_PACKAGE_BYTES,
    `${name}@${chosen.version}`,
  );
  return verifySkillPackage(body, { name, version: chosen.version, sha256: chosen.sha256 });
}

async function writeStaged(
  stage: string,
  pkg: VerifiedSkillPackage,
  registry: string,
): Promise<void> {
  const root = resolve(stage);
  for (const f of pkg.files) {
    const target = resolve(root, f.path);
    const rel = relative(root, target);
    if (rel === "" || rel.startsWith("..") || rel.split(sep).includes("..")) {
      throw new SkillsRegistryError("unsafe_path", `path escapes the skill folder: ${f.path}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, f.bytes);
  }
  const origin = { registry, name: pkg.name, version: pkg.version, sha256: pkg.sha256 };
  await writeFile(join(root, ORIGIN_FILE), `${JSON.stringify(origin, null, 2)}\n`);
}

async function swapIn(stage: string, target: string, backup: string): Promise<void> {
  let movedAside = false;
  try {
    try {
      await rename(target, backup);
      movedAside = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    await rename(stage, target);
  } catch (cause) {
    if (movedAside) await rename(backup, target).catch(() => undefined);
    throw new SkillsRegistryError("install_failed", "could not replace the installed skill", {
      cause,
    });
  }
  await rm(backup, { recursive: true, force: true });
}

export async function installSkill(
  skillsDir: string,
  pkg: VerifiedSkillPackage,
  origin: { registry: string },
): Promise<{ dir: string }> {
  assertValidPackageContent(pkg);
  assertRegistryUrl(origin.registry);
  const root = resolve(skillsDir);
  const dir = join(root, pkg.name);
  const suffix = randomBytes(6).toString("hex");
  const stage = join(root, `.${pkg.name}.staging-${suffix}`);
  const backup = join(root, `.${pkg.name}.backup-${suffix}`);
  await mkdir(root, { recursive: true });
  try {
    await mkdir(stage);
    await writeStaged(stage, pkg, origin.registry);
    await swapIn(stage, dir, backup);
  } catch (err) {
    await rm(stage, { recursive: true, force: true });
    throw err;
  }
  return { dir };
}
