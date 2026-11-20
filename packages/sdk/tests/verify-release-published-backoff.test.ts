/**
 * Tests for the size-proportional backoff in tools/verify-release-published.mjs (#537).
 *
 * The mitigation added in 84624e2d scales the retry backoff by `dist.unpackedSize`, because
 * @theokit/sdk (12.9 MB, 1141 files) propagates slower than the registry's default ~30s window
 * and had produced a false "was NOT published" three releases running.
 *
 * It never engaged. `getUnpackedSize` asked the registry for the size of the version being
 * verified — and it is only ever called for versions the registry has just answered 404 for, so
 * the lookup 404s too, the size is `undefined`, and the default delays are used unchanged.
 * Unreachable by construction: in the loop where it is called it cannot return anything else.
 *
 * Strategy: a fixture workspace (the script reads `packages/` from cwd and takes no arguments)
 * plus an `npm` stub on PATH. Offline and deterministic — the canned answers reproduce exactly
 * what the real registry says mid-publish: 404 for the version being verified, a real size for
 * the package's published `latest`.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..", "..");
const script = resolve(repoRoot, "tools", "verify-release-published.mjs");

/** The real unpackedSize of @theokit/sdk's published `latest` (4.63.4), measured 2026-09-04. */
const PUBLISHED_SIZE = 12_369_860;
/** 12_369_860 / 5_000_000 = 2.47 -> a 10ms base becomes 25ms. */
const EXPECTED_SCALED_WAIT = /waiting 2[0-9]ms/;

let fixture: string;
let binDir: string;

/**
 * An `npm` shim answering the two shapes the script asks for, the way the registry does
 * mid-publish:
 *   npm view <name>@<version> …            -> E404, the version has not propagated
 *   npm view <name> dist.unpackedSize      -> a size, from the published `latest`
 */
function stubNpm(): void {
  const shim = `#!/usr/bin/env node
const args = process.argv.slice(2);
const spec = args[1] ?? "";
const field = args[2] ?? "";
const versioned = spec.lastIndexOf("@") > 0;
if (versioned) {
  process.stderr.write("npm error code E404\\nnpm error 404 No match found for version\\n");
  process.exit(1);
}
if (field === "dist.unpackedSize") {
  process.stdout.write("${String(PUBLISHED_SIZE)}\\n");
  process.exit(0);
}
process.stderr.write("npm error code E404\\n");
process.exit(1);
`;
  const p = join(binDir, "npm");
  writeFileSync(p, shim, "utf8");
  chmodSync(p, 0o755);
}

/** One publishable package, over the 5MB threshold the scaling is gated on. */
function writeFixture(): void {
  const dir = join(fixture, "packages", "sdk");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "@theokit/sdk", version: "5.0.0-next.9" }),
    "utf8",
  );
}

function runVerify(): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [script], {
    cwd: fixture,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      // One short delay: these tests are about whether scaling engages, not about waiting.
      THEOKIT_RELEASE_VERIFY_DELAYS_MS: "10",
    },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("#537 — the size-proportional backoff actually engages", () => {
  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), "theokit-537-ws-"));
    binDir = mkdtempSync(join(tmpdir(), "theokit-537-bin-"));
    writeFixture();
    stubNpm();
  });

  afterEach(() => {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  });

  it("reads the size from the published package, not from the version being verified", () => {
    const { stdout, stderr } = runVerify();

    // The multiplier line is the observable proof a size was obtained. Before the fix the size
    // lookup 404'd exactly like the version check, and this line never appeared.
    expect(
      stdout + stderr,
      "a >5MB package must report its backoff multiplier; absent means the size lookup 404'd",
    ).toContain("backoff multiplier");
  });

  it("waits longer than the unscaled delay for a package over 5MB", () => {
    const { stdout, stderr } = runVerify();

    expect(stdout + stderr).toMatch(EXPECTED_SCALED_WAIT);
  });

  it("still fails the release when the version never appears — scaling changes the wait, not the verdict", () => {
    const { status } = runVerify();

    expect(status, "a version absent after every retry is still a failure").not.toBe(0);
  });
});

