/**
 * M75 T2.2 — `LinuxSandbox` + the wrap + the posture, promoted from agent-builder.
 *
 * ## Why it fits the contract without breaking it
 *
 * `SandboxBackend` declares exactly 2 abstracts (`execute`, `uploadFile`); `readFile`/`writeFile`/
 * `glob`/`grep` are concrete over `execute`. `LinuxSandbox` only does `override execute` — the method
 * **already abstract** — and **adds** `wrapCommand`. No member is missing, so promoting forces no major.
 *
 * ## What these tests protect, which is not obvious
 *
 * This subsystem's value is not in confining when things go right — it is in **NEVER pretending**
 * when they go wrong. Three honest-degradation paths are tested here as negative cases, asserting
 * the specific error/warning rather than "it did not throw": bwrap absent, `danger-full-access` (an
 * explicit opt-out, which is NOT an anomaly and therefore does not warn), and a non-x86_64
 * architecture (where the cBPF filter would kill every syscall).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, onTestFinished, vi } from "vitest";

import {
  allowlistedEnv,
  type BwrapDetection,
  buildSeccompFilter,
  createSandboxBackend,
  LinuxSandbox,
  resolveSandboxPosture,
  SandboxBackend,
  seccompPathForArch,
  wrapCommandForSandbox,
} from "../src/sandbox/index.js";
// By explicit module path, not through the barrel: these are test seams and the package keeps them
// out of its public surface (see the note at the foot of src/sandbox/index.ts).
import { __resetSandboxWarnLatchForTests } from "../src/sandbox/linux-sandbox.js";
import { shellEscapePosix } from "../src/sandbox/shell-escape.js";
import { removeTempDirRobustSync } from "./helpers/temp-workspace.js";

const detectOk = (): BwrapDetection => ({ ok: true, bin: "/usr/bin/bwrap" });
const detectFailure = (): BwrapDetection => ({ ok: false, reason: "bwrap not found in PATH" });

describe("M75 T2.2 — wrapCommandForSandbox", () => {
  it("test_it_wraps_with_bwrap_and_preserves_the_quoted_command", () => {
    const w = wrapCommandForSandbox(
      "workspace-write",
      { cwd: "/w", network: false, env: {}, bin: "/usr/bin/bwrap" },
      "echo 'oi'",
    );
    expect(w).not.toBeNull();
    // The command crosses ONE extra `/bin/sh -c`: the quoting must survive, otherwise a command with
    // single quotes would become a different command inside the sandbox.
    expect(w).toContain("/bin/sh -c");
    expect(w).toContain("--unshare-net");
  });

  it("test_danger_full_access_returns_null", () => {
    // `null` = "do not wrap". Returning the raw command would conflate the two in the caller.
    expect(
      wrapCommandForSandbox("danger-full-access", { cwd: "/w", env: {} }, "echo oi"),
    ).toBeNull();
  });

  it("test_seccomp_only_goes_in_when_there_is_a_path", () => {
    const withoutSeccomp = wrapCommandForSandbox("workspace-write", { cwd: "/w", env: {} }, "true");
    const com = wrapCommandForSandbox(
      "workspace-write",
      { cwd: "/w", env: {}, seccompPath: "/tmp/f.bpf" },
      "true",
    );
    expect(withoutSeccomp).not.toContain("--seccomp");
    // The program comes in via an fd 3 redirect — that is how bwrap reads it.
    expect(com).toContain("--seccomp");
    expect(com).toContain("3< ");
  });
});

/**
 * B-600 — the program route. The seccomp program travels to bwrap's fd 3 through a pipe fed from
 * memory, so no file exists that a confined command could replace for a later one.
 */
