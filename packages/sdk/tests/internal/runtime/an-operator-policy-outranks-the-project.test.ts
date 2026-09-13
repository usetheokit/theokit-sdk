import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { setDiagnosticsSink } from "../../../src/internal/diagnostics.js";

import {
  managedSettingsPathFor,
  readManagedSettings,
} from "../../../src/internal/runtime/compat/managed-settings.js";
import { HooksExecutor } from "../../../src/internal/runtime/hooks/hooks-executor.js";
import { removeTempDirRobustSync } from "../../helpers/temp-workspace.js";

/**
 * An organisation could not impose policy on an agent, and its policy file was silently dropped.
 *
 * `managed-settings.json` is the tier Claude Code defines for settings a user "cannot override,
 * except for limited exceptions". Measured: `grep -rl managed-settings` returned 0 in this SDK, 0 in
 * the 4.52.1 dist and 0 in the 5.5.0 dist, against a control of 31 files for `hooks`. An
 * organisation that deployed a managed policy — a denied tool, a forced model, a required hook — got
 * it dropped, while the same file was enforced by the tool it was written for.
 *
 * This is not an incomplete feature. The failure direction is PERMIT, which is the shape of every
 * fail-open closed in this release.
 *
 * ## The decision behind it
 *
 * Recorded in `packages/agents/README.md` § "Who decides policy": an operator who did not write the
 * code CAN impose policy on it. Before this, hooks, MCP servers, permissions and skill execution
 * were each a value the programmer passed at build time — defensible for a framework, indefensible
 * for anything an organisation deploys, because the person answerable for what an agent may do on a
 * machine had no way to say so.
 *
 * ## Why a file the tests can point at
 *
 * The real path is platform-owned (`/etc/claude-code/…` on Linux, `/Library/Application Support/…`
 * on macOS, `%PROGRAMDATA%\\…` on Windows) and a test must not write there. `managedSettingsPathFor`
 * takes the root so the resolution is testable and the production caller passes the platform's.
 * Hard-coding the path inside the reader would make the precedence rule — the thing that actually
 * matters — unreachable by any test that does not run as root.
 */
function managedRootWith(settings: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "theokit-managed-"));
  onTestFinished(() => {
    removeTempDirRobustSync(root);
  });
  mkdirSync(join(root, "claude-code"), { recursive: true });
  writeFileSync(join(root, "claude-code", "managed-settings.json"), JSON.stringify(settings));
  return root;
}

function projectWithHook(): string {
  const dir = mkdtempSync(join(tmpdir(), "theokit-managed-proj-"));
  onTestFinished(() => {
    removeTempDirRobustSync(dir);
  });
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(
    join(dir, ".claude", "settings.json"),
    JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo hi" }] }] },
      disableAllHooks: false,
    }),
  );
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an operator policy outranks the project", () => {
  it("reads a managed settings file", () => {
    const root = managedRootWith({ disableAllHooks: true });
    expect(
      readManagedSettings(root),
      "an organisation's deployed policy was dropped without a word",
    ).toEqual({ disableAllHooks: true });
  });

  it("reads nothing when no policy is deployed", () => {
    // The control, and the ordinary case. Absent is not an error: most machines have no operator
    // tier, and a reader that failed without one would make the feature a prerequisite.
    const root = mkdtempSync(join(tmpdir(), "theokit-managed-none-"));
    onTestFinished(() => {
      removeTempDirRobustSync(root);
    });
    expect(readManagedSettings(root)).toEqual({});
  });

  it("reports a key it does not enforce, and does not carry it", () => {
    // The belief this tier exists to remove, one level in. An organisation that writes
    // `forceModel` into the policy file and gets silence concludes the model is forced. Carrying an
    // unenforced key through would let every layer downstream inherit that belief.
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    setDiagnosticsSink(undefined);

    const settings = readManagedSettings(
      managedRootWith({ disableAllHooks: true, forceModel: "opus" }),
    ) as Record<string, unknown>;

    expect(settings.forceModel, "an unenforced policy key was carried as if it applied").toBe(
      undefined,
    );
    expect(settings.disableAllHooks).toBe(true);
    expect(
      stderr.mock.calls.map((c) => String(c[0])).join(""),
      "the organisation was never told its policy key does nothing here",
    ).toContain("forceModel");
  });

  it("accepts a permission posture the operator imposes", () => {
    // `plan` is the one this exists for: an explore-only posture where edits are structurally
    // refused. A plan-mode TOOL already existed and it is something the MODEL may call — the
    // difference is who decides.
    expect(readManagedSettings(managedRootWith({ permissionMode: "plan" }))).toEqual({
      permissionMode: "plan",
    });
  });

  it("refuses a posture that is not one of the four, rather than guessing", () => {
    // `"readonly"` is what somebody writes when they mean `plan`. Accepting it by shape would apply
    // a posture nobody defined; dropping it silently would leave them believing edits are refused.
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    setDiagnosticsSink(undefined);

    expect(readManagedSettings(managedRootWith({ permissionMode: "readonly" }))).toEqual({});
    expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toContain("permissionMode");
  });

  it("resolves a platform path without being told one", () => {
    // The production caller passes no root. Whatever it resolves to must be absolute and must name
    // the file, or the tier exists only in tests.
    const path = managedSettingsPathFor();
    expect(path).toMatch(/managed-settings\.json$/);
    expect(path.startsWith("/") || /^[A-Za-z]:\\/.test(path)).toBe(true);
  });

  it("lets a managed disableAllHooks veto a project that declared hooks", async () => {
    const hooks = new HooksExecutor(projectWithHook(), ["claude-code"], undefined, {
      managedSettingsRoot: managedRootWith({ disableAllHooks: true }),
    });
    await hooks.initialize(true);

    const result = await hooks.run({ event: "preToolUse", tool: "shell" });

    expect(
      result.decisions,
      "the project declared a hook and the operator forbade hooks — the hook ran anyway",
    ).toEqual([]);
  });

  it("does not let the project turn the policy back off", async () => {
    // The precedence test the item asks for by name. The project file says `disableAllHooks: false`
    // and loses — a tier a lower layer can switch off is not a tier.
    const hooks = new HooksExecutor(projectWithHook(), ["claude-code"], undefined, {
      managedSettingsRoot: managedRootWith({ disableAllHooks: true }),
    });
    await hooks.initialize(true);

    expect((await hooks.run({ event: "preToolUse", tool: "shell" })).decisions).toEqual([]);
  });

  it("runs the project's hooks when no policy forbids them", async () => {
    // The second control. A veto that fired without an operator saying so would disable every hook
    // in every project — the opposite failure, and a louder one.
    const hooks = new HooksExecutor(projectWithHook(), ["claude-code"], undefined, {
      managedSettingsRoot: managedRootWith({}),
    });
    await hooks.initialize(true);

    expect((await hooks.run({ event: "preToolUse", tool: "shell" })).decisions).not.toEqual([]);
  });
});
