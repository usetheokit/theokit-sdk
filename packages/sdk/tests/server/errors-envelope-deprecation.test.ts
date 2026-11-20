import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("../../src/server/errors-envelope.ts", import.meta.url), "utf8");

describe("errors-envelope deprecation", () => {
  it.each([
    "export type TheokitErrorCode",
    "export interface TheokitErrorEnvelope",
    "export function toEnvelope",
    "export function fromEnvelope",
    "export { MemoryAdapterError }",
  ])("%s carries @deprecated naming a replacement", (decl) => {
    const idx = src.indexOf(decl);
    expect(idx).toBeGreaterThan(-1);
    const doc = src.slice(src.lastIndexOf("/**", idx), idx);
    expect(doc).toContain("@deprecated");
    expect(doc).toMatch(/isRetryable|theokit\/server|from `@theokit\/sdk`/);
  });
});
