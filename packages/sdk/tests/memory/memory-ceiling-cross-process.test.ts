import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFactToMarkdown } from "../../src/internal/memory/storage/markdown-store.js";
import { removeTempDirRobust } from "../helpers/temp-workspace.js";

/*
 * B-380 review round 2 (loop-code-review LCR0111): the ceiling's count and write were serialised
 * by `withCwdMutex`, which only orders callers inside one process. Every SDK process started in a
 * cwd shares `<cwd>/.theokit/memory`, so two processes one fact below the ceiling could both count,
 * both pass and both write, and the store ended over the ceiling it declared.
 *
 * These tests run REAL child processes against one directory. Each child loads the writer, says
 * `ready`, and blocks on stdin; the parent waits for every `ready` and then releases all of them
 * at once, so the writes contend without any guessed delay.
 */

const here = dirname(fileURLToPath(import.meta.url));
const writerSrc = resolve(here, "../../src/internal/memory/storage/markdown-store.ts");
// Same resolved-path use of the root `tsx` as tests/internal/persistence/file-lock-cross-process.test.ts.
const tsxBin = resolve(here, "../../../../node_modules/.bin/tsx");

/** One distinct leading word per writer, so no two writers' facts reduce to the same file name. */
const SUBJECTS = ["amber", "cobalt", "crimson", "indigo", "jade", "onyx"];
const WRITERS = SUBJECTS.length;
/** A store with many facts makes the count slower, which widens the window two writers race in. */
const MAX_FACTS = 30;

type Outcome = { ok: true } | { ok: false; code: string | undefined; message: string };

function childScript(cwd: string, dir: string, text: string, maxFacts: number | undefined): string {
  return `
    import { appendFactToMarkdown } from ${JSON.stringify(writerSrc)};
    process.stdout.write("ready\\n");
    process.stdin.once("data", async () => {
      let outcome;
      try {
        await appendFactToMarkdown(
          ${JSON.stringify(cwd)},
          { text: ${JSON.stringify(text)} },
          ${JSON.stringify(dir)},
          ${maxFacts === undefined ? "{}" : `{ maxFacts: ${maxFacts} }`},
        );
        outcome = { ok: true };
      } catch (e) {
        outcome = { ok: false, code: e?.code, message: String(e?.message ?? e) };
      }
      process.stdout.write("outcome " + JSON.stringify(outcome) + "\\n");
      process.exit(0);
    });
  `;
}

interface Writer {
  child: ChildProcess;
  ready: Promise<void>;
  outcome: Promise<Outcome>;
}

function startWriter(scriptPath: string): Writer {
  const child = spawn(tsxBin, [scriptPath], { stdio: ["pipe", "pipe", "inherit"] });
  let stdout = "";
  let markReady: () => void = () => undefined;
  const ready = new Promise<void>((r) => {
    markReady = r;
  });
  const outcome = new Promise<Outcome>((resolveOutcome, reject) => {
    child.on("error", reject);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes("ready\n")) markReady();
    });
    child.on("exit", (code) => {
      const line = stdout.split("\n").find((l) => l.startsWith("outcome "));
      if (line === undefined) {
        reject(new Error(`writer exited ${String(code)} without an outcome; stdout: ${stdout}`));
        return;
      }
      resolveOutcome(JSON.parse(line.slice("outcome ".length)) as Outcome);
    });
  });
  // A child that dies before `ready` must fail the test rather than hang it.
  void outcome.catch(() => markReady());
  return { child, ready, outcome };
}

async function runWritersTogether(
  maxFacts: number | undefined,
): Promise<{ outcomes: Outcome[]; facts: string[] }> {
  const writers: Writer[] = [];
  for (let i = 0; i < WRITERS; i += 1) {
    const script = join(cwd, `writer-${i}.mts`);
    await writeFile(
      script,
      childScript(cwd, dir, `${SUBJECTS[i]} pipeline retries a failed upload`, maxFacts),
    );
    writers.push(startWriter(script));
  }
  await Promise.all(writers.map((w) => w.ready));
  for (const w of writers) w.child.stdin?.write("go\n");
  const outcomes = await Promise.all(writers.map((w) => w.outcome));
  return { outcomes, facts: await listFactFiles() };
}

async function listFactFiles(): Promise<string[]> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  return entries.filter((e) => e.endsWith(".md") && e !== "MEMORY.md");
}

let cwd: string;
let dir: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "memory-ceiling-xproc-"));
  dir = join(cwd, "store");
  for (let i = 0; i < MAX_FACTS - 1; i += 1) {
    await appendFactToMarkdown(cwd, { text: `seeded fact ${i} about subject ${i}` }, dir);
  }
});

afterEach(async () => {
  await removeTempDirRobust(cwd);
});

describe("the memory ceiling across processes that share one directory", () => {
  it("admits exactly one of several processes writing one fact below the ceiling", async () => {
    const { outcomes, facts } = await runWritersTogether(MAX_FACTS);

    const admitted = outcomes.filter((o) => o.ok);
    const refused = outcomes.filter((o): o is Extract<Outcome, { ok: false }> => !o.ok);
    expect(admitted, "one write fits under the ceiling, so exactly one is admitted").toHaveLength(
      1,
    );
    expect(
      refused.map((o) => o.code),
      "every other writer is refused for the ceiling, not for a lock or any other failure",
    ).toEqual(Array.from({ length: WRITERS - 1 }, () => "memory_ceiling_reached"));
    expect(facts, "the store ends at its ceiling, never above it").toHaveLength(MAX_FACTS);
    const index = await readFile(join(dir, "MEMORY.md"), "utf8");
    expect(
      index.split("\n").filter((l) => l.startsWith("- [")),
      "the index agrees",
    ).toHaveLength(MAX_FACTS);
    expect(await readdir(cwd), "no lock is left behind once every writer exited").not.toContain(
      "store.lock",
    );
  }, 120_000);

  it("admits every writer when no ceiling is declared", async () => {
    const { outcomes, facts } = await runWritersTogether(undefined);

    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(facts).toHaveLength(MAX_FACTS - 1 + WRITERS);
    expect(await readdir(cwd), "a writer with no ceiling takes no lock").not.toContain(
      "store.lock",
    );
  }, 120_000);
});
