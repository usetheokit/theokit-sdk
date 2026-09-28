/**
 * A session with no readable transcript is an empty session, however the read failed.
 *
 * `readTranscript` already treats an ABSENT file as an empty transcript — a first turn has no file,
 * so that case is the common one. The guard is keyed on `code === "ENOENT"`, and a runtime with no
 * filesystem at all throws something with **no `code`**, so it fell through to `throw` and failed the
 * turn.
 *
 * Measured on 2026-09-28, and only findable because the stack survived the flattening (theokit B-323):
 *
 *     [theokit] agent turn failed (SDK_ERROR): [unenv] fs.readFile is not implemented yet!
 *       at createNotImplementedError (unenv/dist/runtime/_internal/utils.mjs:25:9)
 *       at readTranscript (…/@theokit/sdk/…)
 *       at FsSessionStore.readRecords
 *       at readSessionMessages
 *       at hydrateSession
 *       at LocalAgent.initialize
 *       at async createLocalAgent
 *
 * So every turn on Cloudflare Workers failed during `initialize`, before the model was reached,
 * because hydrating a session it never had reached for a file the platform has no way to hold.
 *
 * ## Why "no code" is the discriminator, and not a wider catch
 *
 * Inside this `try` the only call is `readFile`, and a real filesystem failure always carries a
 * `code`: `ENOENT`, `EACCES`, `EISDIR`, `EMFILE`. An error with NO code did not come from a
 * filesystem — it came from the absence of one. `unenv`'s `createNotImplementedError` returns a plain
 * `new Error(…)`, verified in its source, so there is no code to key on and no message to match
 * without depending on another package's wording.
 *
 * A bare `catch { return [] }` would also pass the case below and would swallow `EACCES` on a real
 * transcript — a permissions problem reported as an empty history, which is the silent-corruption
 * shape `rules/error-handling.md` refuses. The counterproofs pin that both ways.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

/**
 * `vi.mock`, not `vi.spyOn`: an ESM module namespace is not configurable, so spying on
 * `node:fs/promises` throws `Cannot redefine property: readFile` before a case runs.
 *
 * The mock DELEGATES to the real implementation unless a case installs a rejection, so the last case
 * can read a transcript that is genuinely on disk. A mock that always refused would make that case
 * assert against a reader nobody can use.
 */
let refuseWith: Error | undefined;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (refuseWith !== undefined) throw refuseWith;
      return actual.readFile(...args);
    },
  };
});

import { readTranscript } from "../src/internal/persistence/session-transcript.js";
import { removeTempDirRobustSync } from "./helpers/temp-workspace.js";

/** What a runtime with no filesystem throws: a plain Error, no `code`. */
function noFilesystemError(): Error {
  return new Error("[unenv] fs.readFile is not implemented yet!");
}

/** What a real filesystem throws when it refuses: an ErrnoException, always with a `code`. */
function errno(code: string): Error {
  return Object.assign(new Error(`${code}: refused`), { code });
}

describe("a transcript read survives no filesystem", () => {
  afterEach(() => {
    refuseWith = undefined;
  });

  it("returns an empty transcript when there is no filesystem at all", async () => {
    refuseWith = noFilesystemError();

    await expect(
      readTranscript("/session/whatever.jsonl"),
      "a runtime with no filesystem fails the whole turn during session hydration, before the " +
        "model is reached — and the session it was hydrating never existed",
    ).resolves.toEqual([]);
  });

  it("still returns empty for an absent file", async () => {
    // COUNTERPROOF: the pre-existing contract, which is the common case — a first turn has no
    // transcript. A fix that replaced the ENOENT branch rather than joining it would break it.
    refuseWith = errno("ENOENT");

    await expect(readTranscript("/gone.jsonl")).resolves.toEqual([]);
  });

  it("still throws when a real filesystem refuses", async () => {
    // THE counterproof. `catch { return [] }` passes the first case and reports a permissions
    // problem as an empty history — a real transcript silently replaced by nothing.
    for (const code of ["EACCES", "EISDIR", "EMFILE"]) {
      refuseWith = errno(code);
      await expect(
        readTranscript("/protected.jsonl"),
        `${code} was swallowed, so a real failure reads as an empty transcript`,
      ).rejects.toThrow(code);
    }
  });

  it("still parses a transcript that is actually there", async () => {
    // COUNTERPROOF against a fix that returns `[]` on every path: the reader must still read.
    const dir = mkdtempSync(join(tmpdir(), "sdk-transcript-"));
    // The repo's own lint test refuses a `mkdtemp` with no removal: every run would leak one
    // directory. `removeTempDirRobustSync` is the shared helper, whose retry policy is the one every
    // other suite uses.
    onTestFinished(() => removeTempDirRobustSync(dir));
    const path = join(dir, "s.jsonl");
    writeFileSync(
      path,
      `${JSON.stringify({ type: "user", uuid: "u1", timestamp: new Date().toISOString(), message: { role: "user", content: "hi" } })}\n`,
      "utf8",
    );

    expect((await readTranscript(path)).length).toBeGreaterThan(0);
  });
});
