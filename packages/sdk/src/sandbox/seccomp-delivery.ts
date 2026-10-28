// B-600 — how the seccomp program reaches bwrap without ever sitting in a file.
//
// The program used to be written to `/tmp/ab-seccomp-*/filter.bpf` and read per command through
// `3< <path>`. `/tmp` is a writable root under `workspace-write`, so one confined command could
// overwrite that file, or rename its directory away and recreate it, and every LATER command loaded
// an allow-all program. Every read-only-bind variant left a rename route for some placement of the
// temp dir; a pipe fed from memory leaves nothing on disk to replace.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { type SandboxMode, writableRootsFor } from "./bwrap.js";
import { buildSeccompFilter } from "./seccomp.js";
import { shellEscapePosix } from "./shell-escape.js";

/** The warning both arch guards print, the path route's and this one: one text, two latches. */
export function nonX64SeccompWarning(arch: string): string {
  return (
    `[sandbox] seccomp syscall filter unsupported on ${arch} (x86_64 only in v1) — running without ` +
    "the filter; bwrap FS/network confinement still applies."
  );
}

let warnedNonX64Program = false;

/** Test seam: reset `seccompProgramForArch`'s warn-once latch. Not re-exported from the barrel. */
export function __resetSeccompProgramWarnLatchForTests(): void {
  warnedNonX64Program = false;
}

/**
 * The restricted-network program for `arch`, or `undefined` where it must not be installed.
 *
 * Same ARCH GUARD as `seccompPathForArch`: the program is x86_64 and KILLs every syscall from
 * another architecture, so on any other arch it is refused with one warning. The latch is this
 * function's own, so a process that also calls the deprecated path helper warns once from each.
 */
export function seccompProgramForArch(arch: string, warn: (m: string) => void): Buffer | undefined {
  if (arch !== "x64") {
    if (!warnedNonX64Program) {
      warnedNonX64Program = true;
      warn(nonX64SeccompWarning(arch));
    }
    return undefined;
  }
  return buildSeccompFilter({ networkRestricted: true });
}

let memoizedProgram: Buffer | null | undefined; // undefined = not built yet; null = resolved absent

/** The restricted-network program, built once per process and x64-gated. Never mutated. */
export function restrictedSeccompProgram(warn: (m: string) => void): Buffer | undefined {
  if (memoizedProgram === undefined)
    memoizedProgram = seccompProgramForArch(process.arch, warn) ?? null;
  return memoizedProgram ?? undefined;
}

/**
 * `program` as a `printf` format of three-digit octal escapes. Always three digits, so a digit that
 * follows is never absorbed into the escape; no `%` appears, so printf prints it verbatim.
 */
function octalPrintfArg(program: Uint8Array): string {
  let out = "";
  for (const byte of program) out += `\\${byte.toString(8).padStart(3, "0")}`;
  return out;
}

/** A cBPF program is a non-empty list of 8-byte instructions; bwrap refuses anything else. */
function assertSeccompProgramShape(program: Uint8Array): void {
  if (program.length === 0 || program.length % 8 !== 0) {
    throw new TypeError(
      `seccompProgram must be a positive multiple of 8 bytes, got ${program.length}`,
    );
  }
}

/**
 * The script the piped wrap runs. It is a constant: the program, bwrap's argv and the command reach
 * it as positional arguments, so each is shell-escaped exactly once. Escaping a word twice put a
 * backslash inside single quotes before a quote, which fish reads as an escaped quote.
 *
 * fd 4 saves the command's stdin before the pipe replaces fd 0 in the last stage; `3<&0` moves the
 * pipe to fd 3, `0<&4` restores stdin and `4<&-` closes the copy. Both `exec`s are required: they
 * make the process a timeout kills bwrap's direct parent, so `--die-with-parent` ends the confined
 * command with it. Without them a timeout left the command running.
 */
const PIPE_SCRIPT = '{ p=$1; shift; printf "$p" | exec "$@" 3<&0 0<&4 4<&-; } 4<&0';

