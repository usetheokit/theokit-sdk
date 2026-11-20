import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import {
  assertSkillName,
  assertSkillVersion,
  compareSkillVersions,
  MAX_PACKAGE_BYTES,
  SkillsRegistryError,
  sha256Hex,
  verifySkillPackage,
} from "./package-format.js";

/** Options of `createSkillsRegistryHandler`. */
export interface SkillsRegistryServerOptions {
  /** Storage root, created at 0700. */
  dir: string;
  /** Publish token. Reads are open. */
  token: string;
  /** Largest accepted package body. Default and ceiling: `MAX_PACKAGE_BYTES` (1 MiB). */
  maxPackageBytes?: number;
  /** Called with a request handler failure. Default: one stderr line, token redacted. */
  onError?: (error: unknown, request: { method: string; path: string }) => void;
}

interface VersionMeta {
  version: string;
  sha256: string;
  size: number;
  description: string;
}

const PACKAGE_FILE = "package.json";
const META_FILE = "meta.json";

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const fail = (status: number, error: string, headers?: Record<string, string>): Response =>
  json(status, { error }, headers);

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

function tokenMatches(request: Request, token: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const given = /^Bearer (.*)$/i.exec(header)?.[1] ?? "";
  return timingSafeEqual(digest(given), digest(token));
}

class TooLarge extends Error {}

async function readChunks(body: ReadableStream<Uint8Array>, cap: number): Promise<Uint8Array[]> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      throw new TooLarge();
    }
    chunks.push(value);
  }
}

async function readBody(request: Request, cap: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) throw new TooLarge();
  return Buffer.concat(request.body ? await readChunks(request.body, cap) : []);
}

const isMissing = (e: unknown): boolean => (e as NodeJS.ErrnoException)?.code === "ENOENT";
const isTaken = (e: unknown): boolean =>
  ["EEXIST", "ENOTEMPTY", "EISDIR"].includes((e as NodeJS.ErrnoException)?.code ?? "");

