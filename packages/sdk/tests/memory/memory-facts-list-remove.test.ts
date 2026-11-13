import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  let claudeHome: string;
  const saved = process.env.CLAUDE_CONFIG_DIR;
  const md = () => join(cwd, ".theokit", "memory", "MEMORY.md");

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "mf-cwd-"));
    claudeHome = mkdtempSync(join(tmpdir(), "mf-home-"));
    onTestFinished(() => {
      removeTempDirRobustSync(cwd);
      removeTempDirRobustSync(claudeHome);
    });
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    await appendFactToMarkdown(cwd, { text: "alpha fact" });
    await appendFactToMarkdown(cwd, { text: "beta fact" });
    writeFileSync(md(), `${readFileSync(md(), "utf8")}\n## Facts\n- legacy one\n- alpha fact\n`);
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  });

  it("lists in readFactsFromMarkdown order, all removable", async () => {
    const facts = await listMemoryFacts(cwd);
    const raw = await readFactsFromMarkdown(cwd);
    expect(facts.map((f) => f.text)).toEqual(raw.map((f) => f.text));
    expect(facts).toHaveLength(4);
    expect(facts.every((f) => f.removable)).toBe(true);
  });

  it("removes a per-memory file and its index line", async () => {
    const [first] = await listMemoryFacts(cwd);
    const file = join(cwd, ".theokit", "memory", first?.id as string);
    expect(await removeMemoryFact(cwd, first?.id as string)).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(md(), "utf8")).not.toContain(`](${first?.id})`);
    expect(await listMemoryFacts(cwd)).toHaveLength(3);
  });

  it("removes one legacy bullet only, not the same text elsewhere", async () => {
    const legacy = (await listMemoryFacts(cwd)).filter((f) => f.id.startsWith("legacy-"));
    const target = legacy.find((f) => f.text === "alpha fact");
    expect(await removeMemoryFact(cwd, target?.id as string)).toBe(true);
    const after = readFileSync(md(), "utf8");
    expect(after).toContain("- legacy one");
    expect(after).not.toMatch(/^- alpha fact$/m);
    expect(after).toContain("](alpha-fact.md)");
    expect((await listMemoryFacts(cwd)).filter((f) => f.text === "alpha fact")).toHaveLength(1);
  });

  it("resolves false for an unknown id and changes nothing", async () => {
    const before = readFileSync(md(), "utf8");
    expect(await removeMemoryFact(cwd, "no-such-id")).toBe(false);
    expect(readFileSync(md(), "utf8")).toBe(before);
  });

  it("refuses to remove an entry from another root", async () => {
    const dir = claudeProjectMemoryDir(cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "cli-note.md"),
      "---\nname: cli-note\ndescription: cli-note\nmetadata:\n  node_type: memory\n  type: project\n---\n\nThe CLI fact.\n",
    );
    const cli = (await listMemoryFacts(cwd)).find((f) => f.text === "The CLI fact.");
    expect(cli?.removable).toBe(false);
    const err = await removeMemoryFact(cwd, "cli-note.md").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MemoryFactNotRemovableError);
    expect((err as MemoryFactNotRemovableError).factId).toBe("cli-note.md");
    expect((err as MemoryFactNotRemovableError).root).toBe(dir);
    expect(existsSync(join(dir, "cli-note.md"))).toBe(true);
  });
});
