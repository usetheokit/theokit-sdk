import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readXwdHeader, XwdFormatError, XwdNotWrittenError, xwdToPng } from "../src/xwd.js";

const PIXELS: [number, number, number][] = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [16, 32, 64],
];

function build(opts: { bpp: 24 | 32; lsb: boolean; over?: Record<number, number> }): Buffer {
  const bpp = opts.bpp / 8;
  const bytesPerLine = 2 * bpp;
  const head = Buffer.alloc(100);
  const fields: Record<number, number> = {
    0: 100,
    1: 7,
    2: 2,
    3: 24,
    4: 2,
    5: 2,
    7: opts.lsb ? 0 : 1,
    11: opts.bpp,
    12: bytesPerLine,
    14: 0xff0000,
    15: 0xff00,
    16: 0xff,
    ...opts.over,
  };
  for (const [i, v] of Object.entries(fields)) head.writeUInt32BE(v, Number(i) * 4);
  const data = Buffer.alloc(bytesPerLine * 2);
  PIXELS.forEach(([r, g, b], i) => {
    const v = (r << 16) | (g << 8) | b;
    const at = Math.floor(i / 2) * bytesPerLine + (i % 2) * bpp;
    for (let k = 0; k < bpp; k++) data[at + k] = (v >>> (8 * (opts.lsb ? k : bpp - 1 - k))) & 0xff;
  });
  return Buffer.concat([head, data]);
}

function idatPixels(png: Buffer): number[] {
  let off = 8;
  const parts: Buffer[] = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    if (png.toString("ascii", off + 4, off + 8) === "IDAT")
      parts.push(png.subarray(off + 8, off + 8 + len));
    off += len + 12;
  }
  const raw = inflateSync(Buffer.concat(parts));
  return [...raw.subarray(1, 7), ...raw.subarray(8, 14)];
}

const EXPECTED = PIXELS.flat();

describe("xwdToPng", () => {
  it("decodes 32-bit LSB-first", () => {
    const r = xwdToPng(build({ bpp: 32, lsb: true }), "fb");
    expect([r.width, r.height]).toEqual([2, 2]);
    expect(idatPixels(r.png)).toEqual(EXPECTED);
  });
  it("decodes 24-bit MSB-first to the same pixels", () => {
    expect(idatPixels(xwdToPng(build({ bpp: 24, lsb: false }), "fb").png)).toEqual(EXPECTED);
  });
  it("rejects an oversized width by field and value", () => {
    const err = (() => {
      try {
        readXwdHeader(build({ bpp: 32, lsb: true, over: { 4: 16385 } }), "fb");
      } catch (e) {
        return e as XwdFormatError;
      }
    })();
    expect(err).toBeInstanceOf(XwdFormatError);
    expect(err?.field).toBe("width");
    expect(err?.value).toBe(16385);
  });
  it("raises XwdNotWrittenError when the header exceeds the bytes read", () => {
    const bytes = build({ bpp: 32, lsb: true, over: { 0: 300 } }).subarray(0, 200);
    expect(() => readXwdHeader(bytes, "fb")).toThrow(XwdNotWrittenError);
  });
  it("raises XwdNotWrittenError for truncated pixel data", () => {
    const bytes = build({ bpp: 32, lsb: true });
    expect(() => xwdToPng(bytes.subarray(0, 110), "fb")).toThrow(XwdNotWrittenError);
  });
  it("rejects a non-ZPixmap format", () => {
    expect(() => readXwdHeader(build({ bpp: 32, lsb: true, over: { 2: 1 } }), "fb")).toThrow(
      expect.objectContaining({ name: "XwdFormatError", field: "pixmap_format" }),
    );
  });
});
