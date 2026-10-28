// B-600 — how the seccomp program reaches bwrap without ever sitting in a file.
//
// The program used to be written to `/tmp/ab-seccomp-*/filter.bpf` and read per command through
// `3< <path>`. `/tmp` is a writable root under `workspace-write`, so one confined command could
// overwrite that file, or rename its directory away and recreate it, and every LATER command loaded
// an allow-all program. Every read-only-bind variant left a rename route for some placement of the
// temp dir; a pipe fed from memory leaves nothing on disk to replace.

import { dirname, resolve } from "node:path";

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
 * Wrap `command` so bwrap reads `program` on fd 3 from a pipe:
 *
 *   exec /bin/sh -c '{ printf <octal> | exec <bwrap...> --seccomp 3 -- /bin/sh -c <cmd> 3<&0 0<&4 4<&-; } 4<&0'
 *
 * fd 4 saves the command's stdin before the pipe replaces fd 0 in the last stage; `3<&0` moves the
 * pipe to fd 3, `0<&4` restores stdin and `4<&-` closes the copy. Both `exec`s are required: they
 * make the process a timeout kills bwrap's direct parent, so `--die-with-parent` ends the confined
 * command with it. Without them a timeout left the command running. The pipeline's grammar is always
 * `/bin/sh`'s, whatever shell runs the outer word.
 *
 * `bwrapPrefix` is the escaped binary and flags, without `--seccomp` and the trailing `--`.
 */
export function wrapWithSeccompProgram(
  bwrapPrefix: string,
  command: string,
  program: Uint8Array,
): string {
  assertSeccompProgramShape(program);
  const pipeline =
    `{ printf '${octalPrintfArg(program)}' | exec ${bwrapPrefix} '--seccomp' '3' '--' ` +
    `/bin/sh -c ${shellEscapePosix(command)} 3<&0 0<&4 4<&-; } 4<&0`;
  return `exec /bin/sh -c ${shellEscapePosix(pipeline)}`;
}

/**
 * The deprecated path route: bwrap reads the program from `seccompPath` through `3< <path>`, with
 * the filter bound read-only on top of every writable bind so a confined command can neither
 * overwrite it nor rename its directory away (B-600).
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
    "--seccomp",
    "3",
    "--",
  ];
  return `${flags.map(shellEscapePosix).join(" ")} /bin/sh -c ${shellEscapePosix(command)} 3< ${shellEscapePosix(seccompPath)}`;
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
