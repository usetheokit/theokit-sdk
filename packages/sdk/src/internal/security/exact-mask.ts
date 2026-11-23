/**
 * Exact-value masking: replaces known secret values (not patterns) in text, structured values and
 * Node writable streams. A plain factory with no global state.
 *
 * This module sits below `errors.ts` (which imports `redactSecrets`), so it cannot import
 * `ConfigurationError`; the caller passes `makeError` for the one failure it raises.
 */

export interface ExactMaskOptions {
  placeholder?: string;
  minLength?: number;
}

/** Shape returned by {@link createExactMask}; the public `ExactValueMask` mirrors it. */
export interface ExactValueMaskImpl {
  text(text: string): string;
  deep<T>(value: T): T;
  stream(): { push(delta: string): string; flush(): string };
  wrapStreams(streams: readonly NodeJS.WritableStream[]): MaskStreamsHandle;
}

/** Uninstall function returned by `wrapStreams`; `flush()` writes held text, masked, and keeps the mask installed. */
export interface MaskStreamsHandle {
  (): void;
  flush(): void;
}

const DEFAULT_PLACEHOLDER = "[redacted]";
const DEFAULT_MIN_LENGTH = 4;

/** Streams currently wrapped by any mask. A second wrap would mask twice and unwind out of order. */
const wrapped = new WeakSet<object>();

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Longest first, de-duplicated, short values dropped. */
function normalizeValues(values: readonly string[], minLength: number): string[] {
  const floor = Math.max(1, minLength);
  const kept = new Set<string>();
  for (const v of values) {
    if (typeof v === "string" && v.length >= floor) kept.add(v);
  }
  return [...kept].sort((a, b) => b.length - a.length);
}

interface Core {
  text(text: string): string;
  stream(): { push(delta: string): string; flush(): string };
}

function createCore(values: string[], placeholder: string): Core {
  if (values.length === 0) {
    return {
      text: (t) => t,
      stream: () => ({ push: (d) => d, flush: () => "" }),
    };
  }
  const source = values.map(escapeRegExp).join("|");
  const maxLen = values[0]?.length ?? 0;
  const text = (t: string): string => t.replace(new RegExp(source, "g"), () => placeholder);

  /** Smallest index >= from whose suffix is a proper prefix of some value (it may still grow). */
  const holdIndex = (buf: string, from: number): number => {
    for (let i = Math.max(from, buf.length - maxLen + 1); i < buf.length; i++) {
      const tail = buf.slice(i);
      if (values.some((v) => v.length > tail.length && v.startsWith(tail))) return i;
    }
    return buf.length;
  };

  const stream = () => {
    let held = "";
    return {
      push(delta: string): string {
        const buf = held + delta;
        const re = new RegExp(source, "g");
        let out = "";
        let pos = 0;
        for (;;) {
          const h = holdIndex(buf, pos);
          re.lastIndex = pos;
          const m = re.exec(buf);
          if (m && m.index < h) {
            out += buf.slice(pos, m.index) + placeholder;
            pos = m.index + m[0].length;
            continue;
          }
          out += buf.slice(pos, h);
          held = buf.slice(h);
          return out;
        }
      },
      flush(): string {
        const rest = text(held);
        held = "";
        return rest;
      },
    };
  };
  return { text, stream };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function deepMask(value: unknown, mask: (s: string) => string, seen: WeakMap<object, unknown>) {
  if (typeof value === "string") return mask(value);
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(deepMask(item, mask, seen));
    return copy;
  }
  if (!isPlainObject(value)) return value;
  const copy: Record<string, unknown> = Object.create(Object.getPrototypeOf(value));
  seen.set(value, copy);
  for (const [k, v] of Object.entries(value)) copy[k] = deepMask(v, mask, seen);
  return copy;
}

type AnyFn = (...args: unknown[]) => unknown;

function toBytes(chunk: unknown, encoding: unknown): Buffer | undefined {
  if (typeof chunk === "string") {
    return Buffer.from(chunk, typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8");
  }
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array)
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return undefined;
}