async function readMeta(dir: string, name: string, version: string): Promise<VersionMeta | null> {
  try {
    const text = await fs.readFile(join(dir, name, version, META_FILE), "utf8");
    return JSON.parse(text) as VersionMeta;
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
}

async function listDir(path: string): Promise<string[]> {
  try {
    return (await fs.readdir(path)).filter((n) => !n.startsWith("."));
  } catch (e) {
    if (isMissing(e)) return [];
    throw e;
  }
}

async function readVersions(dir: string, name: string): Promise<VersionMeta[]> {
  const metas: VersionMeta[] = [];
  for (const v of await listDir(join(dir, name))) {
    const meta = await readMeta(dir, name, v);
    if (meta) metas.push(meta);
  }
  return metas.sort((a, b) => compareSkillVersions(a.version, b.version));
}

/** Stages the files in a private folder, then renames it into place: all or nothing. */
async function store(dir: string, name: string, bytes: Uint8Array, meta: VersionMeta) {
  const stage = join(dir, `.tmp-${randomUUID()}`);
  await fs.mkdir(stage, { mode: 0o700 });
  try {
    await fs.writeFile(join(stage, PACKAGE_FILE), bytes, { flag: "wx" });
    await fs.writeFile(join(stage, META_FILE), JSON.stringify(meta), { flag: "wx" });
    await fs.mkdir(join(dir, name), { recursive: true, mode: 0o700 });
    await fs.rename(stage, join(dir, name, meta.version));
  } catch (e) {
    await fs.rm(stage, { recursive: true, force: true });
    throw e;
  }
}

function describeOf(bytes: Uint8Array): string {
  const d = (JSON.parse(Buffer.from(bytes).toString("utf8")) as { description?: unknown })
    .description;
  return typeof d === "string" ? d : "";
}

type Opts = { dir: string; token: string; cap: number };

/** Returns the checked package bytes, or the error response. */
async function acceptBody(
  request: Request,
  cap: number,
  name: string,
  version: string,
): Promise<{ bytes: Uint8Array; description: string } | Response> {
  try {
    assertSkillName(name);
    assertSkillVersion(version);
    const bytes = await readBody(request, cap);
    verifySkillPackage(bytes, { name, version, sha256: sha256Hex(bytes) });
    return { bytes, description: describeOf(bytes) };
  } catch (e) {
    if (e instanceof TooLarge) return fail(413, `package exceeds ${cap} bytes`);
    if (e instanceof SkillsRegistryError) return fail(400, e.message);
    throw e;
  }
}

async function publish(
  request: Request,
  o: Opts,
  name: string,
  version: string,
): Promise<Response> {
  if (!tokenMatches(request, o.token)) {
    return fail(401, "invalid publish token", { "www-authenticate": "Bearer" });
  }
  const body = await acceptBody(request, o.cap, name, version);
  if (body instanceof Response) return body;
  const { bytes, description } = body;
  const sha256 = sha256Hex(bytes);
  await fs.mkdir(o.dir, { recursive: true, mode: 0o700 });
  const taken = (): Response => fail(409, `${name}@${version} already exists`);
  if (await readMeta(o.dir, name, version)) return taken();
  try {
    await store(o.dir, name, bytes, { version, sha256, size: bytes.byteLength, description });
  } catch (e) {
    if (isTaken(e)) return taken();
    throw e;
  }
  return json(201, { name, version, sha256 });
}

async function listing(dir: string, name: string): Promise<Response> {
  const metas = await readVersions(dir, name);
  const last = metas[metas.length - 1];
  if (!last) return fail(404, "skill not found");
  const versions = metas.map(({ version, sha256, size }) => ({ version, sha256, size }));
  return json(200, { name, description: last.description, versions });
}

async function packageBytes(dir: string, name: string, version: string): Promise<Response> {
  try {
    const bytes = await fs.readFile(join(dir, name, version, PACKAGE_FILE));
    return new Response(bytes, { status: 200, headers: { "content-type": "application/json" } });
  } catch (e) {
    if (isMissing(e)) return fail(404, "version not found");
    throw e;
  }
}

async function search(dir: string, term: string): Promise<Response> {
  const needle = term.toLowerCase();
  const skills = [];
  for (const name of (await listDir(dir)).sort()) {
    const metas = await readVersions(dir, name);
    const last = metas[metas.length - 1];
    if (!last) continue;
    if (!`${name}\n${last.description}`.toLowerCase().includes(needle)) continue;
    skills.push({
      name,
      description: last.description,
      latest: last.version,
      versions: metas.map((m) => m.version),
    });
  }
  return json(200, { skills });
}

function valid(check: () => void): boolean {
  try {
    check();
    return true;
  } catch {
    return false;
  }
}

async function read(dir: string, url: URL, parts: string[]): Promise<Response> {
  const [, , name, version, leaf] = parts;
  if (parts.length === 2) return search(dir, url.searchParams.get("q") ?? "");
  if (!name || !valid(() => assertSkillName(name))) return fail(404, "not found");
  if (parts.length === 3) return listing(dir, name);
  if (
    parts.length === 5 &&
    leaf === "package" &&
    version &&
    valid(() => assertSkillVersion(version))
  ) {
    return packageBytes(dir, name, version);
  }
  return fail(404, "not found");
}

async function route(
  request: Request,
  o: { dir: string; token: string; cap: number },
): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter((p) => p !== "");
  if (parts[0] !== "v1" || parts[1] !== "skills" || parts.length > 5) return fail(404, "not found");
  if (request.method === "PUT" && parts.length === 4) {
    return publish(request, o, parts[2] as string, parts[3] as string);
  }
  if (request.method === "GET" || request.method === "HEAD") return read(o.dir, url, parts);
  return fail(405, "method not allowed", { allow: "GET, HEAD, PUT" });
}

function defaultOnError(token: string) {
  return (error: unknown, request: { method: string; path: string }): void => {
    const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
    const clean = token === "" ? text : text.split(token).join("[redacted]");
    process.stderr.write(`skills-registry: ${request.method} ${request.path} failed: ${clean}\n`);
  };
}

/**
 * A fetch-style handler for a skills registry that stores immutable versions on disk.
 * It binds nowhere: mount it in any server. The token protects publish only; reads are open.
 * `maxPackageBytes` can only lower the 1 MiB package ceiling.
 */
export function createSkillsRegistryHandler(
  options: SkillsRegistryServerOptions,
): (request: Request) => Promise<Response> {
  const o = {
    dir: options.dir,
    token: options.token,
    cap: Math.min(options.maxPackageBytes ?? MAX_PACKAGE_BYTES, MAX_PACKAGE_BYTES),
  };
  const onError = options.onError ?? defaultOnError(options.token);
  return async (request) => {
    try {
      return await route(request, o);
    } catch (error) {
      const path = new URL(request.url).pathname;
      try {
        onError(error, { method: request.method, path });
      } catch {
        // a failing logger must not turn into a second failure
      }
      return fail(500, "internal error");
    }
  };
}
