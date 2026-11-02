/**
 * `screenshot_logbook` — a captioned log of images that already exist inside the project root.
 *
 * `record` appends a reference entry (root-relative path, media type, size, caption, time) to a
 * JSON Lines log under `projectRoot`; `list` reads it back. The image is never copied and its bytes
 * are never read, so a `list` stays small in context. `view_image` shows a listed image.
 *
 * Return shape (always a JSON string):
 *   - `record`: `{ ok: true, entry, total }`
 *   - `list`:   `{ ok: true, entries, total }` (the last `limit` entries, oldest first)
 *   - `{ ok: false, error }` with `error` one of `invalid_input`, `path_traversal`,
 *     `caption_too_long`, `unsupported_image_type`, `image_not_found`, `empty_image`, `log_full`,
 *     `log_corrupt` (with the 1-based `line`), `write_failed` (the errno code only)
 *
 * No failure changes the log. A `record` rewrites the file through a temp file and a rename, and
 * `record` calls on one instance run one at a time, so concurrent calls in one turn each land once.
 *
 * Limits, accepted and stated:
 *   - Two processes (or two tool instances) writing one log are not serialised and can lose an entry.
 *   - The log is a journal of looks, not a set: recording the same image twice gives two entries.
 *   - Ids are positions (`entry count + 1`), not keys: a hand-edited log can repeat an id.
 *   - A trailing carriage return on a line is tolerated; a byte-order mark makes line 1 `log_corrupt`.
 *   - A symlink swapped in by another process between the confinement check and the rename is not
 *     caught (the same-user race the sibling tools leave open).
 *   - `write_failed` carries only the errno code, since a file-system message names host paths.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, posix, relative, resolve, sep } from "node:path";

import type { CustomTool } from "@theokit/sdk";
import { Tool } from "@theokit/sdk";
import { z } from "zod";

import { safePathJoin } from "./internal/path-guard.js";
import { checkPathScope, isForbiddenAtAnyDepth } from "./path-scope.js";

/** The image extensions `view_image` can show, mapped to their media type. A closed table, as there. */
const MEDIA_TYPES = new Map<string, string>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

/** Default ceiling on a caption, in UTF-16 code units. A default, not a measured limit. */
export const DEFAULT_MAX_CAPTION_CHARS = 500;

/** Default ceiling on the entries one log holds; it bounds the cost of each rewrite. A default. */
export const DEFAULT_MAX_ENTRIES = 1000;

const DEFAULT_LOG_PATH = "logbook/screenshots.jsonl";
const DEFAULT_LIST_LIMIT = 20;

/** One line of the log. `path` is root-relative with forward slashes; `recorded_at` is ISO 8601. */
const entrySchema = z.object({
  id: z.number(),
  path: z.string(),
  caption: z.string(),
  media_type: z.string(),
  bytes: z.number(),
  recorded_at: z.string(),
});

export type LogbookEntry = z.infer<typeof entrySchema>;

/** Options for {@link createScreenshotLogbookTool}. Only `projectRoot` is required. */
export interface CreateScreenshotLogbookToolOptions {
  /** Root every path is resolved inside. */
  projectRoot: string;
  /** The log file, relative to `projectRoot`. Omitted ⇒ `logbook/screenshots.jsonl`. Its directory is created when absent. */
  logPath?: string;
  /** Clock for `recorded_at`. Omitted ⇒ the system clock. */
  now?: () => Date;
  /** Name exposed to the model. Omitted ⇒ `screenshot_logbook`. */
  name?: string;
  /** Description exposed to the model. Omitted ⇒ the literal below. */
  description?: string;
  /** Longest caption. Omitted ⇒ {@link DEFAULT_MAX_CAPTION_CHARS}. A caption of exactly this length fits. */
  maxCaptionChars?: number;
  /** Most entries one log holds. Omitted ⇒ {@link DEFAULT_MAX_ENTRIES}. A record past it is `log_full`. */
  maxEntries?: number;
}

