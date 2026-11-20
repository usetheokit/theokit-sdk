import { describe, expect, it } from "vitest";
import { Security } from "../../src/index.js";

function rng(seed: number) {
  let x = seed;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

const values = ["abcd1234", "abcd1234ef", "zz99zz"];
const alphabet = ["a", "b", "c", "d", "1", "2", "3", "4", "e", "f", "z", "9", " "];

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)] as T;
}

function randomText(rand: () => number): string {
  let text = "";
  const len = Math.floor(rand() * 60);
  for (let i = 0; i < len; i++) text += pick(rand, rand() < 0.15 ? values : alphabet);
  return text;
}

function chunked(mask: ReturnType<typeof Security.createMask>, text: string, rand: () => number) {
  const s = mask.stream();
  const pieces: string[] = [];
  for (let i = 0; i < text.length; ) {
    const step = 1 + Math.floor(rand() * 7);
    pieces.push(s.push(text.slice(i, i + step)));
    i += step;
  }
  pieces.push(s.flush());
  return pieces;
}

describe("exact mask stream property", () => {
  it("push outputs plus flush equal text() and never leak a value", () => {
    const mask = Security.createMask(values);
    const rand = rng(42);
    for (let n = 0; n < 300; n++) {
      const text = randomText(rand);
      const pieces = chunked(mask, text, rand);
      for (const piece of pieces) expect(values.some((v) => piece.includes(v))).toBe(false);
      expect(pieces.join("")).toBe(mask.text(text));
    }
  });
});
