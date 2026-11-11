/**
 * `text_to_speech` — turns text into an audio file inside the project root.
 *
 * The audio comes from a `synthesize` callback the consumer injects (the `web_search` pattern): the
 * tool holds no key and opens no socket. The clip is written to `outputDir` below `projectRoot`
 * under the same confinement `view_image` and `read_file` carry, and the model receives the
 * relative path, the mime type and the byte count, never the audio itself: a model cannot listen
 * to it, and a base64 clip at the default ceiling would be about 13 MB of context text.
 *
 * Return shape (always a JSON string):
 *   - `{ ok: true, path, mime_type, bytes }`
 *   - `{ ok: false, error }` with `error` one of `path_traversal`, `text_too_large`,
 *     `synthesis_failed`, `unsupported_audio_type`, `empty_audio`, `audio_too_large`, `write_failed`
 *
 * Nothing is written on any failure, and a refused path or an oversize text never reaches the
 * provider.
 *
 * Limits, accepted and stated: the confinement is checked before the write and again after the
 * output directory is created, but a symlink swapped in by another process between that check and
 * the rename is not caught (the same-user race the sibling tools leave open). A clip is written with
 * mode 0o600. A chosen `filename`, or a default stem two texts happen to share (32 bits of the
 * text's sha256), replaces the existing file of that name. `synthesis_failed` carries the provider's
 * own message on purpose: the provider is the consumer's code, and its words are what the model
 * needs to explain the failure; `write_failed` carries only the errno code, since a file-system
 * message names the host's absolute paths.
 */

import { createHash } from "node:crypto";
import { posix } from "node:path";

import type { CustomTool } from "@theokit/sdk";
import { Tool } from "@theokit/sdk";
import { z } from "zod";

import {
  errorMessage,
  refusePath,
  requirePositiveInteger,
  saveMedia,
} from "./internal/media-output.js";

/**
 * Audio mime types mapped to the extension the file is saved under.
 *
 * A closed table, for the reason `view_image` keeps one: guessing an extension labels bytes as
 * something they are not, and the consumer finds out when the file will not play. An unlisted
 * type is refused by name instead.
 */
const AUDIO_EXTENSIONS = new Map<string, string>([
  ["audio/mpeg", "mp3"],
  ["audio/wav", "wav"],
  ["audio/x-wav", "wav"],
  ["audio/ogg", "ogg"],
  ["audio/opus", "opus"],
  ["audio/flac", "flac"],
  ["audio/aac", "aac"],
  ["audio/webm", "webm"],
]);

/** Default ceiling on the text sent to the provider, in UTF-16 code units. A default, not a measured limit. */
export const DEFAULT_MAX_TEXT_CHARS = 4096;

/** Default ceiling on the clip written to disk: 10 MiB, by analogy with `DEFAULT_MAX_IMAGE_BYTES`. */
export const DEFAULT_MAX_AUDIO_BYTES = 10 * 1024 * 1024;

/** What the provider returns: the encoded clip and its mime type. */
export interface SynthesizedAudio {
  audio: Uint8Array;
  mimeType: string;
}

/**
 * The speech provider {@link createTextToSpeechTool} calls.
 *
 * Reject the promise to signal a failed synthesis: the tool turns a rejection into
 * `{ ok: false, error: "synthesis_failed", message }` and never lets it escape into the agent turn.
 */
export type TextToSpeechCallback = (text: string) => Promise<SynthesizedAudio>;

/** Options for {@link createTextToSpeechTool}. `synthesize` and `projectRoot` are required. */
export interface CreateTextToSpeechToolOptions {
  /** Speech provider callback — the consumer injects the implementation. */
  synthesize: TextToSpeechCallback;
  /** Root the tool writes under. Every path is resolved inside it. */
  projectRoot: string;
  /** Directory for the clips, relative to `projectRoot`. Omitted ⇒ `audio`. Created when absent. */
  outputDir?: string;
  /** Name exposed to the model. Omitted ⇒ `text_to_speech`. The name is a contract: the approval
   *  key, what the model sees and what telemetry records. */
  name?: string;
  /** Description exposed to the model. Omitted ⇒ the literal below. */
  description?: string;
  /** Longest text sent to the provider. Omitted ⇒ {@link DEFAULT_MAX_TEXT_CHARS}. */
  maxTextChars?: number;
  /** Largest clip written. Omitted ⇒ {@link DEFAULT_MAX_AUDIO_BYTES}. A clip of exactly this size fits. */
  maxAudioBytes?: number;
}

