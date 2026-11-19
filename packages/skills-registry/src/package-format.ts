import { createHash } from "node:crypto";

/** Largest package body accepted, in bytes (1 MiB). */
export const MAX_PACKAGE_BYTES = 1024 * 1024;

/** Stable, machine-readable reason a registry operation failed. */
export type SkillsRegistryErrorCode =
  | "invalid_name"
  | "invalid_version"
  | "invalid_package"
  | "not_found"
  | "unreachable"
  | "too_large"
  | "digest_mismatch"
  | "unsafe_path"
  | "invalid_skill_md"
  | "insecure_url"
  | "install_failed";

/** Typed error thrown by every registry operation; branch on `code`. */
export class SkillsRegistryError extends Error {
  readonly code: SkillsRegistryErrorCode;
  constructor(code: SkillsRegistryErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SkillsRegistryError";
    this.code = code;
  }
}

/** The JSON package as published: base64 file contents. */
export interface SkillPackage {
  name: string;
  version: string;
  description: string;
  files: { path: string; contentBase64: string }[];
}

/** A package whose digest, name, version, paths and SKILL.md were checked. */
export interface VerifiedSkillPackage {
  name: string;
  version: string;
  sha256: string;
  files: { path: string; bytes: Uint8Array }[];
}

/** Name of the metadata file the installer writes; packages may not carry it. */
export const ORIGIN_FILE = ".origin.json";

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const NUM = "(0|[1-9]\\d*)";
const PRE_ID = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const BUILD_ID = "[0-9A-Za-z-]+";
const SEMVER_RE = new RegExp(
  `^${NUM}\\.${NUM}\\.${NUM}(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?(?:\\+${BUILD_ID}(?:\\.${BUILD_ID})*)?$`,
);

export function assertSkillName(name: string): void {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new SkillsRegistryError("invalid_name", `invalid skill name: ${JSON.stringify(name)}`);
  }
}

interface ParsedVersion {
  core: [string, string, string];
  pre: string[];
}

function parseVersion(version: string): ParsedVersion {
  const m = typeof version === "string" ? SEMVER_RE.exec(version) : null;
  if (!m) {
    throw new SkillsRegistryError("invalid_version", `invalid version: ${JSON.stringify(version)}`);
  }
  return {
    core: [m[1] as string, m[2] as string, m[3] as string],
    pre: m[4] ? m[4].split(".") : [],
  };
}

export function assertSkillVersion(version: string): void {
  parseVersion(version);
}

/** Compares canonical (no leading zero) numeric strings without converting to Number. */
function compareNumeric(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePreId(a: string, b: string): number {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return compareNumeric(a, b);
  if (an) return -1;
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePre(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return Math.sign(b.length - a.length);
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = comparePreId(a[i] as string, b[i] as string);
    if (c !== 0) return c;
  }
  return Math.sign(a.length - b.length);
}

/** SemVer 2.0 precedence (build metadata ignored). Throws `invalid_version` on a bad input. */
export function compareSkillVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    const d = compareNumeric(pa.core[i] as string, pb.core[i] as string);
    if (d !== 0) return d;
  }
  return comparePre(pa.pre, pb.pre);
}

export function isPrerelease(version: string): boolean {
  return parseVersion(version).pre.length > 0;
}

export function assertSafePath(path: string): void {
  const bad =
    typeof path !== "string" ||
    path === "" ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path.split("/").some((s) => s === "" || s === "." || s === "..");
  if (bad) {
    throw new SkillsRegistryError("unsafe_path", `unsafe package path: ${JSON.stringify(path)}`);
  }
  if (path === ORIGIN_FILE) {
    throw new SkillsRegistryError("unsafe_path", `${ORIGIN_FILE} is reserved for the installer`);
  }
}

/**
 * Reads `name` from the leading `---` frontmatter block of a SKILL.md, checking the
 * whole block: every top-level key must be unique and well formed, and `name` must
 * appear exactly once as a valid skill name.
 */
