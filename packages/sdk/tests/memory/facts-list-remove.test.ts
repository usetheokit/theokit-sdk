import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { listMemoryFacts, MemoryFactNotRemovableError, removeMemoryFact } from "../../src/index.js";
import {
  appendFactToMarkdown,
  readFactsFromMarkdown,
} from "../../src/internal/memory/storage/markdown-store.js";
import { claudeProjectMemoryDir } from "../../src/internal/memory/storage/memory-root.js";
import { removeTempDirRobustSync } from "../helpers/temp-workspace.js";

describe("listMemoryFacts / removeMemoryFact", () => {
  let cwd: string;
  let dir: string;
  const savedHome = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "mf-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "mf-home-"));
    onTestFinished(() => {
      removeTempDirRobustSync(cwd);
      removeTempDirRobustSync(home);
    });
    process.env.CLAUDE_CONFIG_DIR = home;
    dir = join(cwd, ".theokit", "memory");
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedHome;
  });

  const seed = async (): Promise<void> => {
    await appendFactToMarkdown(cwd, { text: "first fact" });
    await appendFactToMarkdown(cwd, { text: "second fact" });
    const md = readFileSync(join(dir, "MEMORY.md"), "utf8");
    writeFileSync(
      join(dir, "MEMORY.md"),
      `${md}\n## Facts\n- legacy fact\n\n## Other\n- legacy fact\n`,
    );
  };

  it("lists three removable entries in readFactsFromMarkdown order", async () => {
    await seed();
    const listed = await listMemoryFacts(cwd);
    const raw = await readFactsFromMarkdown(cwd);
    expect(listed.map((f) => f.text)).toEqual(raw.map((f) => f.text));
    expect(listed).toHaveLength(3);
    expect(listed.every((f) => f.removable)).toBe(true);
  });

  it("removes a per-memory entry, its file and its index line", async () => {
    await seed();
    const target = (await listMemoryFacts(cwd)).find((f) => f.text === "first fact");
    expect(target).toBeDefined();
    expect(await removeMemoryFact(cwd, target?.id ?? "")).toBe(true);
    expect(existsSync(join(dir, target?.id ?? ""))).toBe(false);
    expect(readFileSync(join(dir, "MEMORY.md"), "utf8")).not.toContain(target?.id ?? "x");
    expect(await listMemoryFacts(cwd)).toHaveLength(2);
  });

  it("removes only the legacy bullet inside ## Facts", async () => {
    await seed();
    const legacy = (await listMemoryFacts(cwd)).find((f) => f.text === "legacy fact");
    expect(await removeMemoryFact(cwd, legacy?.id ?? "")).toBe(true);
    const md = readFileSync(join(dir, "MEMORY.md"), "utf8");
    expect(md.match(/- legacy fact/g)).toHaveLength(1);
    expect(md.indexOf("- legacy fact")).toBeGreaterThan(md.indexOf("## Other"));
    expect(await listMemoryFacts(cwd)).toHaveLength(2);
  });

  it("resolves false for an unknown id and changes nothing", async () => {
    await seed();
    const snap = (): string[] =>
      readdirSync(dir)
        .sort()
        .map((n) => readFileSync(join(dir, n), "utf8"));
    const before = snap();
    expect(await removeMemoryFact(cwd, "no-such-id")).toBe(false);
    expect(snap()).toEqual(before);
  });

  it("refuses an entry from another root", async () => {
    const cc = claudeProjectMemoryDir(cwd);
    mkdirSync(cc, { recursive: true });
    writeFileSync(
      join(cc, "cli.md"),
      "---\nname: cli\ndescription: cli\nmetadata:\n  node_type: memory\n---\n\nCLI fact.\n",
    );
    const [fact] = await listMemoryFacts(cwd);
    expect(fact?.removable).toBe(false);
    expect(fact?.root).toBe(cc);
    const err = await removeMemoryFact(cwd, fact?.id ?? "").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MemoryFactNotRemovableError);
    expect((err as MemoryFactNotRemovableError).factId).toBe("cli.md");
    expect((err as MemoryFactNotRemovableError).root).toBe(cc);
    expect(existsSync(join(cc, "cli.md"))).toBe(true);
  });
});
