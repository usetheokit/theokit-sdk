import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sessionSearchTool } from "@theokit/sdk-memory";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;

function line(
  sessionId: string,
  partition: string | undefined,
  role: string,
  text: string,
  at: string,
) {
  return JSON.stringify({
    type: role,
    uuid: `${sessionId}-${at}`,
    parentUuid: null,
    sessionId,
    timestamp: at,
    ...(partition !== undefined ? { memoryPartition: partition } : {}),
    message: { role, content: [{ type: "text", text }] },
  });
}

async function put(name: string, lines: string[]) {
  await mkdir(join(dir, "projects", "p"), { recursive: true });
  await writeFile(join(dir, "projects", "p", `${name}.jsonl`), `${lines.join("\n")}\n`);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "session-search-"));
  await put("telegram", [
    line("telegram", "u-1", "user", "My passport expires in March", "2026-11-17T10:00:00.000Z"),
    line("telegram", "u-2", "user", "passport secret of someone else", "2026-11-17T10:01:00.000Z"),
    line(
      "telegram",
      undefined,
      "user",
      "passport from an unmarked record",
      "2026-11-17T10:02:00.000Z",
    ),
  ]);
  await put("webchat", [line("webchat", "u-1", "user", "hello there", "2026-11-24T09:00:00.000Z")]);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("sessionSearchTool", () => {
  it("finds a turn of another session of the same partition, with session key and time", async () => {
    const tool = sessionSearchTool({
      transcriptsDir: dir,
      partition: "u-1",
      excludeSessionId: "webchat",
    });
    const hits = await tool.search("passport");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      sessionKey: "telegram",
      at: "2026-11-17T10:00:00.000Z",
      role: "user",
    });
    expect(hits[0]?.text).toContain("March");
  });

  it("never returns a turn of another partition or an unmarked record", async () => {
    const tool = sessionSearchTool({ transcriptsDir: dir, partition: "u-1" });
    const texts = (await tool.search("passport")).map((h) => h.text).join("|");
    expect(texts).not.toContain("someone else");
    expect(texts).not.toContain("unmarked");
    expect(
      await sessionSearchTool({ transcriptsDir: dir, partition: "u-3" }).search("passport"),
    ).toEqual([]);
  });

  it("picks up appended turns, drops deleted files, and runs as a tool", async () => {
    const tool = sessionSearchTool({ transcriptsDir: dir, partition: "u-1" });
    expect(await tool.search("umbrella")).toEqual([]);
    await put("later", [
      line("later", "u-1", "assistant", "Take an umbrella", "2026-11-20T08:00:00.000Z"),
    ]);
    const out = JSON.parse(await tool.execute({ query: "umbrella" })) as {
      hits: Array<{ sessionKey: string }>;
    };
    expect(out.hits.map((h) => h.sessionKey)).toEqual(["later"]);
    await rm(join(dir, "projects", "p", "later.jsonl"));
    expect(await tool.search("umbrella")).toEqual([]);
    expect(tool.name).toBe("session_search");
  });
});
