import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it, onTestFinished } from "vitest";

import { Agent } from "../../src/index.js";

import { appendFact, readFacts } from "../../src/internal/memory/storage/markdown-store.js";
import {
  projectMemoryDir,
  resolveMemoryRoot,
} from "../../src/internal/memory/storage/memory-root.js";
import type { MemoryFact } from "../../src/internal/memory/types.js";
import {
  blockStop,
  messageStart,
  messageStop,
  textBlockStart,
  textDelta,
  toolBlockStart,
  toolInputDelta,
} from "../helpers/anthropic-sse.js";
import { removeTempDirRobustSync } from "../helpers/temp-workspace.js";

function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "mem-user-"));
  onTestFinished(() => removeTempDirRobustSync(dir));
  return dir;
}

const fact = (text: string): MemoryFact => ({ text, createdAt: Date.now() }) as MemoryFact;

describe("memory.userId isolates facts (#1025)", () => {
  it("one user's facts are not read by another user sharing the cwd", async () => {
    const cwd = tempCwd();
    const a = { enabled: true, userId: "a" };
    const b = { enabled: true, userId: "b" };
    await appendFact(cwd, a, fact("alice likes violet tea"));
    expect((await readFacts(cwd, a)).map((f) => f.text).join("\n")).toContain("violet tea");
    expect(await readFacts(cwd, b)).toEqual([]);
  });

  it("without userId, facts under <cwd>/.theokit/memory are still read", async () => {
    const cwd = tempCwd();
    const plain = { enabled: true };
    // A store written before this change: a hand-made file under <cwd>/.theokit/memory.
    const legacyDir = join(cwd, ".theokit", "memory");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, "legacy-fact.md"),
      "---\nname: legacy-fact\ndescription: shared project fact\n---\nshared project fact\n",
    );
    writeFileSync(
      join(legacyDir, "MEMORY.md"),
      "- [legacy-fact](legacy-fact.md) — shared project fact\n",
    );
    expect(resolveMemoryRoot(cwd, plain)).toBe(projectMemoryDir(cwd));
    expect((await readFacts(cwd, plain)).map((f) => f.text).join("\n")).toContain("shared project");
    // a user partition does not fall back to the shared store
    expect(await readFacts(cwd, { enabled: true, userId: "a" })).toEqual([]);
  });

  it("userId is confined to the memory root", () => {
    const cwd = tempCwd();
    // "../x" is not a legal identifier: it is rejected (invalid_identifier), never joined into a path.
    expect(() => resolveMemoryRoot(cwd, { enabled: true, userId: "../x" })).toThrow(
      expect.objectContaining({ code: "invalid_identifier" }),
    );
    // Mixed case is lowercased; the result stays directly under <root>/users.
    const upper = resolveMemoryRoot(cwd, { enabled: true, userId: "Alice_1" });
    expect(relative(projectMemoryDir(cwd), upper)).toBe(join("users", "alice_1"));
    const root = resolveMemoryRoot(cwd, { enabled: true, userId: "alice" });
    expect(relative(projectMemoryDir(cwd), root)).toBe(join("users", "alice"));
  });
});

describe("agents with different memory.userId sharing a cwd (#1025)", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server?.close(() => r()));
    server = undefined;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_BASE_URL;
  });

  /** Replies with a memory_search tool call first, then text; records every request body. */
  async function stub(): Promise<Array<Record<string, unknown>>> {
    const bodies: Array<Record<string, unknown>> = [];
    server = createServer((req, res) => {
      let buf = "";
      req.on("data", (c: Buffer) => {
        buf += c.toString("utf8");
      });
      req.on("end", () => {
        const body = JSON.parse(buf) as { messages: Array<{ content: unknown }> };
        bodies.push(body);
        const sawResult = JSON.stringify(body.messages).includes("tool_result");
        const wantsSearch = JSON.stringify(body.messages).includes("search your memory");
        res.setHeader("content-type", "text/event-stream");
        if (wantsSearch && !sawResult) {
          res.write(
            messageStart() +
              toolBlockStart("toolu_1", "memory_search") +
              toolInputDelta('{"query":"tea"}') +
              blockStop() +
              messageStop("tool_use"),
          );
        } else {
          res.write(
            messageStart() + textBlockStart() + textDelta("ok") + blockStop() + messageStop(),
          );
        }
        res.end();
      });
    });
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    if (typeof addr !== "object" || addr === null) throw new Error("bind failed");
    process.env.ANTHROPIC_API_KEY = "sk-stub";
    process.env.ANTHROPIC_API_BASE_URL = `http://127.0.0.1:${addr.port}`;
    return bodies;
  }

  const make = (cwd: string, userId: string) =>
    Agent.create({
      apiKey: `user-${userId}`,
      model: { id: "claude-sonnet-4-6" },
      local: { cwd, settingSources: ["project"] },
      memory: { enabled: true, userId },
    });

  it("b's <memory> block and memory_search do not return a's fact", async () => {
    const cwd = tempCwd();
    const bodies = await stub();
    const a = await make(cwd, "a");
    await (await a.send("Remember: alice likes violet tea.")).wait();
    await a.dispose();

    // control: a's own agent recalls it in its <memory> block
    const aAgain = await make(cwd, "a");
    await (await aAgain.send("hello")).wait();
    await aAgain.dispose();
    const aSystem = JSON.stringify(bodies.at(-1)?.system);
    expect(aSystem).toContain("<memory>");
    expect(aSystem).toContain("violet tea");

    const before = bodies.length;
    const b = await make(cwd, "b");
    await (await b.send("please search your memory for tea")).wait();
    await b.dispose();
    const bBodies = bodies.slice(before);
    expect(bBodies.length).toBeGreaterThanOrEqual(2); // the search round-trip happened
    for (const body of bBodies) expect(JSON.stringify(body)).not.toContain("violet");
    expect(JSON.stringify(bBodies.at(-1)?.messages)).toContain("tool_result");
  });
});

describe("legacy JSON migration honours memory.userId (#1025)", () => {
  it("migrates a user's legacy facts into that user's partition, not the shared root", async () => {
    const cwd = tempCwd();
    const cfg = { enabled: true, namespace: "demo", scope: "agent" as const, userId: "u1" };
    const jsonDir = join(cwd, ".theokit", "memory", "demo");
    mkdirSync(jsonDir, { recursive: true });
    writeFileSync(
      join(jsonDir, "agent-u1.json"),
      JSON.stringify({ facts: [{ text: "legacy A" }] }),
    );
    const { migrateLegacyJson, resetMigrationStateForTests } = await import(
      "../../src/internal/memory/migration.js"
    );
    resetMigrationStateForTests();
    expect((await migrateLegacyJson(cwd, cfg)).migrated).toBe(true);
    expect((await readFacts(cwd, cfg)).map((f) => f.text)).toEqual(["legacy A"]);
    expect(await readFacts(cwd, { enabled: true })).toEqual([]);
    expect(await readFacts(cwd, { enabled: true, userId: "u2" })).toEqual([]);
  });
});