type LogbookFailure =
  | { ok: false; error: "invalid_input"; message: string }
  | { ok: false; error: "path_traversal"; path: string }
  | { ok: false; error: "path_traversal"; target: "log_path" }
  | { ok: false; error: "caption_too_long"; chars: number; max_chars: number }
  | { ok: false; error: "unsupported_image_type"; path: string; supported: string[] }
  | { ok: false; error: "image_not_found"; path: string }
  | { ok: false; error: "empty_image"; path: string }
  | { ok: false; error: "log_full"; max_entries: number }
  | { ok: false; error: "log_corrupt"; line: number }
  | { ok: false; error: "write_failed"; message: string };

/** The tool's result, before it is serialised to the JSON string the handler returns. */
export type ScreenshotLogbookResult =
  | { ok: true; entry: LogbookEntry; total: number }
  | { ok: true; entries: LogbookEntry[]; total: number }
  | LogbookFailure;

const inputSchema = z.object({
  action: z.enum(["record", "list"]).describe("'record' adds an entry; 'list' reads the log."),
  path: z.string().optional().describe("record: the image path, relative to the project root."),
  caption: z.string().optional().describe("record: what the image shows."),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`list: how many of the latest entries to return. Default ${DEFAULT_LIST_LIMIT}.`),
});

type LogbookInput = z.infer<typeof inputSchema>;

/** What one `record` call needs once its input is accepted. */
type ImageToRecord = Omit<LogbookEntry, "id" | "recorded_at">;

/** The log as read: its parsed entries and its exact text, so a rewrite keeps every existing byte. */
interface LogContents {
  entries: LogbookEntry[];
  text: string;
}

interface LogbookConfig {
  projectRoot: string;
  logPath: string;
  logFile: string;
  now: () => Date;
  maxCaptionChars: number;
  maxEntries: number;
}

const json = (result: ScreenshotLogbookResult): string => JSON.stringify(result);

const LOG_PATH_REFUSAL: LogbookFailure = { ok: false, error: "path_traversal", target: "log_path" };

/** The errno code of a file-system failure: its message would hand the model the host's absolute paths. */
const errorCode = (err: unknown): string => (err as { code?: string }).code ?? "unknown";

const isFailure = (value: object): value is LogbookFailure => "ok" in value;

/** A ceiling of zero, a negative, a fraction or NaN would build a tool that refuses everything or nothing. */
function requirePositiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(
      `createScreenshotLogbookTool: ${name} must be a positive integer, got ${value}`,
    );
  }
  return value;
}

/**
 * The log path's refusal, or undefined when the tool may use it. Its own refusal, without the
 * path: the log path is the consumer's configuration, not something the model chose.
 */
function refuseLogPath(config: LogbookConfig): LogbookFailure | undefined {
  if (checkPathScope(config.logPath, config.projectRoot) !== null) return LOG_PATH_REFUSAL;
  return isForbiddenAtAnyDepth(rootRelative(config.logPath, config.projectRoot))
    ? LOG_PATH_REFUSAL
    : undefined;
}

/**
 * A path already accepted by `checkPathScope`, relative to the root with forward slashes. The secret
 * guard reads this form, so the directories above the root (an absolute path's ancestors) never trip it.
 */
function rootRelative(path: string, projectRoot: string): string {
  return relative(resolve(projectRoot), safePathJoin(projectRoot, path)).split(sep).join("/");
}

/** The image's root-relative posix path, or the refusal. The secret guard reads the relative path,
 *  so directories above the root never trip it. */
function confineImage(path: string, projectRoot: string): string | LogbookFailure {
  const refusal: LogbookFailure = { ok: false, error: "path_traversal", path };
  if (checkPathScope(path, projectRoot) !== null) return refusal;
  const relativePath = rootRelative(path, projectRoot);
  return isForbiddenAtAnyDepth(relativePath) ? refusal : relativePath;
}

