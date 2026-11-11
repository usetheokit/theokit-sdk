import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DecisionChecksumError, decide } from "../src/decide.js";

const bytes = Buffer.from("fake-onnx-model");
const sha = createHash("sha256").update(bytes).digest("hex");
const modelPath = join(mkdtempSync(join(tmpdir(), "decide-")), "m.onnx");
writeFileSync(modelPath, bytes);
const tokenize = () => ({ inputIds: [1, 2, 3] });

describe("decide", () => {
  it("returns a declared label without any network request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await decide({
      text: "WIN A PRIZE",
      labels: ["ham", "spam"] as const,
      modelPath,
      sha256: sha,
      tokenize,
      loadSession: async () => ({ run: async () => [0.1, 4] }),
    });
    expect(r.label).toBe("spam");
    expect(r.scores.spam).toBeGreaterThan(0.9);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a model whose checksum does not match", async () => {
    const loadSession = vi.fn();
    await expect(
      decide({
        text: "x",
        labels: ["a", "b"],
        modelPath,
        sha256: "0".repeat(64),
        tokenize,
        loadSession,
      }),
    ).rejects.toBeInstanceOf(DecisionChecksumError);
    expect(loadSession).not.toHaveBeenCalled();
  });
});
