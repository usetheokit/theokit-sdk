/**
 * `computer` — look at an X11 screen, move the pointer, click and type, through `xdotool`.
 *
 * Guards: `xdotool` runs by argument vector (never a shell) with a 5 s timeout, the run's abort
 * signal and an environment of only `DISPLAY`, `PATH` and `XAUTHORITY` (the last two when set);
 * `type` text has no control character (a newline would press Return in the focused window);
 * coordinates are checked against the screen size in the Xvfb framebuffer header; pointer and
 * typing actions share one queue so parallel calls cannot interleave on the single pointer; the
 * screenshot is decoded with bounded allocation and described by the injected `describe` callback,
 * which is cut at `describeTimeoutMs`. A failure is thrown as an `Error` naming the action and the
 * cause, which the SDK returns to the model as a tool error.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

import type { CustomTool } from "@theokit/sdk";
import { Tool } from "@theokit/sdk";
import { z } from "zod";

import { readXwdHeader, xwdToPng } from "./xwd.js";

const XDOTOOL_TIMEOUT_MS = 5000;
const DEFAULT_DESCRIBE_TIMEOUT_MS = 60_000;
const TYPE_DELAY_MS = "12";

/** Options for {@link createComputerTool}. */
export interface CreateComputerToolOptions {
  /** Value of `DISPLAY` passed to `xdotool`. */
  display: string;
  /** Path of the Xvfb XWD framebuffer file (`-fbdir`). */
  framebuffer: string;
  /** `xdotool` binary path. Omitted ⇒ `"xdotool"`. */
  xdotool?: string;
  /** Turns a PNG into text for the model; the app wires a vision model here. */
  describe(
    png: Buffer,
    info: { width: number; height: number; question?: string; signal: AbortSignal },
  ): Promise<string>;
  /** Longest wait for `describe`, in ms. Omitted ⇒ 60000. */
  describeTimeoutMs?: number;
  /** Test seam: runs a command by argument vector and resolves its stdout. */
  run?: (
    file: string,
    argv: readonly string[],
    env: Record<string, string>,
    signal?: AbortSignal,
  ) => Promise<string>;
  /** Test seam: reads the framebuffer file. */
  readFile?: (path: string) => Buffer;
}

const inputSchema = z.object({
  action: z.enum(["screenshot", "mouse_move", "left_click", "type"]),
  x: z.number().int().min(0).optional().describe("Pixel column, for mouse_move and left_click."),
  y: z.number().int().min(0).optional().describe("Pixel row, for mouse_move and left_click."),
  text: z
    .string()
    .min(1)
    .max(500)
    // No character below U+0020 and no U+007F: a newline would press Return in the focused window.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the control range is the point
    .regex(/^[^\u0000-\u001f\u007f]+$/, "text must not contain control characters")
    .optional()
    .describe("Text to type, 1 to 500 characters, no control characters."),
  question: z.string().max(500).optional().describe("What to look for, for screenshot."),
});

type Input = z.infer<typeof inputSchema>;

const defaultRun = (
  file: string,
  argv: readonly string[],
  env: Record<string, string>,
  signal?: AbortSignal,
): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...argv],
      { env, timeout: XDOTOOL_TIMEOUT_MS, signal, encoding: "utf8" },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function minimalEnv(display: string): Record<string, string> {
  const env: Record<string, string> = { DISPLAY: display };
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.XAUTHORITY) env.XAUTHORITY = process.env.XAUTHORITY;
  return env;
}

function need(action: string, name: string, value: number | undefined): number {
  if (value === undefined) throw new Error(`computer ${action}: ${name} is required`);
  return value;
}

