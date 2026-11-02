import {
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

import type { TextToSpeechCallback } from "../src/text-to-speech.js";
import { createTextToSpeechTool } from "../src/text-to-speech.js";
import { textHandler } from "./text-handler.js";

let projectRoot: string;
let outsideRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "tts-root-"));
  outsideRoot = mkdtempSync(join(tmpdir(), "tts-outside-"));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(outsideRoot, { recursive: true, force: true });
});

/** A fake provider: counts its calls and answers with the bytes and mime type it was given. */
function fakeProvider(audio: Uint8Array, mimeType = "audio/mpeg") {
  const calls: string[] = [];
  const synthesize: TextToSpeechCallback = async (text) => {
    calls.push(text);
    return { audio, mimeType };
  };
  return { synthesize, calls };
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" });
}

async function run(
  options: Partial<Parameters<typeof createTextToSpeechTool>[0]> & {
    synthesize: TextToSpeechCallback;
  },
  input: { text: string; filename?: string },
): Promise<Record<string, unknown>> {
  const tool = createTextToSpeechTool({ projectRoot, ...options });
  return JSON.parse(await textHandler(tool)(input)) as Record<string, unknown>;
}

describe("createTextToSpeechTool — writing the clip", () => {
  it("writes_the_clip_atomically_and_returns_the_relative_path", async () => {
    const audio = new Uint8Array([1, 2, 3]);
    const { synthesize, calls } = fakeProvider(audio);

    const result = await run({ synthesize }, { text: "hello" });

    expect(result).toEqual({
      ok: true,
      path: "audio/speech-2cf24dba.mp3",
      mime_type: "audio/mpeg",
      bytes: 3,
    });
    expect(calls).toEqual(["hello"]);
    expect([...readFileSync(join(projectRoot, "audio/speech-2cf24dba.mp3"))]).toEqual([1, 2, 3]);
    expect(filesUnder(join(projectRoot, "audio"))).toEqual(["speech-2cf24dba.mp3"]);
  });

  it("names_the_tool_text_to_speech_and_honours_a_name_override", () => {
    const { synthesize } = fakeProvider(new Uint8Array([1]));

    expect(createTextToSpeechTool({ synthesize, projectRoot }).name).toBe("text_to_speech");
    expect(createTextToSpeechTool({ synthesize, projectRoot, name: "speak" }).name).toBe("speak");
  });

  it("writes_non_utf8_bytes_unchanged_and_creates_the_output_dir", async () => {
    const audio = new Uint8Array([0xff, 0xfe, 0x00, 0x80]);
    const { synthesize } = fakeProvider(audio, "audio/wav");
    expect(existsSync(join(projectRoot, "voice/out"))).toBe(false);

    const result = await run(
      { synthesize, outputDir: "voice/out" },
      { text: "bytes", filename: "clip" },
    );

    expect(result).toEqual({
      ok: true,
      path: "voice/out/clip.wav",
      mime_type: "audio/wav",
      bytes: 4,
    });
    expect([...readFileSync(join(projectRoot, "voice/out/clip.wav"))]).toEqual([
      0xff, 0xfe, 0x00, 0x80,
    ]);
  });

  it("overwrites_the_same_default_name_on_retry_without_a_partial_file", async () => {
    await run({ synthesize: fakeProvider(new Uint8Array([1, 1])).synthesize }, { text: "again" });
    const second = await run(
      { synthesize: fakeProvider(new Uint8Array([2, 2, 2])).synthesize },
      { text: "again" },
    );

    expect(second.ok).toBe(true);
    const files = filesUnder(join(projectRoot, "audio"));
    expect(files).toHaveLength(1);
    expect([...readFileSync(join(projectRoot, "audio", files[0] as string))]).toEqual([2, 2, 2]);
  });
});

describe("createTextToSpeechTool — refused paths never reach the provider", () => {
  it("refuses_a_traversal_stem_before_calling_the_provider", async () => {
    const { synthesize, calls } = fakeProvider(new Uint8Array([1]));

    const result = await run({ synthesize }, { text: "x", filename: "../../escape" });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("path_traversal");
    expect(calls).toHaveLength(0);
    expect(filesUnder(projectRoot)).toHaveLength(0);
  });

  it("refuses_a_secret_segment", async () => {
    const { synthesize, calls } = fakeProvider(new Uint8Array([1]));

    for (const filename of [".env", ".git"]) {
      const result = await run({ synthesize }, { text: "x", filename });
      expect(result.error).toBe("path_traversal");
    }
    const secretDir = await run({ synthesize, outputDir: "audio/.git" }, { text: "x" });

    expect(secretDir.error).toBe("path_traversal");
    expect(calls).toHaveLength(0);
    expect(filesUnder(projectRoot)).toHaveLength(0);
  });

  it("refuses_an_output_dir_outside_the_root", async () => {
    const { synthesize, calls } = fakeProvider(new Uint8Array([1]));

    const result = await run({ synthesize, outputDir: "../out" }, { text: "x" });

    expect(result.error).toBe("path_traversal");
    expect(calls).toHaveLength(0);
    expect(filesUnder(projectRoot)).toHaveLength(0);
  });

  it("refuses_an_output_dir_that_is_a_symlink_out_of_the_root", async () => {
    symlinkSync(outsideRoot, join(projectRoot, "audio"));
    const { synthesize } = fakeProvider(new Uint8Array([1]));

    const result = await run({ synthesize }, { text: "x" });

    expect(result.error).toBe("path_traversal");
    expect(filesUnder(outsideRoot)).toHaveLength(0);
  });

  it("refuses_text_over_max_text_chars_without_calling_the_provider", async () => {
    const { synthesize, calls } = fakeProvider(new Uint8Array([1]));

    const atLimit = await run({ synthesize, maxTextChars: 5 }, { text: "abcde" });
    const overLimit = await run({ synthesize, maxTextChars: 5 }, { text: "abcdef" });

    expect(atLimit.ok).toBe(true);
    expect(overLimit).toEqual({ ok: false, error: "text_too_large", chars: 6, max_chars: 5 });
    expect(calls).toEqual(["abcde"]);
  });
});

