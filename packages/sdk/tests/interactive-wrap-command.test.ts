/**
 * M75 T3.2 — `interactiveWrapCommand`: the missing composition.
 *
 * ## Why it exists, and why in the SDK
 *
 * `createSandboxBackend` already does this composition for the **non-interactive** path: it detects bwrap,
 * decides between confining and degrading honestly, and returns a ready backend. The interactive path
 * (PTY) needs exactly the same decision, but delivered as a **wrap function** — because the PTY
 * owns the spawn and only accepts transforming the command (`PtyInteractiveBackend({ wrapCommand })`).
 *
 * Without this function, every consumer wanting a confined interactive shell would rewrite the same
 * sequence: `detectBwrapMemoized` -> `if (!ok) WARN-once` -> `wrapCommandForSandbox` with
 * `allowlistedEnv` and `restrictedSeccompPath`. It is what agent-builder did in 99 lines of
 * subclass, and it is precisely what M75 exists to eliminate — "what every theokit consumer
 * that runs commands will reimplement".
 *
 * ## The invariant these tests protect
 *
 * The two "do not confine" routes are **semantically different** and the code must not merge them:
 * `danger-full-access` is an explicit opt-out (no warning), while bwrap being unavailable is a
 * failure (warns, once). Both return `null` — the value is the same, the meaning is not.
 */
import { describe, expect, it } from "vitest";

import { type BwrapDetection, interactiveWrapCommand } from "../src/sandbox/index.js";
// By explicit module path, not through the barrel: these are test seams and the package keeps them
// out of its public surface (see the note at the foot of src/sandbox/index.ts).
import { __resetInteractiveWarnLatchForTests } from "../src/sandbox/linux-sandbox.js";

const detectOk = (): BwrapDetection => ({ ok: true, bin: "/usr/bin/bwrap" });
const detectFailure = (): BwrapDetection => ({ ok: false, reason: "bwrap not found in PATH" });

/** The wrap with one quoting level removed, where the seccomp pipeline nests the bwrap flags. */
const atBwrapLevel = (wrap: string | null): string => (wrap ?? "").replaceAll("'\\''", "'");

