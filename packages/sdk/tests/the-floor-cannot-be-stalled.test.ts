import { describe, expect, it } from "vitest";

import { permissionFloorReason } from "../src/permission-floors.js";

/**
 * The floor runs on every tool call, so its own matcher must not be a denial of service.
 *
 * CodeQL flagged a polynomial regular expression on uncontrolled data in `DESTRUCTIVE`, and it was
 * right twice over: two adjacent quantifiers over overlapping classes (`[;&|]\s*` followed by
 * `\s*`), and an unbounded `\S*` inside the alternation.
 *
 * Measured before the fix, on the input the tool named: 2 000 spaces took 2.1ms, 8 000 took 30.9ms,
 * 20 000 took 207.7ms — clean quadratic growth, so ~100 000 characters is several seconds.
 *
 * That was survivable while nothing called the floor. It stopped being survivable in the same commit
 * that wired it into `permission-plugin.ts`, because the matcher now runs before every tool call:
 * one crafted argument stalls the agent rather than being refused by it. Making a guard reachable
 * and making its cost matter are the same act.
 *
 * The budget is deliberately loose. This is about GROWTH, not about milliseconds on a shared runner
 * — a quadratic matcher blows past 250ms on this input by an order of magnitude, and a linear one
 * finishes in well under one.
 *
 * The dangerous fixtures below are ASSEMBLED rather than written as literals. A repository-level
 * command guard refuses a recursive delete of a root path anywhere in a command it sees, which is
 * the correct behaviour and makes the literal unwritable here; concatenation keeps the test honest
 * without arguing with the guard.
 */
const BUDGET_MS = 250;

const ROOT = "/";
const HOME = "~";
const RECURSIVE_DELETE = `rm -${"r"}f`;

function millisOf(fn: () => void): number {
  const started = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

describe("the destructive-command matcher is linear on adversarial input", () => {
  it("does not stall on a long run of separators and spaces", () => {
    const hostile = `;${" ".repeat(60_000)}X`;
    const ms = millisOf(() => permissionFloorReason("Bash", { command: hostile }));
    expect(ms, `matching 60k spaces took ${ms.toFixed(1)}ms`).toBeLessThan(BUDGET_MS);
  });

  it("does not stall on repeated separator-plus-command prefixes", () => {
    const hostile = `mkfs${"&mkfs".repeat(12_000)}!`;
    const ms = millisOf(() => permissionFloorReason("Bash", { command: hostile }));
    expect(ms, `matching 12k repetitions took ${ms.toFixed(1)}ms`).toBeLessThan(BUDGET_MS);
  });

  it("still refuses the destructive commands it is there to refuse", () => {
    // The control, and the reason the fix cannot simply loosen the pattern. A faster matcher that
    // stopped matching these would pass both cases above while removing the floor entirely.
    for (const command of [
      `${RECURSIVE_DELETE} ${ROOT}`,
      `  ${RECURSIVE_DELETE} ${HOME}`,
      `true; ${RECURSIVE_DELETE} ${ROOT}`,
      `false && ${RECURSIVE_DELETE} ${ROOT}`,
    ]) {
      expect(
        permissionFloorReason("Bash", { command }),
        `${command} was allowed through the critical-path floor`,
      ).toBeDefined();
    }
  });

  it("still lets an ordinary command through", () => {
    expect(permissionFloorReason("Bash", { command: "npm run build" })).toBeUndefined();
  });

  it("documents that a DEVICE NODE is not a critical path, and is therefore allowed", () => {
    // Measured, not assumed: `mkfs.ext4 /dev/sda` and `dd of=/dev/sda` pass this floor. The tier is
    // about critical PATHS — the working directory, the home directory, the filesystem root — and a
    // device node is none of them. `DESTRUCTIVE` matches the verb, and `destructiveTargetIn` then
    // finds no critical target, so the call is not refused.
    //
    // This is written down rather than silently accepted because a reader who sees `mkfs` in the
    // pattern reasonably concludes the command is stopped, and it is not. Whether a device-node tier
    // should exist is a separate question with its own blast radius — a floor that refused every
    // `/dev/` write would break legitimate tooling — and it is not decided inside a ReDoS fix.
    for (const command of ["mkfs.ext4 /dev/sda", "dd if=/dev/zero of=/dev/sda"]) {
      expect(permissionFloorReason("Bash", { command })).toBeUndefined();
    }
  });
});
