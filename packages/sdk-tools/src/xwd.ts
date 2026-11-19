/**
 * Decode an X Window Dump (the framebuffer file Xvfb keeps under `-fbdir`)
 * into a PNG, with every allocation bounded by limits checked on the header
 * before any pixel buffer exists.
 */
import { crc32, deflateSync } from "node:zlib";

/** Parsed fields of an XWD header that a ZPixmap framebuffer needs. */
export interface XwdHeader {
  width: number;
  height: number;
  bitsPerPixel: number;
  bytesPerLine: number;
  dataOffset: number;
  lsbFirst: boolean;
  masks: readonly [number, number, number];
}

/** A header field is unsupported or outside `XWD_LIMITS`; names the file, field and value. */
export class XwdFormatError extends Error {
  readonly path: string;
  readonly field: string;
  readonly value: number;
  constructor(path: string, field: string, value: number, detail = "is not supported") {
    super(`${path}: XWD ${field} ${value} ${detail}`);
    this.name = new.target.name;
    this.path = path;
    this.field = field;
    this.value = value;
  }
}

/** The header or pixel data is larger than the bytes read: Xvfb may still be writing; retry. */
export class XwdNotWrittenError extends XwdFormatError {}

/** Upper bounds enforced on an untrusted header before any allocation. */
export const XWD_LIMITS = {
  maxHeaderBytes: 4096,
  maxSide: 16384,
  maxPixels: 33554432,
  maxColors: 65536,
};

const MIN_HEADER_BYTES = 100;
const COLOR_ENTRY_BYTES = 12;
const ZPIXMAP = 2;

function ensureRange(path: string, field: string, value: number, min: number, max: number): void {
  if (value < min || value > max) {
    throw new XwdFormatError(path, field, value, `is outside ${min}..${max}`);
  }
}

/** Validate and parse the XWD header in `bytes` without allocating pixel buffers. */
export function readXwdHeader(bytes: Uint8Array, path: string): XwdHeader {
  if (bytes.length < MIN_HEADER_BYTES) {
    throw new XwdNotWrittenError(
      path,
      "header_size",
      bytes.length,
      "bytes read is below the minimum header",
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const f = (index: number): number => view.getUint32(index * 4, false);
  const headerSize = f(0);
  ensureRange(path, "header_size", headerSize, MIN_HEADER_BYTES, XWD_LIMITS.maxHeaderBytes);
  if (headerSize > bytes.length) {
    throw new XwdNotWrittenError(
      path,
      "header_size",
      headerSize,
      `exceeds the ${bytes.length} bytes read`,
    );
  }
  if (f(2) !== ZPIXMAP) throw new XwdFormatError(path, "pixmap_format", f(2), "is not ZPixmap");
  const width = f(4);
  const height = f(5);
  ensureRange(path, "width", width, 1, XWD_LIMITS.maxSide);
  ensureRange(path, "height", height, 1, XWD_LIMITS.maxSide);
  if (width * height > XWD_LIMITS.maxPixels) {
    throw new XwdFormatError(path, "pixels", width * height, `exceeds ${XWD_LIMITS.maxPixels}`);
  }
  const bitsPerPixel = f(11);
  if (bitsPerPixel !== 24 && bitsPerPixel !== 32) {
    throw new XwdFormatError(path, "bits_per_pixel", bitsPerPixel, "is not 24 or 32");
  }
  const bytesPerLine = f(12);
  if (bytesPerLine < width * (bitsPerPixel / 8)) {
    throw new XwdFormatError(path, "bytes_per_line", bytesPerLine, "is smaller than one row");
  }
  const colors = f(19);
  ensureRange(path, "ncolors", colors, 0, XWD_LIMITS.maxColors);
  return {
    width,
    height,
    bitsPerPixel,
    bytesPerLine,
    dataOffset: headerSize + colors * COLOR_ENTRY_BYTES,
    lsbFirst: f(7) === 0,
    masks: [f(14), f(15), f(16)],
  };
}

function channelExtractor(mask: number): (pixel: number) => number {
  if (mask === 0) return () => 0;
  let shift = 0;
  while (((mask >>> shift) & 1) === 0) shift++;
  const max = mask >>> shift;
  return (pixel) => Math.round((((pixel & mask) >>> shift) * 255) / max);
}

function readPixel(data: Uint8Array, at: number, bytesPerPixel: number, lsbFirst: boolean): number {
  let value = 0;
  for (let i = 0; i < bytesPerPixel; i++) {
    const byte = data[lsbFirst ? at + bytesPerPixel - 1 - i : at + i] as number;
    value = value * 256 + byte;
  }
  return value;
}

function toRgb(bytes: Uint8Array, h: XwdHeader): Buffer {
  const bpp = h.bitsPerPixel / 8;
  const [r, g, b] = h.masks.map(channelExtractor) as [
    (p: number) => number,
    (p: number) => number,
    (p: number) => number,
  ];
  const rgb = Buffer.alloc(h.width * h.height * 3);
  let out = 0;
  for (let y = 0; y < h.height; y++) {
    const row = h.dataOffset + y * h.bytesPerLine;
    for (let x = 0; x < h.width; x++) {
      const pixel = readPixel(bytes, row + x * bpp, bpp, h.lsbFirst);
      rgb[out++] = r(pixel);
      rgb[out++] = g(pixel);
      rgb[out++] = b(pixel);
    }
  }
  return rgb;
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

function encodePng(rgb: Buffer, width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor RGB
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height); // filter byte 0 per row
  for (let y = 0; y < height; y++) {
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Decode an XWD (24/32-bit ZPixmap) into an RGB PNG; throws `XwdNotWrittenError` while the file is incomplete. */
export function xwdToPng(
  bytes: Uint8Array,
  path: string,
): { png: Buffer; width: number; height: number } {
  const header = readXwdHeader(bytes, path);
  const needed = header.dataOffset + header.bytesPerLine * header.height;
  if (bytes.length < needed) {
    throw new XwdNotWrittenError(
      path,
      "data_size",
      needed,
      `exceeds the ${bytes.length} bytes read`,
    );
  }
  const rgb = toRgb(bytes, header);
  return {
    png: encodePng(rgb, header.width, header.height),
    width: header.width,
    height: header.height,
  };
}
