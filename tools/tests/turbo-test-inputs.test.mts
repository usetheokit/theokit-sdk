import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const root = mkdtempSync(join(tmpdir(), "turbo-inputs-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function put(rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

function pkg(name: string): string {
  return JSON.stringify({ name, version: "0.0.0", scripts: { test: "true", build: "true" } });
}

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function hashes(): Record<string, string> {
  const turbo = join(REPO, "node_modules", ".bin", "turbo");
  const out = execFileSync(turbo, ["run", "test", "--dry=json"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1" },
  });
  const tasks = (JSON.parse(out) as { tasks: { taskId: string; hash: string }[] }).tasks;
  return Object.fromEntries(tasks.map((t) => [t.taskId, t.hash]));
}

function changed(rel: string, body: string): string[] {
  const before = hashes();
  put(rel, body);
  git("add", "-A");
  const after = hashes();
  return Object.keys(after).filter((k) => after[k] !== before[k]);
}

describe("turbo test task inputs", () => {
  it("invalidate tests that read files outside their package", () => {
    cpSync(join(REPO, "turbo.json"), join(root, "turbo.json"));
    put("package.json", JSON.stringify({ name: "root", private: true, packageManager: "pnpm@9.0.0" }));
    put("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
    put("pnpm-lock.yaml", "lockfileVersion: '9.0'\nimporters: {}\n");
    put(".gitignore", "node_modules\n");
    for (const [dir, name] of [
      ["sdk", "@theokit/sdk"],
      ["sdk-memory", "@theokit/sdk-memory"],
      ["cli", "@theokit/cli"],
    ] as const) {
      put(`packages/${dir}/package.json`, pkg(name));
      put(`packages/${dir}/src/index.ts`, "export {};\n");
    }
    put("packages/cli/templates/a.txt", "a\n");
    put("README.md", "x\n");
    git("init", "-q");
    git("add", "-A");

    expect(changed("packages/sdk-memory/package.json", `${pkg("@theokit/sdk-memory")}\n`)).toContain(
      "@theokit/sdk#test",
    );
    expect(changed("README.md", "y\n")).toContain("@theokit/sdk#test");
    expect(changed("packages/cli/templates/a.txt", "b\n")).toContain("@theokit/cli#test");
    expect(changed("packages/sdk/package.json", `${pkg("@theokit/sdk")}\n`)).toContain(
      "@theokit/cli#test",
    );
  }, 120_000);
});