describe("B-600 — seccompProgram: the program piped from memory", () => {
  // Bytes 000 and 377, and a digit right after an escape: `\000` followed by `1` must stay two bytes.
  const PROGRAM = Buffer.from([
    0, 0x31, 0xff, 0x7f, 6, 0, 0, 0, 0, 0, 0, 0, 0x20, 0x0a, 0x27, 0x5c,
  ]);

  /** The octal escapes of the printf the wrap emits, as `/bin/sh` will read them. */
  function printfArgumentOf(wrap: string): string {
    // The program is the first positional argument of `exec /bin/sh -c <script> sh`, escaped once.
    const m = / sh '((?:\\[0-7]{3})+)' /.exec(wrap);
    if (m === null) throw new Error(`no octal printf argument in the wrap: ${wrap}`);
    return m[1] as string;
  }

  it("the printf argument of the wrap decodes to the program's exact bytes", () => {
    const wrap = wrapCommandForSandbox(
      "workspace-write",
      { cwd: "/w", env: {}, bin: "/usr/bin/bwrap", seccompProgram: PROGRAM },
      "true",
    )!;
    const decoded = execFileSync("/bin/sh", ["-c", `printf '${printfArgumentOf(wrap)}'`]);
    expect(Buffer.compare(decoded, PROGRAM), `decoded ${decoded.toString("hex")}`).toBe(0);
  });

  it("the piped program costs about four characters per byte of the wrap", () => {
    const program = buildSeccompFilter({ networkRestricted: true });
    const opts = { cwd: "/w", env: {}, bin: "/usr/bin/bwrap" };
    const plain = wrapCommandForSandbox("workspace-write", opts, "true")!;
    const piped = wrapCommandForSandbox(
      "workspace-write",
      { ...opts, seccompProgram: program },
      "true",
    )!;
    expect(piped.length).toBeLessThanOrEqual(4 * program.length + 2 * plain.length + 64);
  });

  it("LinuxSandbox's wrap names no host file for the seccomp program", () => {
    const s = new LinuxSandbox(
      { workDir: "/w" },
      { mode: "workspace-write", bin: "/usr/bin/bwrap", env: {} },
    );
    const w = s.wrapCommand("true")!;
    expect(w, "the wrap must not read the program from a host file").not.toMatch(/3< /);
    expect(w).not.toContain(".bpf");
    expect(w).not.toContain("ab-seccomp-");
    if (process.arch === "x64")
      expect(w, "the filter must still be installed").toContain("--seccomp");
  });

  it("seccompProgram wins over seccompPath when both are given", () => {
    const w = wrapCommandForSandbox(
      "workspace-write",
      { cwd: "/w", env: {}, seccompPath: "/x/f.bpf", seccompProgram: PROGRAM },
      "true",
    )!;
    expect(w, "with both given the path must be ignored").not.toContain("/x/f.bpf");
    expect(w).not.toMatch(/3< /);
    expect(w).toContain("printf");
  });

  it("seccompProgram rejects a length that is not a positive multiple of 8", () => {
    const wrapWith = (program: Buffer) => () =>
      wrapCommandForSandbox(
        "workspace-write",
        { cwd: "/w", env: {}, seccompProgram: program },
        "true",
      );
    expect(wrapWith(Buffer.alloc(0))).toThrow(TypeError);
    expect(wrapWith(Buffer.alloc(0))).toThrow(
      "seccompProgram must be a positive multiple of 8 bytes, got 0",
    );
    expect(wrapWith(Buffer.alloc(7))).toThrow(
      "seccompProgram must be a positive multiple of 8 bytes, got 7",
    );
  });

  it("a non-x86_64 architecture refuses the seccomp program and warns once", async () => {
    // Its own warn-once latch: a shared one would make this test silence the path route's test below.
    // The constructor tests above trip it on a non-x86_64 host, so the module is loaded afresh, with
    // an unlatched latch, instead of through a reset seam in production code.
    const tripped = await import("../src/sandbox/seccomp-delivery.js");
    tripped.seccompProgramForArch("arm64", () => {}); // the latch as an earlier constructor leaves it
    vi.resetModules();
    const { seccompProgramForArch } = await import("../src/sandbox/seccomp-delivery.js");
    const warnings: string[] = [];
    expect(seccompProgramForArch("arm64", (m) => warnings.push(m))).toBeUndefined();
    expect(seccompProgramForArch("arm64", (m) => warnings.push(m))).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/x86_64|x64/i);
    expect(seccompProgramForArch("x64", () => {})?.length).toBeGreaterThan(0);
  });

  /** A stand-in for bwrap: skips its flags up to `--`, drains fd 3, then runs the command. */
  function fakeBwrap(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "b600-fake-bwrap-"));
    onTestFinished(() => removeTempDirRobustSync(dir));
    const bin = path.join(dir, "bwrap");
    writeFileSync(
      bin,
      '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\ncat <&3 >/dev/null\nexec "$@"\n',
    );
    chmodSync(bin, 0o755);
    return bin;
  }

  it("the piped wrap parses to the same words under fish's single-quote rules as under sh's", () => {
    // fish reads `\'` and `\\` as escapes inside single quotes; sh reads every byte there literally.
    // A word escaped twice puts a backslash before a quote inside single quotes, and the two shells
    // then split the wrap differently. Each word must be escaped exactly once.
    const wrap = wrapCommandForSandbox(
      "workspace-write",
      { cwd: "/w", env: {}, bin: "/usr/bin/bwrap", seccompProgram: PROGRAM },
      `printf %s "it's"`,
    )!;
    expect(shellWords(wrap, "fish")).toEqual(shellWords(wrap, "sh"));
    expect(shellWords(wrap, "sh")).toContain(`printf %s "it's"`);
  });

  // A backslash before a quote, or before another backslash, is where fish and sh part ways: fish
  // reads `\'` and `\\` inside single quotes as escapes. Under fish the first two payloads used to
  // leave `(touch /tmp/pwned)` and `;touch PWNED;#` unquoted, run by the host shell outside bwrap.
  const FISH_HOSTILE = [
    String.raw`\'(touch /tmp/pwned)\'`,
    String.raw`a\';touch PWNED;#`,
    String.raw`echo a\\b`,
    String.raw`printf 'a\\nb'`,
    String.raw`trailing\\`,
  ];
  const ROUTES = {
    "the piped program": { seccompProgram: PROGRAM },
    "no filter": {},
    "a foreign seccompPath": { seccompPath: "/tmp/ab-seccomp-X/filter.bpf" },
  } as const;

  for (const [route, extra] of Object.entries(ROUTES)) {
    it.each(FISH_HOSTILE)(`${route}: %j parses to the same words under fish as under sh`, (cmd) => {
      const wrap = wrapCommandForSandbox(
        "workspace-write",
        { cwd: "/w", env: {}, bin: "/usr/bin/bwrap", ...extra },
        cmd,
      )!;
      expect(shellWords(wrap, "fish")).toEqual(shellWords(wrap, "sh"));
      expect(shellWords(wrap, "sh"), "the command must reach /bin/sh -c verbatim").toContain(cmd);
    });
  }

  it("every word of quotes, backslashes and a letter, up to six long, escapes to itself in both shells", () => {
    let words = [""];
    for (let n = 0; n < 6; n++)
      words = [
        ...words,
        ...words.map((w) => w + "a"),
        ...words.map((w) => w + "\\"),
        ...words.map((w) => w + "'"),
      ];
    for (const w of new Set(words)) {
      const escaped = shellEscapePosix(w);
      expect(shellWords(escaped, "sh"), `sh: ${escaped}`).toEqual([w]);
      expect(shellWords(escaped, "fish"), `fish: ${escaped}`).toEqual([w]);
    }
  });

  it("the piped wrap keeps a backslash in the command", () => {
    const wrap = wrapCommandForSandbox(
      "workspace-write",
      { cwd: "/w", env: {}, bin: fakeBwrap(), seccompProgram: PROGRAM },
      String.raw`printf %s 'a\\b' "c\'"`,
    )!;
    expect(execFileSync("/bin/sh", ["-c", wrap], { input: "" }).toString()).toBe(
      String.raw`a\\bc\'`,
    );
  });

  it("the piped wrap keeps a single quote in the command", () => {
    const wrap = wrapCommandForSandbox(
      "workspace-write",
      { cwd: "/w", env: {}, bin: fakeBwrap(), seccompProgram: PROGRAM },
      `printf %s "it's"`,
    )!;
    expect(execFileSync("/bin/sh", ["-c", wrap], { input: "" }).toString()).toBe("it's");
  });

  it("the piped wrap keeps the command's stdin and exit status", () => {
    const wrap = wrapCommandForSandbox(
      "workspace-write",
      { cwd: "/w", env: {}, bin: fakeBwrap(), seccompProgram: PROGRAM },
      "cat; exit 7",
    )!;
    const r = spawnSync("/bin/sh", ["-c", wrap], { input: "piped-input" });
    expect(r.stdout.toString(), "the command's stdin must be the caller's, not the program").toBe(
      "piped-input",
    );
    expect(r.status).toBe(7);
  });
});