/** Bounded wait for `describe`: aborts its signal and rejects at the timeout. */
async function describeBounded(
  options: CreateComputerToolOptions,
  png: Buffer,
  info: { width: number; height: number; question?: string },
  outer: AbortSignal | undefined,
): Promise<string> {
  const timeoutMs = options.describeTimeoutMs ?? DEFAULT_DESCRIBE_TIMEOUT_MS;
  const controller = new AbortController();
  const onOuter = () => controller.abort();
  outer?.addEventListener("abort", onOuter, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`computer screenshot: description timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      options.describe(png, { ...info, signal: controller.signal }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuter);
  }
}

/**
 * Create the `computer` tool for an X11 desktop (Xvfb with `-fbdir`, plus `xdotool`).
 *
 * @example
 * createComputerTool({ display: ":99", framebuffer: "/tmp/fb/Xvfb_screen0", describe })
 */
export function createComputerTool(options: CreateComputerToolOptions): CustomTool {
  const xdotool = options.xdotool ?? "xdotool";
  const run = options.run ?? defaultRun;
  const readFile = options.readFile ?? ((p: string) => readFileSync(p));
  const env = minimalEnv(options.display);
  let queue: Promise<unknown> = Promise.resolve();

  const readFramebuffer = (action: string): Buffer => {
    try {
      return readFile(options.framebuffer);
    } catch (err) {
      throw new Error(`computer ${action}: cannot read framebuffer: ${messageOf(err)}`);
    }
  };

  const screenSize = (action: string): { width: number; height: number } => {
    try {
      const { width, height } = readXwdHeader(readFramebuffer(action), options.framebuffer);
      return { width, height };
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("computer ")) throw err;
      throw new Error(`computer ${action}: cannot read screen size: ${messageOf(err)}`);
    }
  };

  const xdo = async (action: string, argv: string[], signal?: AbortSignal): Promise<string> => {
    try {
      return (await run(xdotool, argv, env, signal)).trim();
    } catch (err) {
      throw new Error(`computer ${action}: xdotool ${argv[0]} failed: ${messageOf(err)}`);
    }
  };

  const checkPoint = (action: string, x: number, y: number): void => {
    const { width, height } = screenSize(action);
    if (x >= width)
      throw new Error(`computer ${action}: x ${x} is outside the screen width ${width}`);
    if (y >= height)
      throw new Error(`computer ${action}: y ${y} is outside the screen height ${height}`);
  };

  const pointer = async (input: Input, signal?: AbortSignal): Promise<string> => {
    const { action } = input;
    const x = need(action, "x", input.x);
    const y = need(action, "y", input.y);
    checkPoint(action, x, y);
    await xdo(action, ["mousemove", String(x), String(y)], signal);
    if (action === "left_click") await xdo(action, ["click", "1"], signal);
    const where = await xdo(action, ["getmouselocation"], signal);
    return `${action} done; pointer at ${where}`;
  };

  const typeText = async (input: Input, signal?: AbortSignal): Promise<string> => {
    if (input.text === undefined) throw new Error("computer type: text is required");
    await xdo("type", ["type", "--delay", TYPE_DELAY_MS, "--", input.text], signal);
    return `typed ${input.text.length} characters`;
  };

  /** Serialises input actions: one at a time, and a caller aborted while queued never runs. */
  const enqueue = (task: () => Promise<string>, signal?: AbortSignal): Promise<string> => {
    const result = queue.then(() => {
      if (signal?.aborted) throw new Error("computer: aborted before it started");
      return task();
    });
    queue = result.catch(() => undefined);
    return result;
  };

  const decodeScreen = (): ReturnType<typeof xwdToPng> => {
    try {
      return xwdToPng(readFramebuffer("screenshot"), options.framebuffer);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("computer ")) throw err;
      throw new Error(`computer screenshot: cannot decode framebuffer: ${messageOf(err)}`);
    }
  };

  const screenshot = async (input: Input, signal?: AbortSignal): Promise<string> => {
    const { png, width, height } = decodeScreen();
    const info = { width, height, question: input.question };
    try {
      const text = await describeBounded(options, png, info, signal);
      return `screen ${width}x${height}\n${text}`;
    } catch (err) {
      if (messageOf(err).startsWith("computer screenshot:")) throw err;
      throw new Error(`computer screenshot: description failed: ${messageOf(err)}`);
    }
  };

  return Tool.create({
    name: "computer",
    description:
      "Use the X11 desktop: screenshot (describes the screen, optional question), mouse_move and " +
      "left_click (integer x, y inside the screen), type (text, 1 to 500 characters, no control " +
      "characters). Actions run one at a time.",
    inputSchema,
    handler: (input, ctx) => {
      const signal = ctx?.signal;
      if (input.action === "screenshot") return screenshot(input, signal);
      if (input.action === "type") return enqueue(() => typeText(input, signal), signal);
      return enqueue(() => pointer(input, signal), signal);
    },
  });
}