/** Wraps one stream. Bytes travel as latin1 so any encoding is masked byte-exact. */
function wrapOne(
  stream: NodeJS.WritableStream,
  core: Core,
): { uninstall: () => void; flush: () => void } {
  const target = stream as unknown as Record<string, AnyFn>;
  const ownWrite = Object.hasOwn(target, "write");
  const ownEnd = Object.hasOwn(target, "end");
  const origWrite = target.write as AnyFn;
  const origEnd = target.end as AnyFn;
  const masker = core.stream();
  const run = (bytes: Buffer): Buffer =>
    Buffer.from(masker.push(bytes.toString("latin1")), "latin1");

  target.write = function write(this: unknown, ...args: unknown[]): unknown {
    const bytes = toBytes(args[0], args[1]);
    if (!bytes) return origWrite.apply(stream, args);
    const cb = args.find((a) => typeof a === "function") as AnyFn | undefined;
    const out = run(bytes);
    // A write held back whole has nothing to hand the stream yet: its callback runs now,
    // before the bytes reach the stream.
    if (out.length === 0) {
      if (cb) process.nextTick(cb);
      return true;
    }
    return origWrite.call(stream, out, ...(cb ? [cb] : []));
  };
  target.end = function end(this: unknown, ...args: unknown[]): unknown {
    const cb = args.find((a) => typeof a === "function") as AnyFn | undefined;
    const bytes = toBytes(args[0], args[1]);
    const head = bytes ? run(bytes) : Buffer.alloc(0);
    const tail = Buffer.from(masker.flush(), "latin1");
    const all = Buffer.concat([head, tail]);
    const rest = cb ? [cb] : [];
    return all.length > 0 ? origEnd.call(stream, all, ...rest) : origEnd.call(stream, ...rest);
  };

  const flush = () => {
    const tail = Buffer.from(masker.flush(), "latin1");
    if (tail.length > 0) origWrite.call(stream, tail);
  };
  const uninstall = () => {
    const tail = Buffer.from(masker.flush(), "latin1");
    if (ownWrite) target.write = origWrite;
    else delete target.write;
    if (ownEnd) target.end = origEnd;
    else delete target.end;
    wrapped.delete(stream);
    if (tail.length > 0) origWrite.call(stream, tail);
  };
  return { uninstall, flush };
}

/** Build an exact-value masker; `makeError` builds the error thrown for an already-wrapped stream. */
export function createExactMask(
  values: readonly string[],
  options: ExactMaskOptions | undefined,
  makeError: (message: string) => Error,
): ExactValueMaskImpl {
  const placeholder = options?.placeholder ?? DEFAULT_PLACEHOLDER;
  const kept = normalizeValues(values, options?.minLength ?? DEFAULT_MIN_LENGTH);
  const core = createCore(kept, placeholder);
  // Byte-level twin for streams: values and placeholder as latin1 views of their UTF-8 bytes.
  const latin1 = (s: string) => Buffer.from(s, "utf8").toString("latin1");
  const byteCore = createCore(
    [...new Set(kept.map(latin1))].sort((a, b) => b.length - a.length),
    latin1(placeholder),
  );

  return {
    text: core.text,
    deep: <T>(value: T): T => deepMask(value, core.text, new WeakMap()) as T,
    stream: core.stream,
    wrapStreams(streams) {
      const seen = new Set<object>();
      streams.forEach((s, i) => {
        if (wrapped.has(s) || seen.has(s)) {
          throw makeError(`Security.createMask: streams[${i}] is already wrapped by a mask`);
        }
        seen.add(s);
      });
      const undo = streams.map((s) => {
        wrapped.add(s);
        return wrapOne(s, byteCore);
      });
      const handle = (() => {
        for (const u of undo.splice(0)) u.uninstall();
      }) as MaskStreamsHandle;
      handle.flush = () => {
        for (const u of undo) u.flush();
      };
      return handle;
    },
  };
}