/**
 * B-600 — the deprecated path route. A consumer still passing `seccompPath` gets the filter bound
 * read-only on top of every writable bind, so a confined command cannot overwrite it or rename its
 * directory away. Where the directory is a writable root or contains one, only the file is bound,
 * so the workspace stays writable.
 */
describe("B-600 — seccompPath: the filter bound read-only", () => {
  const indexOfBind = (w: string, target: string): number =>
    w.indexOf(`'--ro-bind' '${target}' '${target}'`);

  it("a seccompPath directory is bound read-only after every writable bind", () => {
    const w = wrapCommandForSandbox(
      "workspace-write",
      { cwd: "/w", env: {}, seccompPath: "/tmp/ab-seccomp-X/filter.bpf" },
      "true",
    )!;
    const bind = indexOfBind(w, "/tmp/ab-seccomp-X");
    expect(bind, "the filter's directory must be bound read-only").toBeGreaterThan(-1);
    expect(bind, "after the writable /tmp bind, or /tmp would cover it").toBeGreaterThan(
      w.lastIndexOf("'--bind'"),
    );
    expect(bind, "before bwrap's `--`").toBeLessThan(w.indexOf("'--chdir'"));
  });

  it("a helper-written seccompPath is bound only if it still exists, since the wrap never reads it", () => {
    // The program of a path seccompPathForArch wrote is piped from memory. A plain `--ro-bind` made
    // bwrap exit 1 ("Can't find source path") once anything removed the directory.
    const filter = seccompPathForArch("x64", () => {})!;
    const dir = path.dirname(filter);
    onTestFinished(() => removeTempDirRobustSync(dir));
    const w = wrapCommandForSandbox(
      "workspace-write",
      { cwd: "/w", env: {}, seccompPath: filter },
      "true",
    )!;
    expect(w).toContain(`'--ro-bind-try' '${dir}' '${dir}'`);
    expect(indexOfBind(w, dir), "no plain bind that needs the directory on disk").toBe(-1);
    expect(w).not.toContain("3< ");
  });

  it("a seccompPath whose directory is an ancestor of the workspace binds only the file", () => {
    // `/x.bpf`: its directory is `/`, an ancestor of the workspace. Binding `/` read-only would
    // take the workspace's write access away, so only the file is bound.
    const w = wrapCommandForSandbox(
      "workspace-write",
      { cwd: "/home/u/proj", env: {}, seccompPath: "/x.bpf" },
      "true",
    )!;
    expect(indexOfBind(w, "/x.bpf")).toBeGreaterThan(w.lastIndexOf("'--bind'"));
    expect(w.match(/'--ro-bind' '\/' '\/'/g), "`/` must stay bound only once, first").toHaveLength(
      1,
    );
    expect(w.endsWith(" 3< '/x.bpf'")).toBe(true);
  });

  it("a seccompPath directly in /tmp binds only the file", () => {
    const w = wrapCommandForSandbox(
      "workspace-write",
      { cwd: "/w", env: {}, seccompPath: "/tmp/f.bpf" },
      "true",
    )!;
    expect(indexOfBind(w, "/tmp/f.bpf")).toBeGreaterThan(w.lastIndexOf("'--bind'"));
    expect(indexOfBind(w, "/tmp"), "/tmp must stay writable").toBe(-1);
  });

  it("a seccompPath under read-only mode binds the directory", () => {
    // read-only has no writable root, so nothing stops the directory itself being bound.
    const w = wrapCommandForSandbox(
      "read-only",
      { cwd: "/w", env: {}, seccompPath: "/tmp/ab-seccomp-X/filter.bpf" },
      "true",
    )!;
    expect(indexOfBind(w, "/tmp/ab-seccomp-X")).toBeLessThan(w.indexOf("'--chdir'"));
    expect(indexOfBind(w, "/tmp/ab-seccomp-X")).toBeGreaterThan(-1);
  });

  it("a seccompPath directly in the workspace binds only the file", () => {
    const w = wrapCommandForSandbox(
      "workspace-write",
      { cwd: "/w", env: {}, seccompPath: "/w/filter.bpf" },
      "true",
    )!;
    expect(indexOfBind(w, "/w/filter.bpf")).toBeGreaterThan(w.lastIndexOf("'--bind'"));
    expect(indexOfBind(w, "/w"), "the workspace must stay writable").toBe(-1);
  });
});