export function parseSkillMdName(text: string): string {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) throw new SkillsRegistryError("invalid_skill_md", "SKILL.md has no frontmatter");
  const keys = new Set<string>();
  let name: string | undefined;
  for (const line of (m[1] as string).split(/\r?\n/)) {
    if (line.trim() === "" || /^\s/.test(line) || line.startsWith("#") || line.startsWith("- ")) {
      continue; // blank, comment, or nested/continuation content
    }
    const kv = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:(?:\s+(.*?))?\s*$/.exec(line);
    if (!kv) {
      throw new SkillsRegistryError(
        "invalid_skill_md",
        `SKILL.md frontmatter has a malformed line: ${JSON.stringify(line)}`,
      );
    }
    const key = kv[1] as string;
    if (keys.has(key)) {
      throw new SkillsRegistryError("invalid_skill_md", `SKILL.md frontmatter repeats "${key}"`);
    }
    keys.add(key);
    if (key === "name") {
      const raw = kv[2] ?? "";
      const q = /^(["'])(.*)\1$/.exec(raw);
      name = q ? (q[2] as string) : raw;
      if (/^["']|["']$/.test(name) || !NAME_RE.test(name)) {
        throw new SkillsRegistryError(
          "invalid_skill_md",
          `SKILL.md name is malformed: ${JSON.stringify(raw)}`,
        );
      }
    }
  }
  if (name === undefined) {
    throw new SkillsRegistryError("invalid_skill_md", "SKILL.md frontmatter has no name");
  }
  return name;
}

/** Checks names, paths, duplicates and SKILL.md of an already-decoded package. */
export function assertValidPackageContent(pkg: VerifiedSkillPackage): void {
  assertSkillName(pkg.name);
  assertSkillVersion(pkg.version);
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    throw new SkillsRegistryError("invalid_package", "package has no files");
  }
  const seen = new Set<string>();
  for (const f of pkg.files) {
    assertSafePath(f.path);
    const key = f.path.toLowerCase();
    if (seen.has(key)) {
      throw new SkillsRegistryError("invalid_package", `repeated file: ${f.path}`);
    }
    seen.add(key);
  }
  const md = pkg.files.find((f) => f.path === "SKILL.md");
  if (!md) throw new SkillsRegistryError("invalid_skill_md", "package has no SKILL.md");
  const declared = parseSkillMdName(new TextDecoder().decode(md.bytes));
  if (declared !== pkg.name) {
    throw new SkillsRegistryError(
      "invalid_skill_md",
      `SKILL.md names ${JSON.stringify(declared)}, package is ${JSON.stringify(pkg.name)}`,
    );
  }
}

function decodeBase64(value: unknown, path: string): Uint8Array {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value) ||
    value.length % 4 !== 0
  ) {
    throw new SkillsRegistryError("invalid_package", `file ${path} is not valid base64`);
  }
  return new Uint8Array(Buffer.from(value, "base64"));
}

function parsePackageJson(bytes: Uint8Array): SkillPackage {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new SkillsRegistryError("invalid_package", "package is not valid JSON", { cause });
  }
  const p = raw as Partial<SkillPackage> | null;
  if (
    !p ||
    typeof p !== "object" ||
    typeof p.name !== "string" ||
    typeof p.version !== "string" ||
    !Array.isArray(p.files)
  ) {
    throw new SkillsRegistryError("invalid_package", "package has the wrong shape");
  }
  return p as SkillPackage;
}

/** Checks size, sha256, identity, paths and SKILL.md of a package body; throws `SkillsRegistryError`. */
export function verifySkillPackage(
  bytes: Uint8Array,
  expected: { name: string; version: string; sha256: string },
): VerifiedSkillPackage {
  assertSkillName(expected.name);
  assertSkillVersion(expected.version);
  if (bytes.length > MAX_PACKAGE_BYTES) {
    throw new SkillsRegistryError("too_large", `package exceeds ${MAX_PACKAGE_BYTES} bytes`);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== String(expected.sha256).toLowerCase()) {
    throw new SkillsRegistryError(
      "digest_mismatch",
      "package sha256 does not match the registry listing",
    );
  }
  const pkg = parsePackageJson(bytes);
  if (pkg.name !== expected.name || pkg.version !== expected.version) {
    throw new SkillsRegistryError(
      "invalid_package",
      `package is ${pkg.name}@${pkg.version}, expected ${expected.name}@${expected.version}`,
    );
  }
  const files = pkg.files.map((f) => {
    if (!f || typeof f.path !== "string") {
      throw new SkillsRegistryError("invalid_package", "file entry has no path");
    }
    assertSafePath(f.path);
    return { path: f.path, bytes: decodeBase64(f.contentBase64, f.path) };
  });
  const verified: VerifiedSkillPackage = { name: pkg.name, version: pkg.version, sha256, files };
  assertValidPackageContent(verified);
  return verified;
}
