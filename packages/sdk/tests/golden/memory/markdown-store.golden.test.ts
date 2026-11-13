import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { resetMigrationStateForTests } from "../../../src/internal/memory/migration.js";
import {
  appendFactToMarkdown,
  memoryMdPath,
  readFactsFromMarkdown,
} from "../../../src/internal/memory/storage/markdown-store.js";
import { resolveMemoryRoot } from "../../../src/internal/memory/storage/memory-root.js";
import {
  appendMemoryFact,
  type MemoryConfig,
  readMemoryFacts,
} from "../../../src/internal/runtime/memory-glue/memory-store.js";
import { removeTempDirRobust } from "../../helpers/temp-workspace.js";

/**
 * Phase 1 T1.1 — Markdown corpus + migration + atomic writes + per-cwd mutex.
 */

const cfg: MemoryConfig = { enabled: true, namespace: "demo", scope: "agent", userId: "u1" };

describe("MarkdownMemoryStore", () => {
  let cwd: string;

  beforeEach(async () => {
    resetMigrationStateForTests();
    cwd = await mkdtemp(join(tmpdir(), "theokit-md-store-"));
    const __cwdCleanup1 = cwd;
    onTestFinished(async () => {
      await removeTempDirRobust(__cwdCleanup1);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("appendFact + readFacts round-trip writes MEMORY.md", async () => {
    await appendMemoryFact(cwd, cfg, { text: "magic-number is 8675309" });
    const facts = await readMemoryFacts(cwd, cfg);
    // A fact now carries `modified` (and `kind` when given), so the round-trip is asserted on the
    // text and the count rather than on object identity — the guarantee is "one fact in, the same
    // fact out", not the exact field set.
    expect(facts.map((f) => f.text)).toEqual(["magic-number is 8675309"]);
    expect(existsSync(memoryMdPath(resolveMemoryRoot(cwd)))).toBe(true);
  });

  it("multiple appends each get a file, and the index points at all of them", async () => {
    // Was "produce a clean bulleted list under ## Facts". The layout converged with the one the
    // Claude Code CLI reads — one file per memory, `MEMORY.md` as the index — so the shape this
    // asserts changed with it. What it PROTECTS is unchanged and is what is asserted here: three
    // appends neither clobber one another nor lose their order.
    await appendMemoryFact(cwd, cfg, { text: "fact A" });
    await appendMemoryFact(cwd, cfg, { text: "fact B" });
    await appendMemoryFact(cwd, cfg, { text: "fact C" });
    const raw = await readFile(memoryMdPath(resolveMemoryRoot(cwd)), "utf8");
    // `- [Title](slug.md) — hook`. The three share a topic name, so the second and third move
    // aside rather than overwrite — what this protects is that none of them is lost.
    expect(raw).toMatch(/— fact A[\s\S]*— fact B[\s\S]*— fact C/);
    const facts = await readMemoryFacts(cwd, cfg);
    expect(facts.map((f) => f.text)).toEqual(["fact A", "fact B", "fact C"]);
  });

  it("migration converts legacy JSON to markdown and deletes JSON", async () => {
    const jsonDir = join(cwd, ".theokit", "memory", "demo");
    await mkdir(jsonDir, { recursive: true });
    const jsonPath = join(jsonDir, "agent-u1.json");
    await writeFile(
      jsonPath,
      JSON.stringify({ facts: [{ text: "legacy A" }, { text: "legacy B" }] }),
    );
    const facts = await readMemoryFacts(cwd, cfg);
    expect(facts.map((f) => f.text)).toEqual(["legacy A", "legacy B"]);
    expect(existsSync(memoryMdPath(resolveMemoryRoot(cwd)))).toBe(true);
    expect(existsSync(jsonPath)).toBe(false);
  });

  it("migration is idempotent — second read does nothing", async () => {
    const jsonDir = join(cwd, ".theokit", "memory", "demo");
    await mkdir(jsonDir, { recursive: true });
    await writeFile(join(jsonDir, "agent-u1.json"), JSON.stringify({ facts: [{ text: "x" }] }));
    await readMemoryFacts(cwd, cfg);
    // Reset filesystem state but keep in-process migration flag. The store is a DIRECTORY now, not
    // a single file: the migrated fact lives in its own `x.md`, so overwriting `MEMORY.md` alone
    // would leave it behind and the assertion would be testing the fixture rather than migration.
    await rm(join(cwd, ".theokit", "memory"), { recursive: true, force: true });
    await mkdir(join(cwd, ".theokit", "memory"), { recursive: true });
    await writeFile(
      memoryMdPath(resolveMemoryRoot(cwd)),
      "# Memory\n\n## Facts\n\n- only-one\n",
      "utf8",
    );
    const facts = await readMemoryFacts(cwd, cfg);
    expect(facts.map((f) => f.text)).toEqual(["only-one"]);
  });

  it("migration skips and warns when both legacy JSON and MEMORY.md exist", async () => {
    const jsonDir = join(cwd, ".theokit", "memory", "demo");
    await mkdir(jsonDir, { recursive: true });
    const jsonPath = join(jsonDir, "agent-u1.json");
    await writeFile(jsonPath, JSON.stringify({ facts: [{ text: "json-fact" }] }));
    await mkdir(join(cwd, ".theokit", "memory"), { recursive: true });
    await writeFile(
      memoryMdPath(resolveMemoryRoot(cwd)),
      "# Memory\n\n## Facts\n\n- md-fact\n",
      "utf8",
    );
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const facts = await readMemoryFacts(cwd, cfg);
    // Markdown source wins; JSON is left intact.
    expect(facts.map((f) => f.text)).toEqual(["md-fact"]);
    expect(existsSync(jsonPath)).toBe(true);
    expect(stderr).toHaveBeenCalled();
  });

  it("redactSecrets is still applied before markdown write", async () => {
    await appendMemoryFact(cwd, cfg, {
      text: "token=sk-abcdef0123456789ghijklmn",
    });
    const raw = await readFile(memoryMdPath(resolveMemoryRoot(cwd)), "utf8");
    // T0.2 (ADR D68/D71): canonical redaction uses two-bucket masking —
    // long tokens keep prefix+suffix for debuggability instead of bare ***.
    // Security property under test is no-leak of the original secret.
    expect(raw).not.toContain("sk-abcdef0123456789ghijklmn");
    expect(raw).toMatch(/sk-[a-zA-Z0-9]{3}\.\.\.[a-zA-Z0-9]{4}/);
  });

  it("adds to an existing MEMORY.md without destroying what the user wrote (EC-5)", async () => {
    // EC-5's guarantee is that an append PRESERVES free-form content someone put in this file —
    // the header invites editing it by hand. That half is unchanged. What changed is the shape the
    // append adds: an index entry pointing at the memory's own file, not a `## Facts` bullet.
    await mkdir(join(cwd, ".theokit", "memory"), { recursive: true });
    const path = memoryMdPath(resolveMemoryRoot(cwd));
    await writeFile(path, "# Memory\n\nSome free-form content the user wrote.\n", "utf8");
    await appendFactToMarkdown(cwd, { text: "new fact" });
    const raw = await readFile(path, "utf8");
    expect(raw).toContain("Some free-form content the user wrote.");
    expect(raw).toContain("[New fact](new-fact.md) — new fact");
  });

  it("serializes concurrent appendFact calls (EC-4)", async () => {
    await Promise.all([
      appendFactToMarkdown(cwd, { text: "p1" }),
      appendFactToMarkdown(cwd, { text: "p2" }),
      appendFactToMarkdown(cwd, { text: "p3" }),
      appendFactToMarkdown(cwd, { text: "p4" }),
      appendFactToMarkdown(cwd, { text: "p5" }),
    ]);
    const facts = await readFactsFromMarkdown(cwd);
    expect(facts.map((f) => f.text).sort()).toEqual(["p1", "p2", "p3", "p4", "p5"]);
  });

  it("readMemoryFacts returns [] when memory disabled", async () => {
    const facts = await readMemoryFacts(cwd, { enabled: false });
    expect(facts).toEqual([]);
  });
});
