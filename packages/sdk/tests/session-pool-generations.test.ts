import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GenerationFileError } from "../src/errors.js";
import { jsonGenerations, memoryGenerations } from "../src/session-pool.js";

const dir = () => mkdtempSync(join(tmpdir(), "gens-"));

describe("generation stores", () => {
  it("memory counts up per key", async () => {
    const g = memoryGenerations();
    expect(g.current("a")).toBe(0);
    expect(await g.next("a")).toBe(1);
    expect(g.current("b")).toBe(0);
  });

  it("json persists with mode 0600 and survives reopen; concurrent next is serial", async () => {
    const file = join(dir(), "g.json");
    const g = jsonGenerations(file);
    const nums = await Promise.all([g.next("a"), g.next("a"), g.next("b")]);
    expect(nums).toEqual([1, 2, 1]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      version: 1,
      generations: { a: 2, b: 1 },
    });
    expect(jsonGenerations(file).current("a")).toBe(2);
  });

  it.each([
    "{}",
    '{"version":2,"generations":{}}',
    "not json",
    '{"version":1,"generations":[]}',
  ])("refuses a foreign file %s and leaves it alone", (body) => {
    const file = join(dir(), "g.json");
    writeFileSync(file, body);
    let err: unknown;
    try {
      jsonGenerations(file);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GenerationFileError);
    expect((err as Error).message).toContain(file);
    expect(readFileSync(file, "utf8")).toBe(body);
  });

  it("a failed write leaves current unchanged", async () => {
    const d = dir();
    const file = join(d, "g.json");
    const g = jsonGenerations(file);
    await g.next("a");
    // A directory where the file lives makes the rename fail on any user, root included.
    const blocked = join(d, "sub", "g.json");
    const g2 = jsonGenerations(blocked);
    writeFileSync(join(d, "sub"), "i am a file, not a directory");
    await expect(g2.next("a")).rejects.toThrow();
    expect(g2.current("a")).toBe(0);
    expect(g.current("a")).toBe(1);
    chmodSync(file, 0o600);
  });
});
