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

import { createHash, randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, posix } from "node:path";

import type { CustomTool } from "@theokit/sdk";
import { Tool } from "@theokit/sdk";
import { z } from "zod";

import { safePathJoin } from "./internal/path-guard.js";
import { checkPathScope, isForbiddenAtAnyDepth } from "./path-scope.js";

/**
 * Image mime types mapped to the extension the file is saved under.
 *
 * A closed table, for the reason `view_image` keeps one: guessing an extension labels bytes as
 * something they are not, and the consumer finds out when the file will not play. An unlisted
 * type is refused by name instead.
 */
const IMAGE_EXTENSIONS = new Map<string, string>([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
]);

/** Default ceiling on the prompt sent to the provider, in UTF-16 code units. A default, not a measured limit. */
export const DEFAULT_MAX_PROMPT_CHARS = 4096;

/** Default ceiling on the image written to disk: 10 MiB, like `view_image` but larger. */
export const DEFAULT_MAX_GENERATED_IMAGE_BYTES = 10 * 1024 * 1024;

/** A stem the model may choose: no separator, no leading dot, no traversal, at most 64 characters. */
const STEM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The errno code of a file-system failure: its message would hand the model the host's absolute paths. */
const errorCode = (err: unknown): string => (err as { code?: string }).code ?? "unknown";

/** A ceiling of zero, a negative, a fraction or NaN would build a tool that refuses everything or nothing. */
function requirePositiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(
      `createImageGenerateTool: ${name} must be a positive integer, got ${value}`,
    );
  }
  return value;
}

/** `image-` plus 8 hex digits of the prompt's sha256, so a retry of the same prompt targets the same file. */
function defaultStem(prompt: string): string {
  return `image-${createHash("sha256").update(prompt).digest("hex").slice(0, 8)}`;
}

/** The refusal for a stem or output directory the tool may not write, or null when it may. */
function refusePath(relativeStem: string, stem: string, projectRoot: string): string | null {
  if (!STEM_PATTERN.test(stem) || isForbiddenAtAnyDepth(relativeStem)) {
    return json({ ok: false, error: "path_traversal", path: relativeStem });
  }
  return checkPathScope(relativeStem, projectRoot);
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
 * Writes the bytes through a temp file in the target's own directory and a rename, so a reader
 * never sees a partial image. A failure removes the temp file and rethrows.
 *
 * Local rather than `replaceFileAtomic`: that helper takes a string, which would rewrite any byte
 * sequence that is not UTF-8, and it does not create its directory.
 */
async function writeAtomic(target: string, image: Uint8Array): Promise<void> {
  const temp = `${dirname(target)}/.${basename(target)}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, image, { flag: "wx", mode: 0o600 });
    await rename(temp, target);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}

/**
 * Creates the output directory, re-checks it for a symlink escape, writes the image, and returns
 * the serialised result: the success envelope, or the refusal or `write_failed` that stopped it.
 */
async function saveImage(
  projectRoot: string,
  outputDir: string,
  relativePath: string,
  { image, mimeType }: GeneratedImageData,
): Promise<string> {
  const target = safePathJoin(projectRoot, relativePath);
  try {
    await mkdir(dirname(target), { recursive: true });
    // The directory may not have existed at the first check; now it does, so a symlink placed
    // there is resolved and an escape refused before any byte is written.
    const refused = checkPathScope(outputDir, projectRoot);
    if (refused !== null) return refused;
    await writeAtomic(target, image);
    return json({ ok: true, path: relativePath, mime_type: mimeType, bytes: image.length });
  } catch (err) {
    return json({ ok: false, error: "write_failed", message: errorCode(err) });
  }
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
    "maxPromptChars",
    opts.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS,
  );
  const maxImageBytes = requirePositiveInteger(
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
      return saveImage(projectRoot, outputDir, relativePath, generated);
    },
  });
}