describe("M75 T2.2 — allowlistedEnv", () => {
  it("test_reinjects_only_what_is_allowed_and_discards_the_rest", () => {
    // Codex's env_clear model: the child gets what it needs to run a shell, never the parent's env
    // — which may hold a secret under a name no name-based heuristic catches.
    const env = allowlistedEnv({ PATH: "/bin", MY_ODDLY_NAMED_KEY: "s3cr3t", HOME: "/h" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h" });
    expect(Object.values(env)).not.toContain("s3cr3t");
  });
});

describe("M75 T2.2 — LinuxSandbox", () => {
  it("test_it_is_a_sandbox_backend_of_the_contract", () => {
    const s = new LinuxSandbox(
      { workDir: "/w" },
      { mode: "workspace-write", bin: "/usr/bin/bwrap" },
    );
    expect(s).toBeInstanceOf(SandboxBackend);
  });

  it("test_the_objects_wrap_command_uses_the_mode_it_was_built_with", () => {
    const s = new LinuxSandbox(
      { workDir: "/w" },
      { mode: "workspace-write", bin: "/usr/bin/bwrap" },
    );
    expect(s.wrapCommand("true")).toContain("--unshare-net");

    const livre = new LinuxSandbox({ workDir: "/w" }, { mode: "danger-full-access" });
    expect(livre.wrapCommand("true")).toBeNull();
  });
});

describe("M75 T2.2 — honest degradation (negative cases)", () => {
  it("test_absent_bwrap_warns_ONCE_and_returns_an_unconfined_backend", () => {
    __resetSandboxWarnLatchForTests();
    const warnings: string[] = [];
    const opts = {
      mode: "workspace-write" as const,
      detect: detectFailure,
      warn: (m: string) => warnings.push(m),
    };
    const a = createSandboxBackend(opts);
    const b = createSandboxBackend(opts);

    expect(a).toBeInstanceOf(SandboxBackend);
    expect(b).toBeInstanceOf(SandboxBackend);
    // Neither is a LinuxSandbox: without bwrap there is no confinement, and pretending would be the worst outcome.
    expect(a).not.toBeInstanceOf(LinuxSandbox);
    // ONCE: the warning is for the human, and repeating it on every tool call becomes noise nobody reads.
    expect(warnings, "the warning repeated — it becomes noise and stops being read").toHaveLength(
      1,
    );
    expect(warnings[0], "the warning must say WHY and in which mode").toMatch(
      /PATH.*workspace-write/s,
    );
  });

  it("test_danger_full_access_does_not_warn_because_it_is_an_explicit_opt_out", () => {
    __resetSandboxWarnLatchForTests();
    const warnings: string[] = [];
    const s = createSandboxBackend({
      mode: "danger-full-access",
      detect: detectFailure,
      warn: (m: string) => warnings.push(m),
    });
    expect(s).not.toBeInstanceOf(LinuxSandbox);
    // The distinction that matters: "the user turned it off" is not an anomaly; "I could not turn it on" is.
    expect(warnings, "an explicit opt-out is not an anomaly and must not warn").toHaveLength(0);
  });

  it("test_a_non_x64_architecture_refuses_seccomp_and_warns", () => {
    // ARCH GUARD: the cBPF program is x86_64 and its guard KILLS every syscall from another
    // architecture — the first execve would die, and silently, because generation works and bwrap
    // accepts it.
    const warnings: string[] = [];
    const p = seccompPathForArch("arm64", (m) => warnings.push(m));
    expect(p, "on arm64 no seccomp path may be returned").toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/x86_64|x64/i);
  });
});

/**
 * B-600 review (loop-code-review LCR0123): seccompPathForArch's temp-dir cleanup listens for
 * SIGINT and SIGTERM. A listener cancels Node's default termination, so a process that wrote the
 * filter ignored its first SIGTERM. Each case runs in its own Node process, since it signals itself.
 */
describe("B-600 — the seccomp temp-dir cleanup leaves the process terminable", () => {
  // The root `tsx` devDependency as a loader of this Node, resolved from the repository root, so the
  // child is one process and its signal is the one spawnSync reports.
  const REPO_ROOT = path.join(import.meta.dirname, "..", "..", "..");
  const MODULE = path.join(import.meta.dirname, "..", "src", "sandbox", "linux-sandbox.ts");

  function runChild(signal: "SIGTERM" | "SIGINT", ownHandler: boolean) {
    const dir = mkdtempSync(path.join(tmpdir(), "b600-signal-"));
    onTestFinished(() => removeTempDirRobustSync(dir));
    const script = path.join(dir, "child.ts");
    writeFileSync(
      script,
      [
        `import { seccompPathForArch } from ${JSON.stringify(MODULE)};`,
        ownHandler
          ? `process.on(${JSON.stringify(signal)}, () => { console.log("HANDLED"); process.exit(0); });`
          : "",
        `console.log(seccompPathForArch("x64", () => {}));`,
        `process.kill(process.pid, ${JSON.stringify(signal)});`,
        `setTimeout(() => console.log("SURVIVED"), 3000);`,
      ].join("\n"),
    );
    const r = spawnSync(process.execPath, ["--import", "tsx", script], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 30_000,
    });
    const filter = r.stdout.split("\n")[0] ?? "";
    return { ...r, filterDir: path.dirname(filter), filter };
  }

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    it(`a ${signal} still ends a process that wrote the filter, and the temp dir is removed`, () => {
      const r = runChild(signal, false);
      expect(r.filter, r.stderr).toMatch(/ab-seccomp-.*filter\.bpf$/);
      expect(r.stdout, "the signal was swallowed by the cleanup listener").not.toContain(
        "SURVIVED",
      );
      expect(r.signal).toBe(signal);
      expect(existsSync(r.filterDir), "the temp dir outlived the process").toBe(false);
    });
  }

  it("a host's own SIGTERM handler still decides, and the cleanup does not kill it", () => {
    const r = runChild("SIGTERM", true);
    expect(r.stdout).toContain("HANDLED");
    expect(r.status).toBe(0);
    expect(r.signal).toBeNull();
  });
});

