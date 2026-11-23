import { describe, expect, it } from "vitest";
import { ConfigurationError, Security } from "../../src/index.js";

function fakeStream() {
  const chunks: Buffer[] = [];
  const s = {
    write(chunk: string | Buffer, ..._rest: unknown[]) {
      chunks.push(Buffer.from(chunk));
      return true;
    },
    end(chunk?: string | Buffer) {
      if (chunk) chunks.push(Buffer.from(chunk));
    },
  };
  return { s, out: () => Buffer.concat(chunks).toString("utf8") };
}

describe("Security.createMask", () => {
  it("masks the longest value first", () => {
    const m = Security.createMask(["abc12345", "abc12345678"]);
    expect(m.text("x abc12345678 y")).toBe("x [redacted] y");
  });

  it("deep-masks nested strings and keeps the shape", () => {
    const m = Security.createMask(["abc12345"]);
    expect(m.deep({ a: ["k abc12345"], n: 1 })).toEqual({ a: ["k [redacted]"], n: 1 });
  });

  it("ignores values shorter than minLength", () => {
    const m = Security.createMask(["abc"]);
    expect(m.text("an abc here")).toBe("an abc here");
  });

  it("wrapStreams handle flush() writes held text masked and keeps masking", () => {
    const { s, out } = fakeStream();
    const undo = Security.createMask(["abc12345"]).wrapStreams([s as never]);
    s.write("key abc1");
    s.write("2345 and abc");
    undo.flush();
    expect(out()).toBe("key [redacted] and abc");
    s.write("12345 tail abc12");
    s.write("345");
    undo.flush();
    expect(out()).toBe("key [redacted] and abc12345 tail [redacted]");
    undo();
  });

  it("wrapStreams masks split writes and end(chunk), and uninstall restores write", () => {
    const { s, out } = fakeStream();
    const original = s.write;
    const undo = Security.createMask(["abc12345"]).wrapStreams([s as never]);
    expect(s.write).not.toBe(original);
    s.write("a abc12");
    s.write("345 b ");
    s.end("abc12345");
    expect(out()).toBe("a [redacted] b [redacted]");
    undo();
    expect(s.write).toBe(original);
  });

  it("uninstall flushes held bytes", () => {
    const { s, out } = fakeStream();
    const undo = Security.createMask(["abc12345"]).wrapStreams([s as never]);
    s.write("tail abc1");
    undo();
    expect(out()).toBe("tail abc1");
  });

  it("throws ConfigurationError naming the stream index on a second wrap", () => {
    const a = fakeStream().s;
    const b = fakeStream().s;
    const m = Security.createMask(["abc12345"]);
    const undo = m.wrapStreams([a as never]);
    expect(() => m.wrapStreams([b as never, a as never])).toThrow(ConfigurationError);
    expect(() => m.wrapStreams([b as never, a as never])).toThrow(/streams\[1\]/);
    undo();
  });
});
