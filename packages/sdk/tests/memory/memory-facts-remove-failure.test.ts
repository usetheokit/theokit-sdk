import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";

const failure = vi.hoisted(() => ({ unlink: true }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      if (failure.unlink) throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
      return actual.unlink(...args);
    },
  };
});

import { listMemoryFacts, removeMemoryFact } from "../../src/index.js";
import { appendFactToMarkdown } from "../../src/internal/memory/storage/markdown-store.js";
import { removeTempDirRobustSync } from "../helpers/temp-workspace.js";

let cwd: string;
const saved = process.env.CLAUDE_CONFIG_DIR;

beforeEach(async () => {
  cwd = mkdtempSync(join(tmpdir(), "mf-fail-"));
  const home = mkdtempSync(join(tmpdir(), "mf-fail-home-"));
  onTestFinished(() => {
    removeTempDirRobustSync(cwd);
    removeTempDirRobustSync(home);
  });
  process.env.CLAUDE_CONFIG_DIR = home;
  failure.unlink = true;
  await appendFactToMarkdown(cwd, { text: "alpha fact" });
});

afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved;
});

it("a failure between the index rewrite and the unlink is finished by retrying the same id", async () => {
  const [entry] = await listMemoryFacts(cwd);
  const id = entry?.id as string;
  const dir = join(cwd, ".theokit", "memory");
  await expect(removeMemoryFact(cwd, id)).rejects.toThrow("injected");
  // Interrupted: the file is still there and still listed, so nothing is lost or orphaned.
  expect(existsSync(join(dir, id))).toBe(true);
  expect(await listMemoryFacts(cwd)).toHaveLength(1);
  failure.unlink = false;
  expect(await removeMemoryFact(cwd, id)).toBe(true);
  expect(existsSync(join(dir, id))).toBe(false);
  expect(readFileSync(join(dir, "MEMORY.md"), "utf8")).not.toContain(`](${id})`);
  expect(await listMemoryFacts(cwd)).toHaveLength(0);
});
