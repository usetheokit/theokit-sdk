import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { decide } from "../src/decide.js";
import { removeTempDirRobustSync } from "./helpers/temp-workspace.js";

// Minimal protobuf writer: enough to hand-build a real ONNX model (Cast -> MatMul).
const varint = (n: number): number[] => {
  const out: number[] = [];
  let v = n;
  while (v > 127) {
    out.push((v & 127) | 128);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
};
const field = (no: number, wire: number, body: number[]) => [...varint(no * 8 + wire), ...body];
const vint = (no: number, n: number) => field(no, 0, varint(n));
const bytesF = (no: number, b: number[]) => field(no, 2, [...varint(b.length), ...b]);
const str = (no: number, s: string) => bytesF(no, [...Buffer.from(s)]);
const valueInfo = (name: string, elem: number, dims: number[]) => [
  ...str(1, name),
  ...bytesF(
    2,
    bytesF(1, [
      ...vint(1, elem),
      ...bytesF(
        2,
        dims.flatMap((d) => bytesF(1, vint(1, d))),
      ),
    ]),
  ),
];
const node = (op: string, ins: string[], outs: string[], attrs: number[][] = []) => [
  ...ins.flatMap((i) => str(1, i)),
  ...outs.flatMap((o) => str(2, o)),
  ...str(4, op),
  ...attrs.flatMap((a) => bytesF(5, a)),
];

function buildModel(): Buffer {
  // logits = float(input_ids) . W, W = [[0,4],[4,0],[0,0]]
  const w = Buffer.alloc(24);
  for (const [i, f] of [0, 4, 4, 0, 0, 0].entries()) w.writeFloatLE(f, i * 4);
  const init = [...vint(1, 3), ...vint(1, 2), ...vint(2, 1), ...str(8, "W"), ...bytesF(9, [...w])];
  const graph = [
    ...bytesF(
      1,
      node("Cast", ["input_ids"], ["f"], [[...str(1, "to"), ...vint(3, 1), ...vint(20, 2)]]),
    ),
    ...bytesF(1, node("MatMul", ["f", "W"], ["logits"])),
    ...str(2, "g"),
    ...bytesF(5, init),
    ...bytesF(11, valueInfo("input_ids", 7, [1, 3])),
    ...bytesF(11, valueInfo("attention_mask", 7, [1, 3])),
    ...bytesF(12, valueInfo("logits", 1, [1, 2])),
  ];
  return Buffer.from([...vint(1, 8), ...bytesF(7, graph), ...bytesF(8, vint(2, 13))]);
}

describe("decide with a real onnxruntime-node session", () => {
  it("answers spam/ham locally and sends no request", async () => {
    const bytes = buildModel();
    const dir = mkdtempSync(join(tmpdir(), "decide-onnx-"));
    onTestFinished(() => removeTempDirRobustSync(dir));
    const modelPath = join(dir, "m.onnx");
    writeFileSync(modelPath, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const tokenize = (t: string) => ({
      inputIds: [/prize/.test(t) ? 1 : 0, /hello/.test(t) ? 1 : 0, 0],
    });
    const labels = ["ham", "spam"] as const;
    const spam = await decide({ text: "claim your prize", labels, modelPath, sha256, tokenize });
    const ham = await decide({ text: "hello friend", labels, modelPath, sha256, tokenize });
    expect(spam.label).toBe("spam");
    expect(ham.label).toBe("ham");
    expect(spam.source).toBe("local-onnx");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
