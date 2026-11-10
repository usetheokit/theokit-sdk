import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { wrapWithSeccompProgram } from "../src/sandbox/seccomp-delivery.js";

describe("#937 — piped seccomp wrap with fd 0 closed", () => {
  it.skipIf(process.platform === "win32")("runs the command and returns its status", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wrap937-"));
    try {
      const fake = path.join(dir, "fakebwrap");
      writeFileSync(fake, '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n');
      chmodSync(fake, 0o755);
      const w = wrapWithSeccompProgram([fake], "echo RAN; exit 3", new Uint8Array(8));
      for (const redirect of ["<&-", "</dev/null"]) {
        const r = spawnSync("/bin/sh", ["-c", `( ${w} ) ${redirect}`], { encoding: "utf8" });
        expect(r.stderr, redirect).toBe("");
        expect(r.stdout, redirect).toBe("RAN\n");
        expect(r.status, redirect).toBe(3);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
