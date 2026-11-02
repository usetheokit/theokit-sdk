/**
 * B-648 (loop-code-review LCR0123 + LCR0602 of B-600): the seccomp temp-dir cleanup re-raises
 * SIGINT/SIGTERM when `process.listenerCount(signal) === 0`. A host handler registered with
 * `process.once` BEFORE the filter was written has removed itself by the time the SDK listener
 * runs, so the count reads 0 and the re-raise ends the process while the host's asynchronous
 * shutdown is still running. Each case runs in its own Node process, since it signals itself.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { removeTempDirRobustSync } from "./helpers/temp-workspace.js";

const REPO_ROOT = path.join(import.meta.dirname, "..", "..", "..");
const MODULE = path.join(import.meta.dirname, "..", "src", "sandbox", "linux-sandbox.ts");

type Signal = "SIGTERM" | "SIGINT";

/**
 * The host's shutdown: registered with once, asynchronous, and it ends the process itself. On entry
 * it prints whether any filter directory written so far still exists (the SDK cleanup runs first).
 */
function hostOnceHandler(signal: Signal): string[] {
  return [
    `process.once(${JSON.stringify(signal)}, async () => {`,
    `  const present = (globalThis.b648Filters ?? []).some((f) => existsSync(dirname(f)));`,
    `  console.log(present ? "DIR_PRESENT_AT_HOST_ENTRY" : "DIR_GONE_AT_HOST_ENTRY");`,
    `  await new Promise((r) => setTimeout(r, 200));`,
    `  console.log("DONE");`,
    `  process.exit(0);`,
    `});`,
  ];
}

const WRITE_FILTER = [
  `{ const f = seccompPathForArch("x64", () => {});`,
  `  console.log(f); (globalThis.b648Filters ??= []).push(f); }`,
].join("\n");

/** Run `body` in a child that imports the SDK and then signals itself; each filter it writes is printed. */
function runChild(signal: Signal, body: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "b648-once-"));
  onTestFinished(() => removeTempDirRobustSync(dir));
  const script = path.join(dir, "child.ts");
  writeFileSync(
    script,
    [
      `import { existsSync } from "node:fs";`,
      `import { dirname } from "node:path";`,
      `import { seccompPathForArch } from ${JSON.stringify(MODULE)};`,
      ...body,
      `process.kill(process.pid, ${JSON.stringify(signal)});`,
      `setTimeout(() => console.log("SURVIVED"), 3000);`,
    ].join("\n"),
  );
  const r = spawnSync(process.execPath, ["--import", "tsx", script], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 30_000,
  });
  const filters = r.stdout.split("\n").filter((line) => line.endsWith("filter.bpf"));
  const filter = filters[0] ?? "";
  return { ...r, filter, filterDir: path.dirname(filter), filters };
}

describe("B-648 — a host's process.once shutdown handler finishes", () => {
  it("lets_a_host_once_handler_finish_its_async_shutdown", () => {
    // The host registers FIRST, with once, and its shutdown is asynchronous.
    const r = runChild("SIGTERM", [...hostOnceHandler("SIGTERM"), WRITE_FILTER]);
    // The SDK listener was installed: without the filter path the run measures nothing (EC-1).
    expect(r.filter, r.stderr).toMatch(/ab-seccomp-.*filter\.bpf$/);
    expect(r.stdout, "the re-raise cut off the host's shutdown").toContain("DONE");
    expect(r.stdout, "the host ran before the SDK cleanup").toContain("DIR_GONE_AT_HOST_ENTRY");
    expect(r.signal).toBeNull();
    expect(r.status).toBe(0);
    expect(existsSync(r.filterDir), "the temp dir outlived the process").toBe(false);
  });

  it("lets_a_host_once_handler_registered_after_the_filter_finish", () => {
    const r = runChild("SIGTERM", [WRITE_FILTER, ...hostOnceHandler("SIGTERM")]);
    expect(r.filter, r.stderr).toMatch(/ab-seccomp-.*filter\.bpf$/);
    expect(r.stdout, "the re-raise cut off the host's shutdown").toContain("DONE");
    expect(r.stdout, "the host ran before the SDK cleanup").toContain("DIR_GONE_AT_HOST_ENTRY");
    expect(r.signal).toBeNull();
    expect(r.status).toBe(0);
    expect(existsSync(r.filterDir), "the temp dir outlived the process").toBe(false);
  });

  it("lets_a_host_once_handler_registered_between_two_filters_finish", () => {
    const r = runChild("SIGINT", [WRITE_FILTER, ...hostOnceHandler("SIGINT"), WRITE_FILTER]);
    expect(r.filters, r.stderr).toHaveLength(2);
    for (const filter of r.filters) expect(filter).toMatch(/ab-seccomp-.*filter\.bpf$/);
    expect(r.stdout, "the re-raise cut off the host's shutdown").toContain("DONE");
    expect(r.stdout, "the host ran before the SDK cleanup").toContain("DIR_GONE_AT_HOST_ENTRY");
    expect(r.signal).toBeNull();
    expect(r.status).toBe(0);
    for (const filter of r.filters) {
      expect(existsSync(path.dirname(filter)), "a temp dir outlived the process").toBe(false);
    }
  });

  it("a process that wrote two filters and has no handler of its own still ends by the signal", () => {
    // Both SDK listeners are prepended; the second filter's runs first, reads one listener left
    // (the first filter's) and does not re-raise; the last reads zero and re-raises (T1.1 invariant).
    const r = runChild("SIGTERM", [WRITE_FILTER, WRITE_FILTER]);
    expect(r.filters, r.stderr).toHaveLength(2);
    for (const filter of r.filters) expect(filter).toMatch(/ab-seccomp-.*filter\.bpf$/);
    expect(r.signal, "the process survived its SIGTERM").toBe("SIGTERM");
    expect(r.stdout).not.toContain("SURVIVED");
    for (const filter of r.filters) {
      expect(existsSync(path.dirname(filter)), "a temp dir outlived the process").toBe(false);
    }
  });
});
