/**
 * `image_generate` — turns a prompt into an image file inside the project root.
 *
 * The image comes from a `generate` callback the consumer injects (the `text_to_speech` pattern;
 * `generateImage` from `@theokit/sdk` is a ready one for OpenAI-compatible endpoints). The file is
 * written under `outputDir` below `projectRoot` with the same confinement as `view_image`, and the
 * model receives the relative path, mime type and byte count so it can pass the path to `view_image`.
 *
 * Return: `{ ok: true, path, mime_type, bytes }` or `{ ok: false, error }` with `error` one of
 * `path_traversal`, `prompt_too_large`, `generation_failed`, `unsupported_image_type`,
 * `empty_image`, `image_too_large`, `write_failed`. Nothing is written on a failure.
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

/** Image mime types the tool saves, each with its file extension. Anything else is refused by name. */
const IMAGE_EXTENSIONS = new Map<string, string>([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
]);

/** Default ceiling on the prompt sent to the provider, in UTF-16 code units. A default, not a measured limit. */
export const DEFAULT_MAX_PROMPT_CHARS = 4096;

/** Default ceiling on the image written to disk: 10 MiB, like `view_image` but larger. */
export const DEFAULT_MAX_GENERATED_IMAGE_BYTES = 10 * 1024 * 1024;

/** What the provider returns: the encoded image and its mime type. */
export interface GeneratedImageData {
  image: Uint8Array;
  mimeType: string;
}

/**
 * The image provider {@link createImageGenerateTool} calls.
 *
 * Reject the promise to signal a failed synthesis: the tool turns a rejection into
 * `{ ok: false, error: "generation_failed", message }` and never lets it escape into the agent turn.
 */
export type ImageGenerateCallback = (prompt: string) => Promise<GeneratedImageData>;

/** Options for {@link createImageGenerateTool}. `generate` and `projectRoot` are required. */
export interface CreateImageGenerateToolOptions {
  /** Image provider callback — the consumer injects the implementation. */
  generate: ImageGenerateCallback;
  /** Root the tool writes under. Every path is resolved inside it. */
  projectRoot: string;
  /** Directory for the images, relative to `projectRoot`. Omitted ⇒ `images`. Created when absent. */
  outputDir?: string;
  /** Name exposed to the model. Omitted ⇒ `image_generate`. The name is a contract: the approval
   *  key, what the model sees and what telemetry records. */
  name?: string;
  /** Description exposed to the model. Omitted ⇒ the literal below. */
  description?: string;
  /** Longest prompt sent to the provider. Omitted ⇒ {@link DEFAULT_MAX_PROMPT_CHARS}. */
  maxPromptChars?: number;
  /** Largest image written. Omitted ⇒ {@link DEFAULT_MAX_GENERATED_IMAGE_BYTES}. An image of exactly this size fits. */
  maxImageBytes?: number;
}

type ImageGenerateFailure =
  | { ok: false; error: "path_traversal"; path: string }
  | { ok: false; error: "prompt_too_large"; chars: number; max_chars: number }
  | { ok: false; error: "generation_failed"; message: string }
  | { ok: false; error: "unsupported_image_type"; mime_type: string }
  | { ok: false; error: "empty_image" }
  | { ok: false; error: "image_too_large"; bytes: number; max_bytes: number }
  | { ok: false; error: "write_failed"; message: string };

/** The tool's result, before it is serialised to the JSON string the handler returns. */
export type ImageGenerateResult =
  | { ok: true; path: string; mime_type: string; bytes: number }
  | ImageGenerateFailure;

const json = (result: ImageGenerateResult): string => JSON.stringify(result);

/** `image-` plus 8 hex digits of the prompt's sha256, so a retry of the same prompt targets the same file. */
function defaultStem(prompt: string): string {
  return `image-${createHash("sha256").update(prompt).digest("hex").slice(0, 8)}`;
}

/** Calls the provider; a rejection or a value without an image becomes `generation_failed`. */
async function generateSafely(
  generate: ImageGenerateCallback,
  prompt: string,
): Promise<GeneratedImageData | ImageGenerateFailure> {
  try {
    const value = (await generate(prompt)) as Partial<GeneratedImageData> | undefined;
    if (!(value?.image instanceof Uint8Array) || typeof value.mimeType !== "string") {
      return { ok: false, error: "generation_failed", message: "provider returned no image" };
    }
    return { image: value.image, mimeType: value.mimeType };
  } catch (err) {
    return { ok: false, error: "generation_failed", message: errorMessage(err) };
  }
}

/** The extension for an acceptable image, or the failure that refuses it. */
function checkImage(
  { image, mimeType }: GeneratedImageData,
  maxImageBytes: number,
): { extension: string } | ImageGenerateFailure {
  const extension = IMAGE_EXTENSIONS.get(mimeType);
  if (extension === undefined)
    return { ok: false, error: "unsupported_image_type", mime_type: mimeType };
  if (image.length === 0) return { ok: false, error: "empty_image" };
  // `>` and not `>=`: an image of exactly the limit fits.
  if (image.length > maxImageBytes) {
    return { ok: false, error: "image_too_large", bytes: image.length, max_bytes: maxImageBytes };
  }
  return { extension };
}

/**
 * Build the `image_generate` tool over a caller-supplied provider.
 *
 * Order of checks: the prompt length, then the path (stem and output directory), then the provider,
 * then the mime table, the empty and size checks, then the write. A refused path or an oversize
 * prompt never reaches the provider, and no failure leaves a file behind.
 */
export function createImageGenerateTool(opts: CreateImageGenerateToolOptions): CustomTool {
  const { generate, projectRoot } = opts;
  const outputDir = posix.normalize((opts.outputDir ?? "images").replace(/\\/g, "/"));
  const maxPromptChars = requirePositiveInteger(
    "createImageGenerateTool",
    "maxPromptChars",
    opts.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS,
  );
  const maxImageBytes = requirePositiveInteger(
    "createImageGenerateTool",
    "maxImageBytes",
    opts.maxImageBytes ?? DEFAULT_MAX_GENERATED_IMAGE_BYTES,
  );

  return Tool.create({
    name: opts.name ?? "image_generate",
    description:
      opts.description ??
      "Generate an image from a text prompt and save it as a file in the project. Use when the " +
        "user asks to draw, create or generate a picture. Returns { ok, path, mime_type, bytes } with the " +
        "path relative to the project root, or { ok: false, error }. The image provider is injected " +
        "by the consumer.",
    inputSchema: z.object({
      prompt: z.string().min(1).describe("What the image should show."),
      filename: z
        .string()
        .optional()
        .describe(
          "File name without extension (letters, digits, '.', '_', '-'). Default: derived from the prompt.",
        ),
    }),
    handler: async ({ prompt, filename }) => {
      if (prompt.length > maxPromptChars) {
        return json({
          ok: false,
          error: "prompt_too_large",
          chars: prompt.length,
          max_chars: maxPromptChars,
        });
      }
      const stem = filename ?? defaultStem(prompt);
      const refused = refusePath(posix.join(outputDir, stem), stem, projectRoot);
      if (refused !== null) return refused;

      const generated = await generateSafely(generate, prompt);
      if ("ok" in generated) return json(generated);
      const checked = checkImage(generated, maxImageBytes);
      if ("ok" in checked) return json(checked);

      const relativePath = posix.join(outputDir, `${stem}.${checked.extension}`);
      return saveMedia(projectRoot, outputDir, relativePath, generated.image, generated.mimeType);
    },
  });
}
