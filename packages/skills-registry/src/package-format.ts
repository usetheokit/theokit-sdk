import { createHash } from "node:crypto";

/** Maximum size of a serialized skill package: 1 MiB. */
export const MAX_PACKAGE_BYTES = 1024 * 1024;

/** Machine-readable reason carried by every `SkillsRegistryError`. */
export type SkillsRegistryErrorCode =
  | "invalid_name"
  | "invalid_version"
  | "not_found"
  | "unreachable"
  | "too_large"
  | "digest_mismatch"
  | "unsafe_path"
  | "invalid_skill_md"
  | "invalid_package"
  | "insecure_url"
  | "install_failed";

/** Typed error of this package; branch on `code`, not on the message. */
export class SkillsRegistryError extends Error {
  readonly code: SkillsRegistryErrorCode;
  constructor(code: SkillsRegistryErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SkillsRegistryError";
    this.code = code;
  }
}

/** Wire format of a skill package: JSON with base64 file contents. */
export interface SkillPackage {
  name: string;
  version: string;
  description: string;
  files: { path: string; contentBase64: string }[];
}

/** A package whose digest, paths and `SKILL.md` identity were checked; safe to install. */
export interface VerifiedSkillPackage {
  name: string;
  version: string;
  sha256: string;
  files: { path: string; bytes: Uint8Array }[];
}

/** Reserved for the install metadata; a package may not ship it. */
export const ORIGIN_FILE = ".origin.json";

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NUM = "(0|[1-9]\\d*)";
const PRE_ID = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const SEMVER_RE = new RegExp(
  `^${NUM}\\.${NUM}\\.${NUM}(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);

export function assertSkillName(name: unknown): asserts name is string {
  if (typeof name !== "string" || name.length > 64 || !NAME_RE.test(name)) {
    throw new SkillsRegistryError("invalid_name", `invalid skill name: ${String(name)}`);
  }
}

interface ParsedVersion {
  core: [string, string, string];
  pre: string[];
}

function parseVersion(v: unknown): ParsedVersion {
  const m = typeof v === "string" ? SEMVER_RE.exec(v) : null;
  if (!m) throw new SkillsRegistryError("invalid_version", `invalid version: ${String(v)}`);
  return {
    core: [m[1] as string, m[2] as string, m[3] as string],
    pre: m[4] ? m[4].split(".") : [],
  };
}

export function assertSkillVersion(v: unknown): asserts v is string {
  parseVersion(v);
}

export function isPrerelease(v: string): boolean {
  return parseVersion(v).pre.length > 0;
}

/** Compares digit strings without converting to Number: shorter is smaller, then lexical. */
function compareNumeric(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

const isNumeric = (s: string): boolean => /^\d+$/.test(s);

function comparePreId(a: string, b: string): number {
  const an = isNumeric(a);
  const bn = isNumeric(b);
  if (an && bn) return compareNumeric(a, b);
  if (an !== bn) return an ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

function comparePre(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0)
    return Math.sign(b.length === 0 ? (a.length === 0 ? 0 : -1) : 1);
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = comparePreId(a[i] as string, b[i] as string);
    if (c !== 0) return c;
  }
  return Math.sign(a.length - b.length);
}

/** SemVer 2.0.0 precedence (build metadata ignored). Throws `invalid_version`. */
export function compareSkillVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    const c = compareNumeric(pa.core[i] as string, pb.core[i] as string);
    if (c !== 0) return c;
  }
  return comparePre(pa.pre, pb.pre);
}

function unsafe(path: string): never {
  throw new SkillsRegistryError("unsafe_path", `unsafe package path: ${JSON.stringify(path)}`);
}

export function checkSkillPath(path: unknown): asserts path is string {
  if (typeof path !== "string" || path === "") unsafe(String(path));
  if (
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path)
  ) {
    unsafe(path);
  }
  for (const seg of path.split("/")) {
    if (seg === "" || seg === "." || seg === "..") unsafe(path);
  }
  if (path === ORIGIN_FILE) unsafe(path);
}

/** Rejects repeated paths and a path that is both a file and a directory of another. */
export function checkFileSet(paths: string[]): void {
  const seen = new Set<string>();
  for (const p of paths) {
    if (seen.has(p)) throw new SkillsRegistryError("invalid_package", `repeated file: ${p}`);
    seen.add(p);
  }
  for (const p of paths) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (seen.has(parts.slice(0, i).join("/"))) unsafe(p);
    }
  }
}

function bad(msg: string): never {
  throw new SkillsRegistryError("invalid_skill_md", msg);
}

const UNQUOTED_BAD_START = /^[|>[\]{}&*!%@`,?-]/;

function quotedScalar(v: string): string {
  const q = v[0] as string;
  const inner = v.slice(1, -1);
  if (v.length < 2 || !v.endsWith(q) || inner.includes(q) || inner.includes("\\")) {
    bad("SKILL.md name is malformed");
  }
  return inner;
}

