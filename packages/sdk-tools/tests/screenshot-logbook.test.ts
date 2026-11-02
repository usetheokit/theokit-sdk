import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CreateScreenshotLogbookToolOptions } from "../src/screenshot-logbook.js";
import { createScreenshotLogbookTool } from "../src/screenshot-logbook.js";
import { textHandler } from "./text-handler.js";

const FIXED = new Date("2026-11-02T10:00:00.000Z");
const LOG = "logbook/screenshots.jsonl";

let projectRoot: string;
let outsideRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "logbook-root-"));
  outsideRoot = mkdtempSync(join(tmpdir(), "logbook-outside-"));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(outsideRoot, { recursive: true, force: true });
});

/** A type alias, not an interface: the tool handler takes a string-keyed record. */
type LogbookInput = {
  action: "record" | "list";
  path?: string;
  caption?: string;
  limit?: number;
};

type Result = Record<string, unknown>;

function logbook(options: Partial<CreateScreenshotLogbookToolOptions> = {}) {
  const tool = createScreenshotLogbookTool({ projectRoot, now: () => FIXED, ...options });
  const call = textHandler(tool);
  return {
    tool,
    run: async (input: LogbookInput): Promise<Result> => JSON.parse(await call(input)) as Result,
  };
}

/** Writes an image file under the project root and returns its relative path. */
function image(relativePath: string, bytes: Buffer | number = 3): string {
  const absolute = join(projectRoot, relativePath);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, typeof bytes === "number" ? Buffer.alloc(bytes, 7) : bytes);
  return relativePath;
}

const logFile = (): string => join(projectRoot, LOG);

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" });
}

const tempFilesUnder = (dir: string): string[] =>
  filesUnder(dir).filter((name) => name.endsWith(".tmp"));

