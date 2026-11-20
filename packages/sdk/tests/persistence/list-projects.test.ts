/** #1079 — listProjects: which cwd each projects/<encoded>/ folder belongs to, read from transcripts. */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent, type AgentOptions, ConfigurationError } from "../../src/index.js";
import {
  encodeProjectDir,
  listProjects,
  listSessions,
  sessionUuidFor,
} from "../../src/persistence.js";

const KEY = "sk-or-stub-0000000000";
const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

function record(cwd: string, sessionId: string): string {
  return `${JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, sessionId, cwd, timestamp: "2026-01-01T00:00:00Z" })}\n`;
}

describe("listProjects", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "theokit-projects-"));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  function writeTranscript(cwd: string, id: string, content = record(cwd, id), folder = cwd) {
    const dir = join(base, "projects", encodeProjectDir(folder));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${sessionUuidFor(id)}.jsonl`);
    writeFileSync(file, content);
    return file;
  }

  it("returns [] and creates nothing when projects/ is absent", async () => {
    expect(await listProjects({ baseDir: base })).toEqual([]);
    expect(readdirSync(base)).toEqual([]);
  });

  it("lists a folder holding only an empty transcript as unavailable", async () => {
    writeTranscript("/x/y", "s1", "");
    const [p] = await listProjects({ baseDir: base });
    expect(p?.cwdSource).toBe("unavailable");
    expect(p?.cwd).toBeUndefined();
    expect(p?.sessionCount).toBe(1);
    expect(p?.encoded).toBe(encodeProjectDir("/x/y"));
  });

  it("flags two transcripts that disagree on cwd and reports the newest", async () => {
    const older = writeTranscript("/a-b", "s1", record("/a-b", "s1"), "/a/b");
    writeTranscript("/a/b", "s2", record("/a/b", "s2"));
    const past = new Date(Date.now() - 60_000);
    const { utimesSync } = await import("node:fs");
    utimesSync(older, past, past);
    const [p] = await listProjects({ baseDir: base });
    expect(p?.cwdConflict).toBe(true);
    expect(p?.cwd).toBe("/a/b");
    expect(p?.sessionCount).toBe(2);
  });

  it("sets no conflict when transcripts agree", async () => {
    writeTranscript("/a/b", "s1");
    writeTranscript("/a/b", "s2");
    const [p] = await listProjects({ baseDir: base });
    expect(p?.cwdConflict).toBeUndefined();
    expect(p?.cwd).toBe("/a/b");
  });

  it("finds a cwd that sits in a later record, within the scan budget only", async () => {
    const noCwd = `${JSON.stringify({ sessionId: "s1" })}\n`;
    writeTranscript("/p", "s1", noCwd + record("/p", "s1"));
    expect((await listProjects({ baseDir: base }))[0]?.cwd).toBe("/p");
    const [small] = await listProjects({ baseDir: base, idScanBytes: noCwd.length });
    expect(small?.cwdSource).toBe("unavailable");
    const [session] = await listSessions("/p", { baseDir: base });
    expect(session?.cwd).toBe("/p");
    expect(session?.id).toBe("s1");
  });

  it("rejects idScanBytes below 1", async () => {
    await expect(listProjects({ baseDir: base, idScanBytes: 0 })).rejects.toThrow(
      ConfigurationError,
    );
    await expect(listProjects({ baseDir: base, idScanBytes: 0 })).rejects.toThrow(/idScanBytes/);
  });
});

describe("listProjects after real agent turns", () => {
  let stub: Server;
  let home: string;
  const dirs: string[] = [];
  const previous = process.env.THEOKIT_HOME;

  beforeEach(async () => {
    stub = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.setHeader("content-type", "text/event-stream");
        res.write(sse({ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] }));
        res.write(sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((r) => stub.listen(0, "127.0.0.1", () => r()));
    const addr = stub.address();
    if (typeof addr !== "object" || addr === null) throw new Error("bind failed");
    process.env.OPENROUTER_API_KEY = KEY;
    process.env.OPENROUTER_API_BASE_URL = `http://127.0.0.1:${String(addr.port)}`;
    home = mkdtempSync(join(tmpdir(), "theokit-projects-home-"));
    process.env.THEOKIT_HOME = home;
  });
  afterEach(async () => {
    await new Promise<void>((r) => stub.close(() => r()));
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_BASE_URL;
    if (previous === undefined) delete process.env.THEOKIT_HOME;
    else process.env.THEOKIT_HOME = previous;
    for (const d of [home, ...dirs.splice(0)]) rmSync(d, { recursive: true, force: true });
  });

  it("reports both cwds from the transcripts", async () => {
    for (const n of [1, 2]) {
      const cwd = mkdtempSync(join(tmpdir(), `theokit-projects-cwd${String(n)}-`));
      dirs.push(cwd);
      const agent = await Agent.create({
        agentId: `projects-${String(n)}-${Math.random().toString(36).slice(2, 8)}`,
        apiKey: KEY,
        model: { id: "stub/model" },
        providers: { routes: [{ capability: "chat", provider: "openrouter" }] },
        local: { cwd },
      } as AgentOptions);
      await (await agent.send("hello")).wait();
      await agent.dispose();
    }
    const listed = await listProjects({ baseDir: home });
    expect(listed.map((p) => p.cwd).sort()).toEqual([...dirs].sort());
    expect(listed.every((p) => p.cwdSource === "transcript")).toBe(true);
    expect(existsSync(join(home, "projects"))).toBe(true);
  });
});