describe("createTextToSpeechTool — option and stem limits", () => {
  it("refuses_an_overlong_or_backslash_stem_and_an_absolute_output_dir", async () => {
    const { synthesize, calls } = fakeProvider(new Uint8Array([1]));

    const long = await run({ synthesize }, { text: "x", filename: "a".repeat(65) });
    const backslash = await run({ synthesize }, { text: "x", filename: "a\\..\\b" });
    const absolute = await run({ synthesize, outputDir: outsideRoot }, { text: "x" });

    expect(long.error).toBe("path_traversal");
    expect(backslash.error).toBe("path_traversal");
    expect(absolute.error).toBe("path_traversal");
    expect(calls).toHaveLength(0);
    expect(filesUnder(outsideRoot)).toHaveLength(0);
  });

  it("throws_at_construction_for_a_ceiling_that_is_not_a_positive_integer", () => {
    const { synthesize } = fakeProvider(new Uint8Array([1]));

    expect(() => createTextToSpeechTool({ synthesize, projectRoot, maxTextChars: 0 })).toThrow(
      /maxTextChars must be a positive integer, got 0/,
    );
    expect(() =>
      createTextToSpeechTool({ synthesize, projectRoot, maxAudioBytes: Number.NaN }),
    ).toThrow(/maxAudioBytes must be a positive integer, got NaN/);
  });
});

describe("createTextToSpeechTool — typed failures write nothing", () => {
  it("turns_a_rejecting_provider_into_synthesis_failed_with_its_message", async () => {
    const synthesize: TextToSpeechCallback = async () => {
      throw new Error("quota exceeded");
    };

    const result = await run({ synthesize }, { text: "x" });

    expect(result).toEqual({ ok: false, error: "synthesis_failed", message: "quota exceeded" });
    expect(filesUnder(projectRoot)).toHaveLength(0);
  });

  it("turns_a_malformed_provider_value_into_synthesis_failed", async () => {
    const synthesize = (async () => ({
      mimeType: "audio/mpeg",
    })) as unknown as TextToSpeechCallback;

    const result = await run({ synthesize }, { text: "x" });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("synthesis_failed");
    expect(filesUnder(projectRoot)).toHaveLength(0);
  });

  it("refuses_an_unlisted_mime_type_empty_audio_and_oversize_audio", async () => {
    const unlisted = await run(
      { synthesize: fakeProvider(new Uint8Array([1]), "audio/x-unknown").synthesize },
      { text: "x" },
    );
    const empty = await run(
      { synthesize: fakeProvider(new Uint8Array([])).synthesize },
      { text: "x" },
    );
    const oversize = await run(
      { synthesize: fakeProvider(new Uint8Array(9)).synthesize, maxAudioBytes: 8 },
      { text: "x" },
    );

    expect(unlisted).toEqual({
      ok: false,
      error: "unsupported_audio_type",
      mime_type: "audio/x-unknown",
    });
    expect(empty).toEqual({ ok: false, error: "empty_audio" });
    expect(oversize).toEqual({ ok: false, error: "audio_too_large", bytes: 9, max_bytes: 8 });
    expect(filesUnder(projectRoot)).toHaveLength(0);
  });

  it("writes_a_clip_of_exactly_max_audio_bytes_and_refuses_one_byte_more", async () => {
    const exact = await run(
      { synthesize: fakeProvider(new Uint8Array(8)).synthesize, maxAudioBytes: 8 },
      { text: "exact", filename: "exact" },
    );
    const over = await run(
      { synthesize: fakeProvider(new Uint8Array(9)).synthesize, maxAudioBytes: 8 },
      { text: "over", filename: "over" },
    );

    expect(exact).toEqual({ ok: true, path: "audio/exact.mp3", mime_type: "audio/mpeg", bytes: 8 });
    expect(over.error).toBe("audio_too_large");
    expect(filesUnder(join(projectRoot, "audio"))).toEqual(["exact.mp3"]);
  });

  it("reports_write_failed_and_leaves_no_temp_file", async () => {
    // The target name is taken by a non-empty directory, so the final rename fails for any user,
    // root included, after the temp file was written: the cleanup path is what is under test.
    mkdirSync(join(projectRoot, "audio/clip.mp3"), { recursive: true });
    writeFileSync(join(projectRoot, "audio/clip.mp3/keep"), "x");
    const { synthesize } = fakeProvider(new Uint8Array([1, 2]));

    const result = await run({ synthesize }, { text: "x", filename: "clip" });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("write_failed");
    // The errno code only: the fs message would hand the model the host's absolute paths.
    expect(result.message).toBe("EISDIR");
    expect(readdirSync(join(projectRoot, "audio"))).toEqual(["clip.mp3"]);
  });
});
