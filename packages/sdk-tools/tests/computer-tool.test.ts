import type { CustomTool } from "@theokit/sdk";
import { describe, expect, it } from "vitest";
import { type CreateComputerToolOptions, createComputerTool } from "../src/index.js";

/** A 4x3 32-bit LSB ZPixmap XWD dump. */
function xwd(width = 4, height = 3): Buffer {
  const head = Buffer.alloc(100);
  const f: Record<number, number> = {
    0: 100,
    1: 7,
    2: 2,
    3: 24,
    4: width,
    5: height,
    7: 0,
    11: 32,
    12: width * 4,
    14: 0xff0000,
    15: 0xff00,
    16: 0xff,
  };
  for (const [i, v] of Object.entries(f)) head.writeUInt32BE(v, Number(i) * 4);
  return Buffer.concat([head, Buffer.alloc(width * 4 * height)]);
}

type Call = { argv: string[]; env: Record<string, string> };

function setup(over: Partial<CreateComputerToolOptions> = {}) {
  const calls: Call[] = [];
  const tool: CustomTool = createComputerTool({
    display: ":99",
    framebuffer: "/fb",
    describe: async () => "a desktop",
    run: async (_file, argv, env) => {
      calls.push({ argv: [...argv], env });
      await new Promise((r) => setTimeout(r, 2));
      return argv[0] === "getmouselocation" ? "x:10 y:20 screen:0 window:1" : "";
    },
    readFile: () => xwd(),
    ...over,
  });
  return { tool, calls };
}

const call = (tool: CustomTool, input: unknown) =>
  tool.handler(input as never, {}) as Promise<string>;

describe("createComputerTool", () => {
  it("left_click moves, clicks, reads the pointer back, with a minimal env", async () => {
    const { tool, calls } = setup({ readFile: () => xwd(100, 100) });
    await call(tool, { action: "left_click", x: 10, y: 20 });
    expect(calls.map((c) => c.argv)).toEqual([
      ["mousemove", "10", "20"],
      ["click", "1"],
      ["getmouselocation"],
    ]);
    for (const c of calls) {
      expect(Object.keys(c.env).every((k) => ["DISPLAY", "PATH", "XAUTHORITY"].includes(k))).toBe(
        true,
      );
      expect(c.env.DISPLAY).toBe(":99");
    }
  });

  it("does not interleave two parallel left_clicks", async () => {
    const { tool, calls } = setup({ readFile: () => xwd(100, 100) });
    await Promise.all([
      call(tool, { action: "left_click", x: 1, y: 2 }),
      call(tool, { action: "left_click", x: 3, y: 4 }),
    ]);
    expect(calls.map((c) => c.argv[0])).toEqual([
      "mousemove",
      "click",
      "getmouselocation",
      "mousemove",
      "click",
      "getmouselocation",
    ]);
    expect(calls[0]?.argv).toEqual(["mousemove", "1", "2"]);
    expect(calls[3]?.argv).toEqual(["mousemove", "3", "4"]);
  });

  it("screenshot passes a PNG and size to describe", async () => {
    let seen: { png: Buffer; width: number; height: number; question?: string } | undefined;
    const { tool } = setup({
      describe: async (png, info) => {
        seen = { png, ...info };
        return "a desktop";
      },
    });
    const out = await call(tool, { action: "screenshot", question: "what?" });
    expect(out.startsWith("screen 4x3")).toBe(true);
    expect(out).toContain("a desktop");
    expect(seen?.png.subarray(1, 4).toString()).toBe("PNG");
    expect([seen?.width, seen?.height, seen?.question]).toEqual([4, 3, "what?"]);
  });

  it("type sends the text by argument vector", async () => {
    const { tool, calls } = setup();
    await call(tool, { action: "type", text: "hi; rm -rf" });
    expect(calls[0]?.argv).toEqual(["type", "--delay", "12", "--", "hi; rm -rf"]);
  });

  it("rejects text with a newline before run is called", async () => {
    const { tool, calls } = setup();
    await expect(call(tool, { action: "type", text: "a\nb" })).rejects.toThrow();
    await expect(call(tool, { action: "type", text: "a\u007fb" })).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("refuses x equal to the screen width, naming x and the width", async () => {
    const { tool, calls } = setup();
    await expect(call(tool, { action: "mouse_move", x: 4, y: 0 })).rejects.toThrow(
      /mouse_move.*x 4.*width 4/,
    );
    expect(calls).toEqual([]);
  });

  it("cuts a describe that never resolves at describeTimeoutMs", async () => {
    let aborted = false;
    const { tool } = setup({
      describeTimeoutMs: 20,
      describe: (_png, info) => {
        info.signal.addEventListener("abort", () => {
          aborted = true;
        });
        return new Promise<string>(() => {});
      },
    });
    await expect(call(tool, { action: "screenshot" })).rejects.toThrow(/screenshot.*timed out/);
    expect(aborted).toBe(true);
  });

  it("names the action and cause when xdotool fails, and keeps the queue alive", async () => {
    let n = 0;
    const { tool } = setup({
      run: async () => {
        if (n++ === 0) throw new Error("boom");
        return "x:1 y:1";
      },
    });
    await expect(call(tool, { action: "mouse_move", x: 1, y: 1 })).rejects.toThrow(
      /mouse_move.*boom/,
    );
    await expect(call(tool, { action: "mouse_move", x: 1, y: 1 })).resolves.toContain("pointer");
  });

  it("does not run a queued action whose caller already aborted", async () => {
    const { tool, calls } = setup();
    const ac = new AbortController();
    const first = call(tool, { action: "mouse_move", x: 1, y: 1 });
    const second = tool.handler({ action: "mouse_move", x: 2, y: 2 } as never, {
      signal: ac.signal,
    }) as Promise<string>;
    ac.abort();
    await first;
    await expect(second).rejects.toThrow(/aborted/);
    expect(calls.some((c) => c.argv[1] === "2")).toBe(false);
  });
});