describe("#574 — the budget covers the lag that was actually measured", () => {
  // The defect was not the shape of the backoff, which #537 got right — it was the size of the
  // budget. Measured on the 5.0.1 release (run 33971302112):
  //
  //   14:26:34  changeset reported the publish succeeded
  //   14:28:03  the verifier gave up and exited 1
  //   14:29:36  npm registered @theokit/sdk@5.0.1
  //
  // 182 s from publish to registration for a 13 MB package, against a 78 s scaled budget. The
  // release had worked and the pipeline called it failed; 5.0.0 did the same the day before.
  //
  // This pins the NUMBER rather than the behaviour, because a number is what regressed and a
  // shorter ladder would pass every other test in this file.
  const OBSERVED_LAG_MS = 182_000;
  const SDK_UNPACKED_BYTES = 13_018_300;

  /** The ladder the script uses when the environment does not override it. */
  function defaultLadder(): number[] {
    const src = readFileSync(script, "utf8");
    const match = /THEOKIT_RELEASE_VERIFY_DELAYS_MS \?\? "([\d,]+)"/.exec(src);
    if (match === null) throw new Error("could not find the default delay ladder in the script");
    return match[1]!.split(",").map(Number);
  }

  it("the scaled budget for the 13MB package exceeds the lag observed in production", () => {
    // Same scaling the script applies: Math.min(4, size / 5_000_000).
    const scale = Math.min(4, SDK_UNPACKED_BYTES / 5_000_000);
    const budget = defaultLadder().reduce((sum, d) => sum + Math.round(d * scale), 0);

    expect(
      budget,
      `the ladder gives a ${SDK_UNPACKED_BYTES}-byte package ${budget}ms, and npm took ` +
        `${OBSERVED_LAG_MS}ms to register it on 2026-09-05. A budget below the measurement ` +
        "reports a successful release as failed (#574).",
    ).toBeGreaterThan(OBSERVED_LAG_MS);
  });
});

describe("#1241 — a version that shows up after the old window is still reported published", () => {
  it("reports published when the registry shows the version only on the seventh re-read of the default ladder", () => {
    const fx = mkdtempSync(join(tmpdir(), "theokit-1241-ws-"));
    const bin = mkdtempSync(join(tmpdir(), "theokit-1241-bin-"));
    try {
      mkdirSync(join(fx, "packages", "sdk"), { recursive: true });
      writeFileSync(
        join(fx, "packages", "sdk", "package.json"),
        JSON.stringify({ name: "@theokit/sdk", version: "5.26.0" }),
        "utf8",
      );
      const counter = join(fx, "count");
      writeFileSync(counter, "0", "utf8");
      const shim = `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const spec = args[1] ?? "";
if (spec.lastIndexOf("@") > 0) {
  const n = Number(fs.readFileSync(${JSON.stringify(counter)}, "utf8")) + 1;
  fs.writeFileSync(${JSON.stringify(counter)}, String(n));
  if (n > 7) { process.stdout.write("5.26.0\\n"); process.exit(0); }
}
process.stderr.write("npm error code E404\\n");
process.exit(1);
`;
      writeFileSync(join(bin, "npm"), shim, "utf8");
      chmodSync(join(bin, "npm"), 0o755);
      // Default ladder, but every wait fires at once: preload a setTimeout that ignores its delay.
      const preload = join(bin, "instant-timers.cjs");
      writeFileSync(
        preload,
        "const t = global.setTimeout; global.setTimeout = (f, _ms, ...a) => t(f, 0, ...a);",
        "utf8",
      );
      const r = spawnSync(process.execPath, [script], {
        cwd: fx,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          THEOKIT_RELEASE_VERIFY_DELAYS_MS: undefined,
          NODE_OPTIONS: `--require ${preload}`,
        },
      });
      expect(r.stdout + r.stderr).toContain("is on the registry (after a retry)");
      expect(r.status).toBe(0);
    } finally {
      rmSync(fx, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