/** The media type and size of an image that exists as a non-empty regular file, or the failure. */
async function inspectImage(
  relativePath: string,
  projectRoot: string,
): Promise<{ media_type: string; bytes: number } | LogbookFailure> {
  const mediaType = MEDIA_TYPES.get(extname(relativePath).toLowerCase());
  if (mediaType === undefined) {
    const supported = [...MEDIA_TYPES.keys()];
    return { ok: false, error: "unsupported_image_type", path: relativePath, supported };
  }
  const info = await stat(safePathJoin(projectRoot, relativePath)).catch(() => undefined);
  if (info === undefined || !info.isFile()) {
    return { ok: false, error: "image_not_found", path: relativePath };
  }
  if (info.size === 0) return { ok: false, error: "empty_image", path: relativePath };
  return { media_type: mediaType, bytes: info.size };
}

/** Checks a `record` input in the documented order, up to (not including) the log. */
async function acceptRecord(
  input: LogbookInput,
  config: LogbookConfig,
): Promise<ImageToRecord | LogbookFailure> {
  const { path, caption } = input;
  if (!path) return { ok: false, error: "invalid_input", message: "record needs a path" };
  if (!caption?.trim())
    return { ok: false, error: "invalid_input", message: "record needs a caption" };
  if (caption.length > config.maxCaptionChars) {
    return {
      ok: false,
      error: "caption_too_long",
      chars: caption.length,
      max_chars: config.maxCaptionChars,
    };
  }
  const relativePath = confineImage(path, config.projectRoot);
  if (typeof relativePath !== "string") return relativePath;
  const refusedLog = refuseLogPath(config);
  if (refusedLog !== undefined) return refusedLog;
  const image = await inspectImage(relativePath, config.projectRoot);
  if (isFailure(image)) return image;
  return { path: relativePath, caption, ...image };
}

/** Parses the log text line by line; the first line that is not an entry is `log_corrupt`. */
function parseLog(text: string): LogContents | LogbookFailure {
  const entries: LogbookEntry[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "") continue;
    const entry = parseEntry(line);
    if (entry === undefined) return { ok: false, error: "log_corrupt", line: index + 1 };
    entries.push(entry);
  }
  return { entries, text };
}

function parseEntry(line: string): LogbookEntry | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  const parsed = entrySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** A missing log is an empty one; any other read error is `write_failed` with its errno code. */
async function readLog(logFile: string): Promise<LogContents | LogbookFailure> {
  let text: string;
  try {
    text = await readFile(logFile, "utf8");
  } catch (err) {
    const code = errorCode(err);
    if (code === "ENOENT") return { entries: [], text: "" };
    return { ok: false, error: "write_failed", message: code };
  }
  return parseLog(text);
}

/**
 * Writes the text through a temp file in the target's own directory and a rename, so a reader
 * never sees a partial log. A failure removes the temp file and rethrows.
 *
 * Local rather than `replaceFileAtomic`, which does not create its directory (as in `text_to_speech`).
 */
