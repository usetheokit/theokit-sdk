import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { ConfigurationError } from "../../src/index.js";
import { setDiagnosticsSink } from "../../src/internal/diagnostics.js";
import { persistMemoryFactIfWritePrompt } from "../../src/internal/local-agent/local-agent-runtime-extensions.js";
import { appendFactToMarkdown } from "../../src/internal/memory/storage/markdown-store.js";
import { projectMemoryDir } from "../../src/internal/memory/storage/memory-root.js";
import { legacyMemoryJsonPath, type MemoryFact } from "../../src/internal/memory/types.js";
import { appendMemoryFact } from "../../src/internal/runtime/memory-glue/memory-store.js";
import { removeTempDirRobust } from "../helpers/temp-workspace.js";

/*
 * B-380: a store with a declared fact ceiling refuses a new fact instead of growing past it, and
 * says what to consolidate. Before this, `maxFacts` did not exist, so every write landed and the
 * only cap anywhere (500 facts per dreaming sweep) dropped facts without telling anyone.
 *
 * Every refusal is asserted on both sides: the typed error AND the directory left as it was. An
 * implementation that throws after writing would pass a test that checks only the error.
 */

const SEEDS = [
  "the alpha service deploys on monday",
  "the beta queue retries five times",
  "the gamma cache expires hourly",
  "the delta worker runs nightly",
];

/** The prefix every ceiling refusal carries, used to count the diagnostic lines a refusal emits. */
const CEILING_MARKER = "its declared ceiling (maxFacts";

let cwd: string;
let dir: string;

/*
 * The ceiling travels on the memory settings and on the writer's options. Both are built here,
 * outside the call, so this file compiles against the declarations of the commit it runs on: the
 * point of the file is that it FAILS before the ceiling exists, not that it does not compile.
 */
const atCeiling = (maxFacts: number) => ({ enabled: true, directory: dir, maxFacts });
const withCeiling = (maxFacts: unknown) => ({
  enabled: true,
  directory: dir,
  maxFacts: maxFacts as number,
});
const writeFact: (
  cwd: string,
  fact: MemoryFact,
  targetDir: string,
  options: { maxFacts?: number },
) => Promise<void> = appendFactToMarkdown;

type Refusal = Error & { code?: string };
const unexpectedSuccess = (): never => {
  throw new Error("expected the write to be refused, and it was admitted");
};
const asRefusal = (e: unknown): Refusal => e as Refusal;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "memory-ceiling-"));
  dir = join(cwd, "store");
  onTestFinished(() => removeTempDirRobust(cwd));
});

async function seed(count: number, target: string = dir): Promise<void> {
  for (const text of SEEDS.slice(0, count)) await appendFactToMarkdown(cwd, { text }, target);
}

async function listFactFiles(target: string = dir): Promise<string[]> {
  const entries = await readdir(target).catch(() => [] as string[]);
  return entries.filter((e) => e.endsWith(".md") && e !== "MEMORY.md").sort();
}

/** Every entry of the directory and its bytes, so a refusal can be proven to have changed nothing. */
async function snapshot(target: string = dir): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const entries = await readdir(target).catch(() => [] as string[]);
  for (const entry of entries.sort()) out[entry] = await readFile(join(target, entry), "utf8");
  return out;
}

async function fileHolding(text: string): Promise<string> {
  for (const file of await listFactFiles()) {
    const raw = await readFile(join(dir, file), "utf8");
    if (raw.includes(text)) return file;
  }
  throw new Error(`no fact file holds "${text}"`);
}