describe("M75 T2.2 — resolveSandboxPosture", () => {
  it("test_confined_reports_kernel", () => {
    const p = resolveSandboxPosture({ mode: "workspace-write", detect: detectOk });
    expect(p.enforced).toBe(true);
    expect(p.detail).toMatch(/kernel/i);
  });

  it("test_without_bwrap_it_says_not_confined_WITH_the_reason", () => {
    // The posture is what the UI shows. "not confined" without a reason leaves the user with no action; with the
    // reason they know whether to install bwrap or whether they changed mode.
    const p = resolveSandboxPosture({ mode: "workspace-write", detect: detectFailure });
    expect(p.enforced).toBe(false);
    expect(p.detail).toContain("PATH");
  });

  it("test_danger_full_access_is_honestly_not_confined", () => {
    const p = resolveSandboxPosture({ mode: "danger-full-access", detect: detectOk });
    expect(p.enforced, "danger-full-access may never report confinement").toBe(false);
  });
});

/**
 * Split a line of plain words (no expansions) by quoting rules: `sh` reads a single-quoted region
 * literally; `fish` treats `\'` and `\\` inside it as escapes. Outside quotes both read `\x` as `x`.
 */
function shellWords(line: string, dialect: "sh" | "fish"): string[] {
  const single =
    dialect === "sh" ? String.raw`'[^']*'` : String.raw`'(?:\\[\\']|\\(?![\\'])|[^'\\])*'`;
  const part = new RegExp(String.raw`${single}|\\[^]|[^\s'\\]`, "g");
  const word = new RegExp(`(?:${part.source})+`, "g");
  if (line.replace(word, "").trim() !== "")
    throw new Error(`unparsed quote under ${dialect}: ${line}`);
  const decode = (p: string): string => {
    if (p.startsWith("'")) {
      const body = p.slice(1, -1);
      return dialect === "fish" ? body.replace(/\\([\\'])/g, "$1") : body;
    }
    return p.startsWith("\\") ? p.slice(1) : p;
  };
  return [...line.matchAll(word)].map((m) => m[0].replace(part, decode));
}
