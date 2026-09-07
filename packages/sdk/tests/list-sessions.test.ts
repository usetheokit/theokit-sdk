/**
 * #598 — the enumeration, and the provenance that makes it safe to act on.
 *
 * Two independent consumers rebuilt this listing in opposite directions and both derived the id from
 * the filename. One shipped a garbage collector that classified the LIVE session as an orphan,
 * because a set of session ids never matched a set of file stems.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { encodeProjectDir, listSessions, sessionUuidFor } from "../src/persistence.js";

const CWD = "/home/someone/project";
let base: string;
let dir: string;

function writeSession(id: string, extra = ""): string {
  const file = join(dir, `${sessionUuidFor(id)}.jsonl`);
  writeFileSync(
    file,
    `${JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, sessionId: id, timestamp: "2026-01-01T00:00:00Z" })}\n${extra}`,
  );
  return file;
}

describe("listSessions", () => {
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "theokit-list-"));
    dir = join(base, "projects", encodeProjectDir(CWD));
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("reads the id from inside the transcript, not from the filename", async () => {
    const file = writeSession("agent-42");

    const [entry] = await listSessions(CWD, { baseDir: base });

    expect(entry?.id).toBe("agent-42");
    expect(entry?.idSource).toBe("transcript");
    // The control that names the whole defect: the filename is a hash and is NOT the id.
    expect(basename(file, ".jsonl")).not.toBe("agent-42");
  });

  it("reports an unreadable id as unavailable rather than guessing it", async () => {
    // A garbage collector must tell "not registered" from "I could not read this" — in a plain list
    // those look identical and mean opposite things. This is the entry that caused the live session
    // to be classified an orphan downstream.
    writeFileSync(join(dir, "b0ffed00-0000-8000-8000-000000000000.jsonl"), "{ not json\n");

    const [entry] = await listSessions(CWD, { baseDir: base });

    expect(entry?.idSource).toBe("unavailable");
    expect(entry?.id).toBeUndefined();
  });

  it("skips a malformed leading line and still finds the id", async () => {
    const file = join(dir, `${sessionUuidFor("agent-7")}.jsonl`);
    writeFileSync(
      file,
      `not json at all\n${JSON.stringify({ type: "user", uuid: "u", parentUuid: null, sessionId: "agent-7", timestamp: "t" })}\n`,
    );

    expect((await listSessions(CWD, { baseDir: base }))[0]?.id).toBe("agent-7");
  });

  it("reports unavailable when the id lies beyond the scan budget", async () => {
    // Bounded work with a declared outcome, rather than an unbounded read of a growing transcript.
    writeSession("agent-far");

    const [entry] = await listSessions(CWD, { baseDir: base, idScanBytes: 8 });

    expect(entry?.idSource).toBe("unavailable");
  });

  it("returns every session, and only .jsonl files", async () => {
    writeSession("a");
    writeSession("b");
    writeFileSync(join(dir, "notes.txt"), "ignore me");

    const found = await listSessions(CWD, { baseDir: base });

    expect(found.map((s) => s.id).sort()).toEqual(["a", "b"]);
  });

  it("yields [] for a cwd with no sessions rather than throwing", async () => {
    // A project without sessions is the common case, not an error.
    expect(await listSessions("/no/such/place", { baseDir: base })).toEqual([]);
  });

  it("carries a modification time a caller can age out on", async () => {
    writeSession("agent-42");

    const [entry] = await listSessions(CWD, { baseDir: base });

    expect(entry?.modifiedAt).toBeInstanceOf(Date);
    expect(Number.isNaN(entry?.modifiedAt.getTime())).toBe(false);
  });
});
