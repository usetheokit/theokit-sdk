import {
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { jsonIdentityStore } from "../../src/a2a/index.js";
import { removeTempDirRobustSync } from "../helpers/temp-workspace.js";

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "a2a-id-"));
  onTestFinished(() => removeTempDirRobustSync(dir));
  return dir;
}

describe("jsonIdentityStore", () => {
  it("two concurrent first loads share one identity, file is 0600", async () => {
    const file = join(tmp(), "sub", "identity.json");
    const store = jsonIdentityStore(file);
    const [a, b] = await Promise.all([store.load(), store.load()]);
    expect(a.publicKey).toBe(b.publicKey);
    const fd = openSync(file, "r");
    try {
      expect(fstatSync(fd).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(fd, "utf8")).publicKey).toBe(a.publicKey);
    } finally {
      closeSync(fd);
    }
    expect(statSync(join(file, "..")).mode & 0o777).toBe(0o700);
    expect((await jsonIdentityStore(file).load()).publicKey).toBe(a.publicKey);
  });

  it("rejects a malformed file without replacing it", async () => {
    const file = join(tmp(), "identity.json");
    writeFileSync(file, "{}");
    await expect(jsonIdentityStore(file).load()).rejects.toThrow(/malformed/);
    expect(readFileSync(file, "utf8")).toBe("{}");
  });
});