async function writeAtomic(target: string, text: string): Promise<void> {
  const temp = `${dirname(target)}/.${basename(target)}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, text, { flag: "wx", mode: 0o600 });
    await rename(temp, target);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}

/** Creates the log directory, re-checks it for a symlink escape, then rewrites the log with the new line. */
async function appendEntry(
  config: LogbookConfig,
  log: LogContents,
  entry: LogbookEntry,
): Promise<LogbookFailure | undefined> {
  try {
    await mkdir(dirname(config.logFile), { recursive: true });
    // Checked again now that the directory exists: it narrows, and does not close, the window in
    // which another process could swap a symlink in (see the limits above).
    const refused = refuseLogPath(config);
    if (refused !== undefined) return refused;
    const separator = log.text === "" || log.text.endsWith("\n") ? "" : "\n";
    await writeAtomic(config.logFile, `${log.text}${separator}${JSON.stringify(entry)}\n`);
    return undefined;
  } catch (err) {
    return { ok: false, error: "write_failed", message: errorCode(err) };
  }
}

/**
 * Never rejects: an unexpected throw (a consumer clock that throws, a guard's file-system error) is
 * `write_failed` with its errno code, so the caller always gets a typed result and the instance queue
 * keeps running.
 */
async function record(
  input: LogbookInput,
  config: LogbookConfig,
): Promise<ScreenshotLogbookResult> {
  try {
    return await recordOrThrow(input, config);
  } catch (err) {
    return { ok: false, error: "write_failed", message: errorCode(err) };
  }
}

async function recordOrThrow(
  input: LogbookInput,
  config: LogbookConfig,
): Promise<ScreenshotLogbookResult> {
  const image = await acceptRecord(input, config);
  if (isFailure(image)) return image;
  const log = await readLog(config.logFile);
  if (isFailure(log)) return log;
  if (log.entries.length >= config.maxEntries) {
    return { ok: false, error: "log_full", max_entries: config.maxEntries };
  }
  const entry: LogbookEntry = {
    id: log.entries.length + 1,
    ...image,
    recorded_at: config.now().toISOString(),
  };
  const failed = await appendEntry(config, log, entry);
  return failed ?? { ok: true, entry, total: log.entries.length + 1 };
}

async function list(
  limit: number | undefined,
  config: LogbookConfig,
): Promise<ScreenshotLogbookResult> {
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) {
    return { ok: false, error: "invalid_input", message: "limit must be a positive integer" };
  }
  const refused = refuseLogPath(config);
  if (refused !== undefined) return refused;
  const log = await readLog(config.logFile);
  if (isFailure(log)) return log;
  const count = Math.min(limit ?? DEFAULT_LIST_LIMIT, config.maxEntries);
  return { ok: true, entries: log.entries.slice(-count), total: log.entries.length };
}

function resolveConfig(opts: CreateScreenshotLogbookToolOptions): LogbookConfig {
  const logPath = posix.normalize((opts.logPath ?? DEFAULT_LOG_PATH).replace(/\\/g, "/"));
  return {
    projectRoot: opts.projectRoot,
    logPath,
    logFile: resolve(opts.projectRoot, logPath),
    now: opts.now ?? (() => new Date()),
    maxCaptionChars: requirePositiveInteger(
      "maxCaptionChars",
      opts.maxCaptionChars ?? DEFAULT_MAX_CAPTION_CHARS,
    ),
    maxEntries: requirePositiveInteger("maxEntries", opts.maxEntries ?? DEFAULT_MAX_ENTRIES),
  };
}

/**
 * Build the `screenshot_logbook` tool over a log under `projectRoot`.
 *
 * Order of checks for `record`: the required fields, the caption length, the image path, the log
 * path, the media table, the file itself, then the log (corrupt, full) and the write. `list` checks
 * the log path, then reads.
 */
export function createScreenshotLogbookTool(opts: CreateScreenshotLogbookToolOptions): CustomTool {
  const config = resolveConfig(opts);
  // One `record` at a time per instance: two in one turn would both read the same log and one entry
  // would be lost. `record` never rejects, so a failed call never poisons the chain.
  let queue: Promise<unknown> = Promise.resolve();

  return Tool.create({
    name: opts.name ?? "screenshot_logbook",
    description:
      opts.description ??
      "Keep a captioned log of screenshots and other images in the project. action 'record' adds " +
        "an image that already exists (path relative to the project root, png/jpeg/gif/webp) with a " +
        "caption; action 'list' returns the most recent entries. Returns JSON with { ok, entry, total } " +
        "or { ok, entries, total }, or { ok: false, error }. Use view_image to look at a listed path.",
    inputSchema,
    handler: async (input: LogbookInput): Promise<string> => {
      if (input.action === "list") return json(await list(input.limit, config));
      const run = () => record(input, config);
      const next = queue.then(run, run);
      queue = next;
      return json(await next);
    },
  });
}
