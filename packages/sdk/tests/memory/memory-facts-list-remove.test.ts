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
    expect(facts.map((f) => f.modified)).toEqual(raw.map((f) => f.modified));
    expect(new Set(facts.map((f) => f.id)).size).toBe(4);
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
    writeFileSync(md(), `${readFileSync(md(), "utf8")}\n## Notes\n- alpha fact\n`);
    const legacy = (await listMemoryFacts(cwd)).filter((f) => f.id.startsWith("legacy-"));
    const target = legacy.find((f) => f.text === "alpha fact");
    expect(await removeMemoryFact(cwd, target?.id as string)).toBe(true);
    const after = readFileSync(md(), "utf8");
    expect(after).toContain("- legacy one");
    // the only exact `- alpha fact` line left is the one under `## Notes`
    expect(after.match(/^- alpha fact$/gm)).toHaveLength(1);
    expect(after.slice(after.indexOf("## Notes"))).toContain("- alpha fact");
    expect(after).toContain("](alpha-fact.md)");
    expect((await listMemoryFacts(cwd)).filter((f) => f.text === "alpha fact")).toHaveLength(1);
  });

  it("keeps the newline before the next heading when the last bullet goes", async () => {
    writeFileSync(md(), "## Facts\n- only fact\n## Notes\n- n\n");
    const only = (await listMemoryFacts(cwd)).find((f) => f.text === "only fact");
    expect(await removeMemoryFact(cwd, only?.id as string)).toBe(true);
    expect(readFileSync(md(), "utf8")).toBe("## Facts\n\n## Notes\n- n\n");
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
    const err = await removeMemoryFact(cwd, cli?.id as string).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MemoryFactNotRemovableError);
    expect((err as MemoryFactNotRemovableError).factId).toBe(cli?.id);
    expect((err as MemoryFactNotRemovableError).root).toBe(dir);
    expect(existsSync(join(dir, "cli-note.md"))).toBe(true);
  });

  it("identical legacy bullets share an id; removal takes one", async () => {
    writeFileSync(md(), `${readFileSync(md(), "utf8")}- legacy one\n`);
    const dup = (await listMemoryFacts(cwd)).filter((f) => f.text === "legacy one");
    expect(dup).toHaveLength(2);
    expect(dup[0]?.id).toBe(dup[1]?.id);
    expect(await removeMemoryFact(cwd, dup[0]?.id as string)).toBe(true);
    expect((await listMemoryFacts(cwd)).filter((f) => f.text === "legacy one")).toHaveLength(1);
  });

  it("drops the removed entry's chunks from the sqlite index", async () => {
    const { IndexManager } = await import("../../src/internal/memory/index-manager.js");
    const index = await IndexManager.open({ cwd });
    await index.sync();
    expect((await index.search("alpha")).length).toBeGreaterThan(0);
    index.close();
    const target = (await listMemoryFacts(cwd)).find(
      (f) => f.text === "alpha fact" && !f.id.startsWith("legacy-"),
    );
    await removeMemoryFact(cwd, target?.id as string);
    const again = await IndexManager.open({ cwd });
    onTestFinished(() => again.close());
    expect((await again.search("beta")).length).toBeGreaterThan(0);
    await again.sync();
    expect(
      (await again.search("alpha")).every((h) => !h.path?.endsWith(target?.id as string)),
    ).toBe(true);
  });

  it("a same-named file in another root gets its own id and is not removed through the write root", async () => {
    const dir = claudeProjectMemoryDir(cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "alpha-fact.md"),
      "---\nname: alpha-fact\ndescription: alpha-fact\nmetadata:\n  node_type: memory\n  type: project\n---\n\nCLI alpha.\n",
    );
    const all = await listMemoryFacts(cwd);
    const own = all.find((f) => f.text === "alpha fact" && f.removable && f.id.endsWith(".md"));
    const cli = all.find((f) => f.text === "CLI alpha.");
    expect(own?.id).toBe("alpha-fact.md");
    expect(cli?.id).not.toBe(own?.id);
    const err = await removeMemoryFact(cwd, cli?.id as string).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MemoryFactNotRemovableError);
    expect(existsSync(join(cwd, ".theokit", "memory", "alpha-fact.md"))).toBe(true);
  });

  it("removing a legacy bullet leaves the other legacy facts searchable after the next sync", async () => {
    const { IndexManager } = await import("../../src/internal/memory/index-manager.js");
    writeFileSync(md(), `${readFileSync(md(), "utf8")}- zebra stripes\n`);
    const index = await IndexManager.open({ cwd });
    await index.sync();
    index.close();
    const target = (await listMemoryFacts(cwd)).find((f) => f.text === "legacy one");
    await removeMemoryFact(cwd, target?.id as string);
    const again = await IndexManager.open({ cwd });
    onTestFinished(() => again.close());
    await again.sync();
    expect((await again.search("zebra")).length).toBeGreaterThan(0);
    expect((await again.search("legacy")).length).toBe(0);
  });
});