describe("createScreenshotLogbookTool — recording and listing", () => {
  it("records_two_images_and_lists_them_in_order", async () => {
    const { run } = logbook();
    image("shots/a.png", 3);
    image("shots/b.jpg", 5);

    const first = await run({ action: "record", path: "shots/a.png", caption: "login page" });
    const second = await run({ action: "record", path: "shots/b.jpg", caption: "dashboard" });
    const listed = await run({ action: "list" });

    expect(first).toEqual({
      ok: true,
      entry: {
        id: 1,
        path: "shots/a.png",
        caption: "login page",
        media_type: "image/png",
        bytes: 3,
        recorded_at: "2026-11-02T10:00:00.000Z",
      },
      total: 1,
    });
    expect(second).toMatchObject({ ok: true, total: 2, entry: { id: 2 } });
    expect(listed).toEqual({
      ok: true,
      total: 2,
      entries: [
        first.entry,
        {
          id: 2,
          path: "shots/b.jpg",
          caption: "dashboard",
          media_type: "image/jpeg",
          bytes: 5,
          recorded_at: "2026-11-02T10:00:00.000Z",
        },
      ],
    });
  });

  it("lists_an_empty_array_when_the_log_does_not_exist", async () => {
    const { run } = logbook();

    expect(await run({ action: "list" })).toEqual({ ok: true, entries: [], total: 0 });
    expect(existsSync(logFile())).toBe(false);
  });

  it("lists_only_the_last_limit_entries_and_the_full_total", async () => {
    const { run } = logbook();
    for (const name of ["a", "b", "c"]) {
      image(`${name}.png`);
      await run({ action: "record", path: `${name}.png`, caption: name });
    }

    const listed = await run({ action: "list", limit: 2 });

    expect(listed.total).toBe(3);
    expect((listed.entries as Array<{ id: number }>).map((entry) => entry.id)).toEqual([2, 3]);
  });

  it("caps_the_list_limit_at_max_entries", async () => {
    const { run } = logbook({ maxEntries: 2 });
    image("a.png");
    await run({ action: "record", path: "a.png", caption: "1" });
    await run({ action: "record", path: "a.png", caption: "2" });

    const listed = await run({ action: "list", limit: 50 });

    expect((listed.entries as unknown[]).length).toBe(2);
  });

  it("names_the_tool_screenshot_logbook_and_honours_a_name_override", () => {
    expect(logbook().tool.name).toBe("screenshot_logbook");
    expect(logbook({ name: "shots" }).tool.name).toBe("shots");
  });

  it("creates_the_log_directory_and_writes_one_json_line_per_entry", async () => {
    const { run } = logbook();
    image("a.png");
    image("b.png");
    expect(existsSync(join(projectRoot, "logbook"))).toBe(false);

    await run({ action: "record", path: "a.png", caption: "one" });
    await run({ action: "record", path: "b.png", caption: "two" });

    const lines = readFileSync(logFile(), "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => (JSON.parse(line) as { id: number }).id)).toEqual([1, 2]);
  });

  it("round_trips_a_caption_with_newlines_quotes_and_unicode", async () => {
    const { run } = logbook();
    image("a.png");
    const caption = 'line one\nline "two"\r\n\tcafé ✓ 日本   end';

    await run({ action: "record", path: "a.png", caption });
    const listed = await run({ action: "list" });

    expect((listed.entries as Array<{ caption: string }>)[0]?.caption).toBe(caption);
    expect(readFileSync(logFile(), "utf8").split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("records_an_absolute_in_root_path_as_a_relative_posix_path", async () => {
    const { run } = logbook();
    image("shots/deep/a.png");
    writeFileSync(join(outsideRoot, "b.png"), Buffer.alloc(3, 1));

    const inside = await run({
      action: "record",
      path: join(projectRoot, "shots", "deep", "a.png"),
      caption: "absolute",
    });
    const outside = await run({
      action: "record",
      path: join(outsideRoot, "b.png"),
      caption: "outside",
    });

    expect(inside).toMatchObject({ ok: true, entry: { path: "shots/deep/a.png" } });
    expect(outside).toMatchObject({ ok: false, error: "path_traversal" });
  });

  it("keeps_the_entry_small_and_never_reads_the_image", async () => {
    const { run } = logbook();
    const marker = Buffer.from("IMAGE-BYTES-MARKER");
    const big = Buffer.alloc(1024 * 1024, 0);
    marker.copy(big, 0);
    image("shots/large.png", big);

    const result = await run({
      action: "record",
      path: "shots/large.png",
      caption: "x".repeat(500),
    });

    const serialised = JSON.stringify(result.entry);
    expect(result).toMatchObject({ ok: true, entry: { bytes: 1024 * 1024 } });
    expect(Buffer.byteLength(serialised)).toBeLessThan(1024);
    expect(serialised).not.toContain("IMAGE-BYTES-MARKER");
    expect(readFileSync(logFile(), "utf8")).not.toContain("IMAGE-BYTES-MARKER");
  });
});

describe("createScreenshotLogbookTool — confinement", () => {
  it("refuses_a_traversal_image_path_and_a_secret_segment", async () => {
    const { run } = logbook();
    image(".env/logo.png");
    image("config/.env.local/shot.png");

    const traversal = await run({ action: "record", path: "../../escape.png", caption: "x" });
    const secret = await run({ action: "record", path: ".env/logo.png", caption: "x" });
    const deepSecret = await run({
      action: "record",
      path: "config/.env.local/shot.png",
      caption: "x",
    });

    image("a/.git/x.png");
    const gitSegment = await run({ action: "record", path: "a/.git/x.png", caption: "x" });

    expect(traversal).toMatchObject({ ok: false, error: "path_traversal" });
    expect(secret).toMatchObject({ ok: false, error: "path_traversal" });
    expect(deepSecret).toMatchObject({ ok: false, error: "path_traversal" });
    expect(gitSegment).toMatchObject({ ok: false, error: "path_traversal" });
    expect(existsSync(logFile())).toBe(false);
  });

  it("refuses_a_log_path_under_a_secret_segment_without_echoing_it", async () => {
    image("a.png");

    const result = await logbook({ logPath: ".git/log.jsonl" }).run({
      action: "record",
      path: "a.png",
      caption: "x",
    });

    expect(result).toEqual({ ok: false, error: "path_traversal", target: "log_path" });
    expect(existsSync(join(projectRoot, ".git"))).toBe(false);
  });

  it("refuses_a_log_path_outside_the_root_and_a_symlinked_log_dir", async () => {
    image("a.png");
    const outsideLog = await logbook({ logPath: "../out.jsonl" }).run({
      action: "record",
      path: "a.png",
      caption: "x",
    });
    symlinkSync(outsideRoot, join(projectRoot, "linked"));
    const linkedLog = await logbook({ logPath: "linked/shots.jsonl" }).run({
      action: "record",
      path: "a.png",
      caption: "x",
    });

    expect(outsideLog).toMatchObject({ ok: false, error: "path_traversal" });
    expect(existsSync(join(projectRoot, "..", "out.jsonl"))).toBe(false);
    expect(linkedLog).toMatchObject({ ok: false, error: "path_traversal" });
    expect(filesUnder(outsideRoot)).toEqual([]);
  });

  it("refuses_to_list_a_log_path_that_escapes_the_root", async () => {
    writeFileSync(join(outsideRoot, "shots.jsonl"), "");
    symlinkSync(join(outsideRoot, "shots.jsonl"), join(projectRoot, "linked.jsonl"));

    const linked = await logbook({ logPath: "linked.jsonl" }).run({ action: "list" });
    const outside = await logbook({ logPath: "../x.jsonl" }).run({ action: "list" });

    expect(linked).toEqual({ ok: false, error: "path_traversal", target: "log_path" });
    expect(outside).toEqual({ ok: false, error: "path_traversal", target: "log_path" });
  });

  it("refuses_an_image_symlinked_out_of_the_root", async () => {
    const { run } = logbook();
    writeFileSync(join(outsideRoot, "secret.png"), Buffer.alloc(3, 1));
    symlinkSync(join(outsideRoot, "secret.png"), join(projectRoot, "link.png"));

    const result = await run({ action: "record", path: "link.png", caption: "x" });

    expect(result).toMatchObject({ ok: false, error: "path_traversal" });
    expect(existsSync(logFile())).toBe(false);
  });
});

describe("createScreenshotLogbookTool — typed failures", () => {
  it("refuses_a_missing_required_field", async () => {
    const { run } = logbook();
    image("a.png");

    const noPath = await run({ action: "record", caption: "x" });
    const noCaption = await run({ action: "record", path: "a.png" });
    const blankCaption = await run({ action: "record", path: "a.png", caption: "   " });

    expect(noPath).toMatchObject({ ok: false, error: "invalid_input" });
    expect(noCaption).toMatchObject({ ok: false, error: "invalid_input" });
    expect(blankCaption).toMatchObject({ ok: false, error: "invalid_input" });
    expect(existsSync(logFile())).toBe(false);
  });

  it("refuses_an_unlisted_extension_a_missing_file_a_directory_and_an_empty_file", async () => {
    const { run } = logbook();
    image("seed.png");
    await run({ action: "record", path: "seed.png", caption: "seed" });
    const before = readFileSync(logFile());
    image("doc.bmp");
    mkdirSync(join(projectRoot, "folder.png"));
    image("empty.png", 0);

    const results = [
      await run({ action: "record", path: "doc.bmp", caption: "x" }),
      await run({ action: "record", path: "missing.png", caption: "x" }),
      await run({ action: "record", path: "folder.png", caption: "x" }),
      await run({ action: "record", path: "empty.png", caption: "x" }),
    ];

    expect(results.map((result) => result.error)).toEqual([
      "unsupported_image_type",
      "image_not_found",
      "image_not_found",
      "empty_image",
    ]);
    expect(results.every((result) => result.ok === false)).toBe(true);
    expect(readFileSync(logFile())).toEqual(before);
    expect(tempFilesUnder(projectRoot)).toEqual([]);
  });

  it("records_a_caption_of_exactly_max_caption_chars_and_refuses_one_more", async () => {
    const { run } = logbook();
    image("a.png");

    const fits = await run({ action: "record", path: "a.png", caption: "c".repeat(500) });
    const before = readFileSync(logFile());
    const tooLong = await run({ action: "record", path: "a.png", caption: "c".repeat(501) });

    expect(fits).toMatchObject({ ok: true, total: 1 });
    expect(tooLong).toEqual({ ok: false, error: "caption_too_long", chars: 501, max_chars: 500 });
    expect(readFileSync(logFile())).toEqual(before);
    expect(tempFilesUnder(projectRoot)).toEqual([]);
  });

  it("refuses_a_record_at_max_entries_with_log_full", async () => {
    const { run } = logbook({ maxEntries: 2 });
    image("a.png");
    await run({ action: "record", path: "a.png", caption: "1" });
    await run({ action: "record", path: "a.png", caption: "2" });
    const before = readFileSync(logFile());

    const third = await run({ action: "record", path: "a.png", caption: "3" });

    expect(third).toEqual({ ok: false, error: "log_full", max_entries: 2 });
    expect(readFileSync(logFile())).toEqual(before);
  });

  it("reports_log_corrupt_with_the_line_number_and_never_rewrites_it", async () => {
    const { run } = logbook();
    image("a.png");
    mkdirSync(join(projectRoot, "logbook"));
    const valid = JSON.stringify({
      id: 1,
      path: "a.png",
      caption: "ok",
      media_type: "image/png",
      bytes: 3,
      recorded_at: FIXED.toISOString(),
    });
    writeFileSync(logFile(), `${valid}\n{not json\n`);
    const before = readFileSync(logFile());

    const recorded = await run({ action: "record", path: "a.png", caption: "x" });
    const listed = await run({ action: "list" });

    expect(recorded).toEqual({ ok: false, error: "log_corrupt", line: 2 });
    expect(listed).toEqual({ ok: false, error: "log_corrupt", line: 2 });
    expect(readFileSync(logFile())).toEqual(before);
  });

  it("reports_log_corrupt_for_a_line_missing_a_field", async () => {
    const { run } = logbook();
    mkdirSync(join(projectRoot, "logbook"));
    writeFileSync(logFile(), `${JSON.stringify({ id: 1, path: "a.png" })}\n`);

    expect(await run({ action: "list" })).toEqual({ ok: false, error: "log_corrupt", line: 1 });
  });

  it.skipIf(process.getuid?.() === 0)(
    "reports_write_failed_with_only_the_errno_code_and_no_temp_file",
    async () => {
      const { run } = logbook();
      image("a.png");
      const logDir = join(projectRoot, "logbook");
      mkdirSync(logDir);
      chmodSync(logDir, 0o500);
      try {
        const result = await run({ action: "record", path: "a.png", caption: "x" });

        expect(result).toMatchObject({ ok: false, error: "write_failed" });
        expect(result.message).toMatch(/^E[A-Z]+$/);
        expect(String(result.message)).not.toContain(projectRoot);
        expect(tempFilesUnder(logDir)).toEqual([]);
      } finally {
        chmodSync(logDir, 0o700);
      }
    },
  );

  it("reports_write_failed_when_the_log_path_is_a_directory", async () => {
    const { run } = logbook();
    image("a.png");
    mkdirSync(logFile(), { recursive: true });

    const recorded = await run({ action: "record", path: "a.png", caption: "x" });
    const listed = await run({ action: "list" });

    expect(recorded).toEqual({ ok: false, error: "write_failed", message: "EISDIR" });
    expect(listed).toEqual({ ok: false, error: "write_failed", message: "EISDIR" });
    expect(tempFilesUnder(projectRoot)).toEqual([]);
  });

  it("matches_the_extension_case_insensitively_and_skips_blank_log_lines", async () => {
    const { run } = logbook();
    image("UPPER.PNG");
    mkdirSync(join(projectRoot, "logbook"));
    writeFileSync(logFile(), "\n\n");

    const result = await run({ action: "record", path: "UPPER.PNG", caption: "x" });

    expect(result).toMatchObject({ ok: true, total: 1, entry: { media_type: "image/png" } });
  });

  it("throws_a_range_error_for_a_ceiling_that_is_not_a_positive_integer", () => {
    expect(() => logbook({ maxEntries: 0 })).toThrow(RangeError);
    expect(() => logbook({ maxCaptionChars: 1.5 })).toThrow(RangeError);
  });
});

describe("createScreenshotLogbookTool — concurrency", () => {
  it("lands_five_concurrent_records_once_each", async () => {
    const { run } = logbook();
    for (let index = 0; index < 5; index += 1) image(`shot-${index}.png`);

    const results = await Promise.all(
      [0, 1, 2, 3, 4].map((index) =>
        run({ action: "record", path: `shot-${index}.png`, caption: `shot ${index}` }),
      ),
    );
    const listed = await run({ action: "list" });

    expect(results.every((result) => result.ok === true)).toBe(true);
    const ids = (listed.entries as Array<{ id: number }>).map((entry) => entry.id);
    expect(ids).toEqual([1, 2, 3, 4, 5]);
    expect(listed.total).toBe(5);
  });

  it("a_throwing_clock_is_a_typed_failure_and_does_not_block_the_next_record", async () => {
    let calls = 0;
    const { run } = logbook({
      now: () => {
        calls += 1;
        if (calls === 1) throw new Error("clock down");
        return FIXED;
      },
    });
    image("a.png");

    const [failed, landed] = await Promise.all([
      run({ action: "record", path: "a.png", caption: "first" }),
      run({ action: "record", path: "a.png", caption: "second" }),
    ]);

    expect(failed).toEqual({ ok: false, error: "write_failed", message: "unknown" });
    expect(landed).toMatchObject({ ok: true, entry: { id: 1, caption: "second" } });
  });

  it("a_failed_record_does_not_block_the_next_one", async () => {
    const { run } = logbook();
    image("good.png");

    const [bad, good] = await Promise.all([
      run({ action: "record", path: "missing.png", caption: "bad" }),
      run({ action: "record", path: "good.png", caption: "good" }),
    ]);

    expect(bad).toMatchObject({ ok: false, error: "image_not_found" });
    expect(good).toMatchObject({ ok: true, entry: { id: 1, path: "good.png" } });
  });
});