describe("M75 T3.2 — interactiveWrapCommand", () => {
  it("test_confines_when_bwrap_exists", () => {
    const wrap = interactiveWrapCommand({ mode: "workspace-write", detect: detectOk });
    const out = wrap("python3 -i", "/w");
    expect(out, "with bwrap available the command MUST be wrapped").not.toBeNull();
    expect(out).toContain("/usr/bin/bwrap");
    expect(out).toContain("--unshare-net");
    // The cwd received is what the PTY will use: the binds must target the SAME directory, otherwise
    // the confinement points one way and the process runs another.
    expect(out).toContain("/w");
  });

  it("test_danger_full_access_returns_null_and_does_NOT_warn", () => {
    __resetInteractiveWarnLatchForTests();
    const warnings: string[] = [];
    const wrap = interactiveWrapCommand({
      mode: "danger-full-access",
      detect: detectOk,
      warn: (m) => warnings.push(m),
    });
    expect(wrap("bash", "/w")).toBeNull();
    // The distinction the code must not lose: "the user turned it off" is not an anomaly.
    expect(warnings, "an explicit opt-out is not an anomaly and must not warn").toHaveLength(0);
  });

  it("test_absent_bwrap_returns_null_and_warns_ONCE", () => {
    __resetInteractiveWarnLatchForTests();
    const warnings: string[] = [];
    const wrap = interactiveWrapCommand({
      mode: "workspace-write",
      detect: detectFailure,
      warn: (m) => warnings.push(m),
    });
    expect(wrap("bash", "/w")).toBeNull();
    expect(wrap("python3", "/w")).toBeNull();
    // Once per process: repeating it every interactive session becomes noise nobody reads.
    expect(warnings, "the warning repeated — it becomes noise and stops being read").toHaveLength(
      1,
    );
    expect(warnings[0], "the warning must say WHY and in which mode").toMatch(
      /PATH.*workspace-write/s,
    );
    expect(warnings[0], "the warning must make clear there is NO confinement").toMatch(
      /WITHOUT|unconfined|not confined/i,
    );
  });

  it("test_read_only_grants_no_write_even_on_the_cwd", () => {
    const out = interactiveWrapCommand({ mode: "read-only", detect: detectOk })("bash", "/w");
    // `wrapCommandForSandbox` returns the SHELL-QUOTED string (each flag in single quotes), not the
    // raw argv. The first version of this test asserted the raw form — and the NEGATIVE assertion
    // passed vacuously: `not.toContain("--bind /w /w")` would be true even with the bind
    // present, because the real form is `'--bind' '/w' '/w'`. A test that cannot fail proves
    // nothing, and this was precisely the one protecting read-only mode.
    // B-600: on x86_64 the bwrap flags sit one quoting level deeper, inside the pipeline that pipes
    // the seccomp program; `atBwrapLevel` reads them at their own level.
    expect(atBwrapLevel(out)).toContain("'--ro-bind' '/' '/'");
    expect(atBwrapLevel(out), "read-only must not write-bind the cwd").not.toContain(
      "'--bind' '/w' '/w'",
    );
  });

  it("test_the_negative_lens_on_read_only_is_able_to_fail", () => {
    // Proof the assertion above is NOT vacuous: in the mode that MUST write to the cwd, the same
    // the searched string does appear. Without this counter-proof, `not.toContain` would stay green forever.
    const rw = interactiveWrapCommand({ mode: "workspace-write", detect: detectOk })("bash", "/w");
    expect(atBwrapLevel(rw), "workspace-write MUST write-bind the cwd").toContain(
      "'--bind' '/w' '/w'",
    );
  });

  it("the interactive wrap names no host file for the seccomp program", () => {
    // B-600: the program a confined command loads must not live in a file an earlier confined
    // command could replace. The interactive wrap pipes it from memory, so no path is named.
    const out = interactiveWrapCommand({ mode: "workspace-write", detect: detectOk })("bash", "/w");
    expect(out, "the wrap must not read the program from a host file").not.toMatch(/3< /);
    expect(out).not.toContain(".bpf");
    expect(out).not.toContain("ab-seccomp-");
    if (process.arch === "x64")
      expect(out, "the filter must still be installed").toContain("--seccomp");
  });

  it("test_detection_is_consulted_per_wrap_not_frozen_at_construction", () => {
    // An interactive session lives for hours. Freezing detection at construction would mean that
    // installing bwrap mid-session would never take effect — and, worse, that a stale positive
    // detection would keep asserting confinement after the binary vanished.
    let calls = 0;
    const wrap = interactiveWrapCommand({
      mode: "workspace-write",
      detect: () => {
        calls++;
        return detectOk();
      },
    });
    wrap("a", "/w");
    wrap("b", "/w");
    expect(calls, "detection was frozen at construction").toBe(2);
  });
});

/**
 * M75 review (architecture, MEDIUM) — the rule "seccomp only with a restricted network" had TWO copies.
 *
 * The `LinuxSandbox` constructor decided conditionally; `interactiveWrapCommand` installed
 * unconditionally. They diverged in the very first version, and the effect is the worst possible combination: with
 * `network: true` bwrap **allows** the network (no `--unshare-net`) while seccomp **denies** it with EPERM.
 * The user asks for network, gets the bind, and the calls die with no explanation.
 *
 * This test locks both paths to the SAME decision. If anyone duplicates the rule again, it fails.
 */
describe("M75 review — seccomp and network decide together on both paths", () => {
  it("test_an_open_network_does_NOT_install_seccomp_interactively", () => {
    const out = interactiveWrapCommand({
      mode: "workspace-write",
      network: true,
      detect: detectOk,
    })("bash", "/w");
    expect(out, "with the network open bwrap must not isolate it").not.toContain("--unshare-net");
    expect(
      out,
      "the cBPF filter denies network syscalls: installing it with the network open makes bwrap allow and " +
        "seccomp to deny the SAME thing",
    ).not.toContain("--seccomp");
  });

  it("test_a_restricted_network_installs_seccomp_in_the_interactive_path", () => {
    // COUNTER-PROOF: without it the `not.toContain` above would stay green even if seccomp were never
    // installed — and then the test would protect the filter's absence instead of the rule's coherence.
    const out = interactiveWrapCommand({
      mode: "workspace-write",
      network: false,
      detect: detectOk,
    })("bash", "/w");
    expect(out).toContain("--unshare-net");
    expect(out, "with the network closed the filter MUST be installed").toContain("--seccomp");
  });
});