describe("a declared memory ceiling on the markdown store", () => {
  let emitted: string[];

  beforeEach(() => {
    emitted = [];
    setDiagnosticsSink((m) => emitted.push(m));
  });
  afterEach(() => setDiagnosticsSink(undefined));

  const ceilingLines = (): string[] => emitted.filter((m) => m.includes(CEILING_MARKER));

  it("refuses a new fact at the ceiling and leaves the directory byte-identical", async () => {
    await seed(3);
    const snapshotBefore = await snapshot();
    const write = appendMemoryFact(cwd, atCeiling(3), { text: "a fourth fact" });
    await expect(write).rejects.toMatchObject({ code: "memory_ceiling_reached" });
    await expect(write).rejects.toBeInstanceOf(ConfigurationError);
    const snapshotAfter = await snapshot();
    expect(snapshotAfter).toEqual(snapshotBefore);
  });

  it("names the directory, the count and what to consolidate in the refusal", async () => {
    await seed(3);
    const err = await appendMemoryFact(cwd, atCeiling(3), { text: "a fourth fact" }).then(
      unexpectedSuccess,
      asRefusal,
    );
    expect(err.message).toContain(dir);
    expect(err.message).toContain("3 facts");
    expect(err.message).toContain("maxFacts");
    expect(err.message).toMatch(/merge or delete/);
  });

  it("admits a repeated fact at the ceiling as a second observation", async () => {
    await seed(3);
    const write = appendMemoryFact(cwd, atCeiling(3), { text: SEEDS[0] as string });
    await expect(write).resolves.toBeUndefined();
    const factFiles = await listFactFiles();
    expect(factFiles).toHaveLength(3);
    const first = await readFile(join(dir, await fileHolding(SEEDS[0] as string)), "utf8");
    expect(first).toContain("observations: 2");
  });

  it("stores every fact when no ceiling is declared", async () => {
    for (const text of [...SEEDS, "the epsilon job pages on failure"]) {
      await appendMemoryFact(cwd, { enabled: true, directory: dir }, { text });
    }
    const files = await listFactFiles(dir);
    expect(files).toHaveLength(5);
  });

  it("reports a prompt-driven refusal on exactly one diagFailure line and stores nothing", async () => {
    await seed(3);
    const settings = { enabled: true, directory: dir, maxFacts: 3 };
    await persistMemoryFactIfWritePrompt(cwd, settings, "Remember: a fourth fact");
    expect(ceilingLines()).toHaveLength(1);
    const factFiles = await listFactFiles();
    expect(factFiles).toHaveLength(3);
  });

  it("writes no diagFailure line for a prompt-driven write under the ceiling", async () => {
    await seed(1);
    const settings = { enabled: true, directory: dir, maxFacts: 3 };
    await persistMemoryFactIfWritePrompt(cwd, settings, "Remember: a second fact");
    expect(ceilingLines()).toHaveLength(0);
    const factFiles = await listFactFiles();
    expect(factFiles).toHaveLength(2);
  });

  it("refuses a ceiling that is not a positive integer", async () => {
    for (const value of [0, -1, 1.5, Number.NaN, "3", null] as unknown[]) {
      const write = appendMemoryFact(cwd, withCeiling(value), { text: "x" });
      const err = await write.then(unexpectedSuccess, asRefusal);
      expect(err).toBeInstanceOf(ConfigurationError);
      expect(err.code).toBe("invalid_memory_ceiling");
      expect(err.message).toContain(`got ${String(value)}`);
      expect(await readdir(dir).catch(() => [])).toEqual([]);
    }
  });

  it("ignores maxFacts while memory is disabled", async () => {
    const config = { ...withCeiling(0), enabled: false };
    const write = appendMemoryFact(cwd, config, { text: "x" });
    await expect(write).resolves.toBeUndefined();
    expect(await readdir(dir).catch(() => [])).toEqual([]);
  });

  it("admits exactly one of two concurrent writes at one below the ceiling", async () => {
    await seed(2);
    const results = await Promise.allSettled([
      writeFact(cwd, { text: "the x pipeline is green" }, dir, { maxFacts: 3 }),
      writeFact(cwd, { text: "the y pipeline is red" }, dir, { maxFacts: 3 }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "memory_ceiling_reached",
    });
    expect(await listFactFiles()).toHaveLength(3);
  });

  it("refuses a new fact when the store is already above its ceiling", async () => {
    await seed(4);
    const err = await appendMemoryFact(cwd, atCeiling(3), { text: "a fifth fact" }).then(
      unexpectedSuccess,
      asRefusal,
    );
    expect(err.code).toBe("memory_ceiling_reached");
    expect(err.message).toContain("4 facts");
  });

  it("counts legacy Facts bullets toward the ceiling", async () => {
    await seed(2);
    const indexPath = join(dir, "MEMORY.md");
    const index = await readFile(indexPath, "utf8");
    await writeFile(indexPath, `${index}\n## Facts\n\n- a legacy bullet somebody wrote by hand\n`);
    const err = await appendMemoryFact(cwd, atCeiling(3), { text: "a fourth fact" }).then(
      unexpectedSuccess,
      asRefusal,
    );
    expect(err.code).toBe("memory_ceiling_reached");
    expect(err.message).toContain("3 facts");
  });

  it("admits exactly one fact under a ceiling of 1", async () => {
    const config = atCeiling(1);
    const first = appendMemoryFact(cwd, config, { text: "the a service" });
    await expect(first).resolves.toBeUndefined();
    const second = appendMemoryFact(cwd, config, { text: "the b service" });
    await expect(second).rejects.toMatchObject({ code: "memory_ceiling_reached" });
    expect(await listFactFiles()).toHaveLength(1);
  });

  it("counts a write as new when the file under its name holds different text", async () => {
    await seed(3);
    const file = await fileHolding(SEEDS[0] as string);
    const path = join(dir, file);
    const raw = await readFile(path, "utf8");
    await writeFile(path, raw.replace(SEEDS[0] as string, "a body somebody rewrote by hand"));
    const write = appendMemoryFact(cwd, atCeiling(3), { text: SEEDS[0] as string });
    await expect(write).rejects.toMatchObject({ code: "memory_ceiling_reached" });
    expect(await listFactFiles()).toHaveLength(3);
  });

  it("refuses a write that would replace a hand-written note at the ceiling", async () => {
    await seed(3);
    const notePath = join(dir, "note.md");
    const noteBefore = "A note somebody wrote by hand, with no frontmatter.\n";
    await writeFile(notePath, noteBefore);
    // On the writer directly: `appendMemoryFact` forwards only text and kind, so a title passed
    // through it would never reach the name the writer resolves.
    const write = writeFact(cwd, { text: "x", title: "note" }, dir, { maxFacts: 3 });
    await expect(write).rejects.toMatchObject({ code: "memory_ceiling_reached" });
    expect(await readFile(notePath, "utf8")).toBe(noteBefore);
  });

  it.skipIf(process.getuid?.() === 0)(
    "refuses the write when a fact file cannot be read",
    async () => {
      await seed(2);
      const snapshotBefore = await snapshot();
      const unreadable = join(dir, await fileHolding(SEEDS[1] as string));
      await chmod(unreadable, 0o000);
      try {
        const write = appendMemoryFact(cwd, atCeiling(3), { text: "a third fact" });
        await expect(write).rejects.toMatchObject({ code: "EACCES" });
      } finally {
        await chmod(unreadable, 0o644);
      }
      const snapshotAfter = await snapshot();
      expect(snapshotAfter).toEqual(snapshotBefore);
    },
  );

  it("refuses an invalid ceiling before migrating a legacy JSON store", async () => {
    // The legacy JSON store only ever lived in the default root, so this test uses it.
    const config = { enabled: true, maxFacts: 0 };
    const jsonPath = legacyMemoryJsonPath(cwd, config);
    await mkdir(join(jsonPath, ".."), { recursive: true });
    const jsonBefore = JSON.stringify({
      facts: [{ text: "a legacy fact" }, { text: "another legacy fact" }],
    });
    await writeFile(jsonPath, jsonBefore);
    const write = appendMemoryFact(cwd, config, { text: "x" });
    await expect(write).rejects.toMatchObject({ code: "invalid_memory_ceiling" });
    expect(await readFile(jsonPath, "utf8")).toBe(jsonBefore);
    expect(existsSync(join(projectMemoryDir(cwd), "MEMORY.md"))).toBe(false);
  });
});