/**
 * Wrap `command` so bwrap reads `program` on fd 3 from a pipe:
 *
 *   exec /bin/sh -c '<PIPE_SCRIPT>' sh <octal> <bwrap...> --seccomp 3 -- /bin/sh -c <cmd>
 *
 * The pipeline's grammar is always `/bin/sh`'s, whatever shell runs the outer words.
 * `bwrapArgv` is the binary and flags, unescaped, without `--seccomp` and the trailing `--`.
 */
export function wrapWithSeccompProgram(
  bwrapArgv: readonly string[],
  command: string,
  program: Uint8Array,
): string {
  assertSeccompProgramShape(program);
  const words = [octalPrintfArg(program), ...bwrapArgv, "--seccomp", "3", "--", "/bin/sh", "-c"];
  return `exec /bin/sh -c ${shellEscapePosix(PIPE_SCRIPT)} sh ${[...words, command].map(shellEscapePosix).join(" ")}`;
}

/** The programs `writeSeccompFile` wrote, by resolved path: the wrap loads these, never the file. */
const programsWritten = new Map<string, Buffer>();

/**
 * Write `program` to a fresh temp file for the deprecated path route, removed on exit, SIGINT and
 * SIGTERM. The bytes are remembered by path, so a wrap naming this file pipes the program from
 * memory: a sandbox that does not load the filter mounts `/tmp` writable and can replace the file.
 */
export function writeSeccompFile(program: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "ab-seccomp-"));
  const path = join(dir, "filter.bpf");
  writeFileSync(path, program);
  programsWritten.set(path, Buffer.from(program));
  const cleanup = (): void => rmSync(dir, { recursive: true, force: true });
  process.once("exit", cleanup);
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
  return path;
}

/**
 * The deprecated path route, with the filter bound read-only on top of every writable bind so the
 * confined command can neither overwrite it nor rename its directory away (B-600). A path
 * `writeSeccompFile` wrote is piped from memory instead of read, because another sandbox, one with
 * no filter, can still replace that file; any other path is read through `3< <path>`.
 *
 * `bwrapArgv` is the binary followed by `buildBwrapArgv`'s output, which ends `--chdir <cwd> --`;
 * the bind goes before `--chdir`, after every writable bind.
 */
export function wrapWithSeccompPath(
  bwrapArgv: readonly string[],
  policy: { mode: SandboxMode; cwd: string },
  command: string,
  seccompPath: string,
): string {
  const flags = [
    ...bwrapArgv.slice(0, -3),
    ...readOnlyBindForSeccompPath(policy.mode, policy.cwd, seccompPath),
    ...bwrapArgv.slice(-3, -1),
  ];
  const program = programsWritten.get(resolve(seccompPath));
  if (program !== undefined) return wrapWithSeccompProgram(flags, command, program);
  return `${[...flags, "--seccomp", "3", "--"].map(shellEscapePosix).join(" ")} /bin/sh -c ${shellEscapePosix(command)} 3< ${shellEscapePosix(seccompPath)}`;
}

/**
 * The read-only bind for the filter. The DIRECTORY is bound, because binding only the file leaves
 * its parent renamable. Where that directory is a writable root or contains one (a filter at
 * `/x.bpf`, or directly in the workspace or `/tmp`), binding it would take a root's write access
 * away, so only the file is bound and a parent rename stays open there. A filter in a SUBdirectory
 * of a writable root makes that subdirectory read-only, and its ancestors stay renamable. Paths are
 * compared resolved, not through symlinks. `seccompProgram` has none of these gaps.
 */
function readOnlyBindForSeccompPath(mode: SandboxMode, cwd: string, seccompPath: string): string[] {
  const file = resolve(seccompPath);
  const dir = dirname(file);
  const roots = writableRootsFor(mode, resolve(cwd)) ?? [];
  const covers = (root: string): boolean =>
    dir === "/" || root === dir || root.startsWith(`${dir}/`);
  const target = roots.some(covers) ? file : dir;
  return ["--ro-bind", target, target];
}
