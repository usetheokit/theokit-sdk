import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { GenerationFileError } from "../src/errors.js";
import { jsonGenerations, memoryGenerations } from "../src/session-pool.js";
import { removeTempDirRobustSync } from "./helpers/temp-workspace.js";

const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "gens-"));
  onTestFinished(() => removeTempDirRobustSync(d));
  return d;
};

describe("generations", () => {
  it("memory counts per key", async () => {
    const g = memoryGenerations();
    expect(g.current("a")).toBe(0);
    expect(await g.next("a")).toBe(1);
    expect(g.current("b")).toBe(0);
  });

  it("json persists with mode 0600 and reloads", async () => {
    const file = join(dir(), "g.json");
    const g = jsonGenerations(file);
    await Promise.all([g.next("a"), g.next("a"), g.next("b")]);
    expect(g.current("a")).toBe(2);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      version: 1,
      generations: { a: 2, b: 1 },
    });
    expect(jsonGenerations(file).current("a")).toBe(2);
  });

  it("refuses a foreign file and leaves it untouched", () => {
    const file = join(dir(), "g.json");
    writeFileSync(file, '{"hello":1}');
    expect(() => jsonGenerations(file)).toThrow(GenerationFileError);
    expect(() => jsonGenerations(file)).toThrow(file);
    expect(readFileSync(file, "utf8")).toBe('{"hello":1}');
  });

  it("a failed write leaves current unchanged", async () => {
    const d = dir();
    const file = join(d, "sub", "g.json");
    const g = jsonGenerations(file);
    await g.next("a");
    // Replace the parent directory with a regular file: fails for root too.
    rmSync(join(d, "sub"), { recursive: true });
    writeFileSync(join(d, "sub"), "x");
    const failed = await g.next("a").then(
      () => false,
      () => true,
    );
    expect(failed).toBe(true);
    expect(g.current("a")).toBe(1);
  });
});
