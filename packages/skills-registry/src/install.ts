import * as fs from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  assertSkillName,
  assertSkillVersion,
  checkFileSet,
  checkSkillMd,
  checkSkillPath,
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
const MAX_LISTING_BYTES = 1024 * 1024;

export interface DownloadOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

function parseRegistryUrl(registryUrl: string): URL {
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
      "registry URL must be https:, or http: for localhost only",
    );
  }
  return url;
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
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      throw new SkillsRegistryError("too_large", `response exceeds ${cap} bytes`);
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function get(url: string, cap: number, opts: DownloadOptions): Promise<Uint8Array> {
  const doFetch = opts.fetch ?? fetch;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await doFetch(url, { redirect: "manual", signal });
    if (res.status === 404) throw new SkillsRegistryError("not_found", `not found: ${url}`);
    if (!res.ok)
      throw new SkillsRegistryError("unreachable", `registry answered ${res.status} for ${url}`);
    return await readCapped(res, cap);
  } catch (cause) {
    if (cause instanceof SkillsRegistryError) throw cause;
    throw new SkillsRegistryError("unreachable", `registry unreachable: ${url}`, { cause });
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
  const list = (raw as { versions?: unknown } | null)?.versions;
  if (!Array.isArray(list))
    throw new SkillsRegistryError("unreachable", "registry listing has no versions");
  const out: ListedVersion[] = [];
  for (const e of list as { version?: unknown; sha256?: unknown }[]) {
    assertSkillVersion(e?.version);
    if (typeof e.sha256 !== "string") {
      throw new SkillsRegistryError("unreachable", `listing for ${name} lacks a sha256`);
    }
    out.push({ version: e.version, sha256: e.sha256 });
  }
  return out;
}

/** The highest stable release; a prerelease only when no stable release exists. */
function pickLatest(list: ListedVersion[]): ListedVersion | undefined {
  const stable = list.filter((e) => !isPrerelease(e.version));
  const pool = stable.length > 0 ? stable : list;
  return pool.reduce<ListedVersion | undefined>(
    (best, e) =>
      best === undefined || compareSkillVersions(e.version, best.version) > 0 ? e : best,
    undefined,
  );
}

/** Downloads `name` or `name@version` from a registry and verifies it. Writes nothing. */
export async function downloadSkill(
  registryUrl: string,
  spec: string,
  options: DownloadOptions = {},
): Promise<VerifiedSkillPackage> {
  const base = parseRegistryUrl(registryUrl);
  const { name, version } = parseSpec(spec);
  const root = `${base.origin}${base.pathname.replace(/\/+$/, "")}/v1/skills/${name}`;
  const list = parseListing(await get(root, MAX_LISTING_BYTES, options), name);
  const chosen = version === undefined ? pickLatest(list) : list.find((e) => e.version === version);
  if (!chosen) {
    throw new SkillsRegistryError(
      "not_found",
      `no matching version of ${name}${version ? `@${version}` : ""}`,
    );
  }
  const bytes = await get(`${root}/${chosen.version}/package`, MAX_PACKAGE_BYTES, options);
  return verifySkillPackage(bytes, { name, version: chosen.version, sha256: chosen.sha256 });
}

function revalidate(pkg: VerifiedSkillPackage): void {
  assertSkillName(pkg.name);
  assertSkillVersion(pkg.version);
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    throw new SkillsRegistryError("invalid_package", "package has no files");
  }
  for (const f of pkg.files) checkSkillPath(f.path);
  checkFileSet(pkg.files.map((f) => f.path));
  checkSkillMd(pkg.files, pkg.name);
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function writeStaged(
  stage: string,
  pkg: VerifiedSkillPackage,
  registry: string,
): Promise<void> {
  for (const f of pkg.files) {
    const target = resolve(stage, f.path);
    if (!inside(stage, target)) {
      throw new SkillsRegistryError(
        "unsafe_path",
        `unsafe package path: ${JSON.stringify(f.path)}`,
      );
    }
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.writeFile(target, f.bytes, { flag: "wx" });
  }
  const origin = { registry, name: pkg.name, version: pkg.version, sha256: pkg.sha256 };
  await fs.writeFile(join(stage, ORIGIN_FILE), `${JSON.stringify(origin, null, 2)}\n`, {
    flag: "wx",
  });
}

async function exists(path: string): Promise<boolean> {
  return fs.lstat(path).then(
    () => true,
    () => false,
  );
}

async function swap(stage: string, finalDir: string, backup: string): Promise<void> {
  const hadPrevious = await exists(finalDir);
  if (hadPrevious) await fs.rename(finalDir, backup);
  try {
    await fs.rename(stage, finalDir);
  } catch (cause) {
    if (hadPrevious) await fs.rename(backup, finalDir);
    throw new SkillsRegistryError("install_failed", "could not move the skill into place", {
      cause,
    });
  }
  if (hadPrevious) await fs.rm(backup, { recursive: true, force: true });
}

/**
 * Installs a verified package at `<skillsDir>/<name>`. Files go to a temporary sibling first;
 * the previous version is restored if the final swap fails.
 */
export async function installSkill(
  skillsDir: string,
  pkg: VerifiedSkillPackage,
  origin: { registry: string },
): Promise<{ dir: string }> {
  revalidate(pkg);
  const root = resolve(skillsDir);
  await fs.mkdir(root, { recursive: true });
  const finalDir = join(root, pkg.name);
  const work = await fs.mkdtemp(join(root, `.install-${pkg.name}-`));
  try {
    const stage = join(work, "new");
    await fs.mkdir(stage);
    await writeStaged(stage, pkg, origin.registry);
    await swap(stage, finalDir, join(work, "previous"));
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
  return { dir: finalDir };
}