type TextToSpeechFailure =
  | { ok: false; error: "path_traversal"; path: string }
  | { ok: false; error: "text_too_large"; chars: number; max_chars: number }
  | { ok: false; error: "synthesis_failed"; message: string }
  | { ok: false; error: "unsupported_audio_type"; mime_type: string }
  | { ok: false; error: "empty_audio" }
  | { ok: false; error: "audio_too_large"; bytes: number; max_bytes: number }
  | { ok: false; error: "write_failed"; message: string };

/** The tool's result, before it is serialised to the JSON string the handler returns. */
export type TextToSpeechResult =
  | { ok: true; path: string; mime_type: string; bytes: number }
  | TextToSpeechFailure;

const json = (result: TextToSpeechResult): string => JSON.stringify(result);

/** `speech-` plus 8 hex digits of the text's sha256, so a retry of the same text targets the same file. */
function defaultStem(text: string): string {
  return `speech-${createHash("sha256").update(text).digest("hex").slice(0, 8)}`;
}

/** Calls the provider; a rejection or a value without audio becomes `synthesis_failed`. */
async function synthesizeSafely(
  synthesize: TextToSpeechCallback,
  text: string,
): Promise<SynthesizedAudio | TextToSpeechFailure> {
  try {
    const value = (await synthesize(text)) as Partial<SynthesizedAudio> | undefined;
    if (!(value?.audio instanceof Uint8Array) || typeof value.mimeType !== "string") {
      return { ok: false, error: "synthesis_failed", message: "provider returned no audio" };
    }
    return { audio: value.audio, mimeType: value.mimeType };
  } catch (err) {
    return { ok: false, error: "synthesis_failed", message: errorMessage(err) };
  }
}

/** The extension for an acceptable clip, or the failure that refuses it. */
function checkAudio(
  { audio, mimeType }: SynthesizedAudio,
  maxAudioBytes: number,
): { extension: string } | TextToSpeechFailure {
  const extension = AUDIO_EXTENSIONS.get(mimeType);
  if (extension === undefined)
    return { ok: false, error: "unsupported_audio_type", mime_type: mimeType };
  if (audio.length === 0) return { ok: false, error: "empty_audio" };
  // `>` and not `>=`: a clip of exactly the limit fits.
  if (audio.length > maxAudioBytes) {
    return { ok: false, error: "audio_too_large", bytes: audio.length, max_bytes: maxAudioBytes };
  }
  return { extension };
}

/**
 * Build the `text_to_speech` tool over a caller-supplied provider.
 *
 * Order of checks: the text length, then the path (stem and output directory), then the provider,
 * then the mime table, the empty and size checks, then the write. A refused path or an oversize
 * text never reaches the provider, and no failure leaves a file behind.
 */
export function createTextToSpeechTool(opts: CreateTextToSpeechToolOptions): CustomTool {
  const { synthesize, projectRoot } = opts;
  const outputDir = posix.normalize((opts.outputDir ?? "audio").replace(/\\/g, "/"));
  const maxTextChars = requirePositiveInteger(
    "createTextToSpeechTool",
    "maxTextChars",
    opts.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS,
  );
  const maxAudioBytes = requirePositiveInteger(
    "createTextToSpeechTool",
    "maxAudioBytes",
    opts.maxAudioBytes ?? DEFAULT_MAX_AUDIO_BYTES,
  );

  return Tool.create({
    name: opts.name ?? "text_to_speech",
    description:
      opts.description ??
      "Turn text into spoken audio and save it as a file in the project. Use when the user asks " +
        "for speech, a voice reply or an audio clip. Returns { ok, path, mime_type, bytes } with the " +
        "path relative to the project root, or { ok: false, error }. The speech provider is injected " +
        "by the consumer.",
    inputSchema: z.object({
      text: z.string().min(1).describe("The text to speak."),
      filename: z
        .string()
        .optional()
        .describe(
          "File name without extension (letters, digits, '.', '_', '-'). Default: derived from the text.",
        ),
    }),
    handler: async ({ text, filename }) => {
      if (text.length > maxTextChars) {
        return json({
          ok: false,
          error: "text_too_large",
          chars: text.length,
          max_chars: maxTextChars,
        });
      }
      const stem = filename ?? defaultStem(text);
      const refused = refusePath(posix.join(outputDir, stem), stem, projectRoot);
      if (refused !== null) return refused;

      const synthesized = await synthesizeSafely(synthesize, text);
      if ("ok" in synthesized) return json(synthesized);
      const checked = checkAudio(synthesized, maxAudioBytes);
      if ("ok" in checked) return json(checked);

      const relativePath = posix.join(outputDir, `${stem}.${checked.extension}`);
      return saveMedia(
        projectRoot,
        outputDir,
        relativePath,
        synthesized.audio,
        synthesized.mimeType,
      );
    },
  });
}