function scalarName(raw: string): string {
  const v = raw.trim();
  if (v === "") bad("SKILL.md name is empty");
  if (v.startsWith('"') || v.startsWith("'")) return quotedScalar(v);
  const plain = v.replace(/\s+#.*$/, "").trim();
  if (UNQUOTED_BAD_START.test(plain) || plain.includes(": ")) bad("SKILL.md name is malformed");
  return plain;
}

const isSkippable = (line: string): boolean =>
  line.trim() === "" || line.trimStart().startsWith("#");

const FIELD_RE = /^([A-Za-z0-9_-]+)\s*:(?:\s(.*))?$/;

interface Field {
  key: string;
  value: string;
  continued: boolean;
}

function readFields(lines: string[]): Field[] {
  const fields: Field[] = [];
  for (const line of lines.filter((l) => !isSkippable(l))) {
    const last = fields[fields.length - 1];
    if (/^\s/.test(line)) {
      if (last) last.continued = true;
      continue;
    }
    const m = FIELD_RE.exec(line) ?? bad(`SKILL.md frontmatter line is malformed: ${line}`);
    fields.push({ key: m[1] as string, value: m[2] ?? "", continued: false });
  }
  return fields;
}

/** Returns the raw `name` value after checking that no field repeats. */
function scanFrontmatter(lines: string[]): string | undefined {
  const fields = readFields(lines);
  const dup = fields.find((f, i) => fields.findIndex((g) => g.key === f.key) !== i);
  if (dup) bad(`SKILL.md repeats the field ${dup.key}`);
  const name = fields.find((f) => f.key === "name");
  if (name?.continued) bad("SKILL.md name spans several lines");
  return name?.value;
}

/**
 * Reads the whole frontmatter block. Any repeated top-level key, a top-level line that is not
 * `key: value`, or a name that is not one single scalar is refused, so the verified name is the
 * only name a consumer can read.
 */
export function parseSkillName(text: string): string {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") bad("SKILL.md has no frontmatter");
  const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === "---");
  if (end < 0) bad("SKILL.md frontmatter is not closed");
  const nameLine = scanFrontmatter(lines.slice(1, end));
  if (nameLine === undefined) bad("SKILL.md frontmatter has no name");
  return scalarName(nameLine as string);
}

function decodeBase64(s: unknown, path: string): Uint8Array {
  if (typeof s !== "string" || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) {
    throw new SkillsRegistryError("invalid_package", `file ${path} is not valid base64`);
  }
  return new Uint8Array(Buffer.from(s, "base64"));
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseJson(bytes: Uint8Array): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch (cause) {
    throw new SkillsRegistryError("invalid_package", "package is not valid JSON", { cause });
  }
  throw new SkillsRegistryError("invalid_package", "package is not a JSON object");
}

export function checkSkillMd(files: { path: string; bytes: Uint8Array }[], name: string): void {
  const md = files.find((f) => f.path === "SKILL.md");
  if (!md) bad("package has no SKILL.md");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(md.bytes);
  } catch {
    bad("SKILL.md is not valid UTF-8");
  }
  if (parseSkillName(text) !== name) bad(`SKILL.md names a different skill than ${name}`);
}

/**
 * Checks size, sha256, name, version, paths and `SKILL.md` of serialized package bytes.
 * Throws `SkillsRegistryError`; writes nothing.
 */
export function verifySkillPackage(
  bytes: Uint8Array,
  expected: { name: string; version: string; sha256: string },
): VerifiedSkillPackage {
  assertSkillName(expected.name);
  assertSkillVersion(expected.version);
  if (bytes.byteLength > MAX_PACKAGE_BYTES) {
    throw new SkillsRegistryError("too_large", `package exceeds ${MAX_PACKAGE_BYTES} bytes`);
  }
  const digest = sha256Hex(bytes);
  if (digest !== String(expected.sha256).toLowerCase()) {
    throw new SkillsRegistryError(
      "digest_mismatch",
      "package sha256 differs from the registry listing",
    );
  }
  const raw = parseJson(bytes);
  if (raw.name !== expected.name || raw.version !== expected.version) {
    throw new SkillsRegistryError(
      "invalid_package",
      "package name or version differs from the listing",
    );
  }
  if (!Array.isArray(raw.files) || raw.files.length === 0) {
    throw new SkillsRegistryError("invalid_package", "package has no files");
  }
  const files = (raw.files as { path?: unknown; contentBase64?: unknown }[]).map((f) => {
    const path = f?.path;
    checkSkillPath(path);
    return { path: path as string, bytes: decodeBase64(f.contentBase64, path as string) };
  });
  checkFileSet(files.map((f) => f.path));
  checkSkillMd(files, expected.name);
  return { name: expected.name, version: expected.version, sha256: digest, files };
}
