import * as fs from "node:fs/promises";
import { join } from "node:path";
import {
  assertSkillName,
  assertSkillVersion,
  checkFileSet,
  checkSkillPath,
  MAX_PACKAGE_BYTES,
  parseSkillIdentity,
  type SkillPackage,
  SkillsRegistryError,
} from "./package-format.js";
import { parseRegistryUrl, readCapped, skillsRoot, withDeadline } from "./transport.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ERROR_BYTES = 64 * 1024;

async function readFile(
  full: string,
  rel: string,
  budget: { left: number },
): Promise<{ path: string; bytes: Buffer }> {
  checkSkillPath(rel);
  const bytes = await fs.readFile(full);
  budget.left -= bytes.byteLength;
  if (budget.left < 0) throw tooLarge();
  return { path: rel, bytes };
}

async function walk(
  dir: string,
  prefix: string,
  out: { path: string; bytes: Buffer }[],
  budget: { left: number },
): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = prefix === "" ? e.name : `${prefix}/${e.name}`;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      await walk(full, rel, out, budget);
    } else if (e.isFile()) {
      out.push(await readFile(full, rel, budget));
    } else {
      throw new SkillsRegistryError(
        "unsafe_path",
        `not a regular file or directory (symbolic link or special file): ${rel}`,
      );
    }
  }
}

function tooLarge(): SkillsRegistryError {
  return new SkillsRegistryError("too_large", `skill folder exceeds ${MAX_PACKAGE_BYTES} bytes`);
}

/**
 * Reads a skill folder into the package format. Refuses symbolic links and anything but regular
 * files, a folder over 1 MiB, a missing `SKILL.md`, and frontmatter without a valid
 * `name`, `description` and `version`.
 */
export async function buildSkillPackage(dir: string): Promise<SkillPackage> {
  const files: { path: string; bytes: Buffer }[] = [];
  await walk(dir, "", files, { left: MAX_PACKAGE_BYTES });
  checkFileSet(files.map((f) => f.path));
  const md = files.find((f) => f.path === "SKILL.md");
  if (!md) throw new SkillsRegistryError("invalid_skill_md", "folder has no SKILL.md");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(md.bytes);
  } catch {
    throw new SkillsRegistryError("invalid_skill_md", "SKILL.md is not valid UTF-8");
  }
  const { name, description, version } = parseSkillIdentity(text);
  assertSkillName(name);
  const pkg: SkillPackage = {
    name,
    version,
    description,
    files: files.map((f) => ({ path: f.path, contentBase64: f.bytes.toString("base64") })),
  };
  if (Buffer.byteLength(JSON.stringify(pkg)) > MAX_PACKAGE_BYTES) throw tooLarge();
  return pkg;
}

async function serverError(res: Response, token: string): Promise<string> {
  try {
    const raw: unknown = JSON.parse(
      new TextDecoder().decode(await readCapped(res, MAX_ERROR_BYTES)),
    );
    const text = (raw as { error?: unknown } | null)?.error;
    if (typeof text === "string" && text !== "") return text.split(token).join("[redacted]");
  } catch {
    // fall through to the generic text
  }
  return "the registry rejected the package";
}

async function mapStatus(res: Response, pkg: SkillPackage, token: string): Promise<void> {
  if (res.status === 201) return;
  const id = `${pkg.name}@${pkg.version}`;
  if (res.status === 409) {
    throw new SkillsRegistryError("version_exists", `${id} is already published`);
  }
  if (res.status === 401) {
    throw new SkillsRegistryError("unauthorized", "the registry refused the publish token");
  }
  if (res.status === 400) {
    throw new SkillsRegistryError("rejected", await serverError(res, token));
  }
  throw new SkillsRegistryError("unreachable", `registry answered ${res.status} to publish`);
}

/**
 * Publishes a package: `PUT <registry>/v1/skills/<name>/<version>` with a bearer token.
 * The registry URL follows the install guard (https, or http on loopback). Default timeout 30 s.
 * A 201 resolves; 409 is `version_exists`, 401 `unauthorized`, 400 `rejected`. The token never
 * appears in an error message.
 */
export async function publishSkill(
  registryUrl: string,
  pkg: SkillPackage,
  options: { token: string; fetch?: typeof fetch; timeoutMs?: number },
): Promise<{ name: string; version: string }> {
  const base = parseRegistryUrl(registryUrl);
  assertSkillName(pkg.name);
  assertSkillVersion(pkg.version);
  const body = JSON.stringify(pkg);
  if (Buffer.byteLength(body) > MAX_PACKAGE_BYTES) throw tooLarge();
  const { token } = options;
  if (typeof token !== "string" || token === "") {
    throw new SkillsRegistryError("unauthorized", "a publish token is required");
  }
  const doFetch = options.fetch ?? fetch;
  const url = `${skillsRoot(base)}/${pkg.name}/${pkg.version}`;
  await withDeadline(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    "registry publish",
    async (signal) => {
      const res = await doFetch(url, {
        method: "PUT",
        redirect: "manual",
        signal,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body,
      });
      await mapStatus(res, pkg, token);
    },
  );
  return { name: pkg.name, version: pkg.version };
}
