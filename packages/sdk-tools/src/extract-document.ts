/**
 * `extract_document` — let the agent read the text of an office document in the project.
 *
 * ## Why this is a built-in
 *
 * A `.docx` is a zip of XML parts: `read_file` returns compressed bytes, not the words in it. The
 * confinement is the same as `view_image`'s and is the part worth reviewing once: a document
 * reader that honours any path is a file exfiltration primitive.
 *
 * ## The engine
 *
 * Text extraction is delegated to `mammoth`, an OPTIONAL peer loaded lazily on the first call, so
 * a consumer of the other tools never pays for it. Its absence is a typed `document_engine_missing`
 * result naming the install command, never a throw. A consumer can pass `extractText` to use any
 * other engine; the envelope stays the same.
 *
 * ## Result shape
 *
 *   - `{ ok: true, path, format: "docx", chars, truncated, text }` — `text` is the trimmed
 *     extracted text cut at `maxChars`; `chars` is the length before the cut.
 *   - `{ ok: false, error: "path_traversal" | "unsupported_document_type" | "not_found" |
 *     "not_a_document" | "document_too_large" | "document_unreadable" |
 *     "document_engine_missing", path, … }`
 *
 * `maxBytes` bounds the file read, not what the engine inflates it to; `maxChars` bounds what
 * reaches the model.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { extname } from "node:path";

import type { CustomTool } from "@theokit/sdk";
import { Tool } from "@theokit/sdk";
import { z } from "zod";

import { safePathJoin } from "./internal/path-guard.js";
import { checkPathScope, isForbiddenAtAnyDepth } from "./path-scope.js";

/** Default ceiling on the file read, in bytes on disk: 10 MB. */
const DEFAULT_MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/** Default ceiling on the text returned to the model, in characters. */
const DEFAULT_MAX_DOCUMENT_CHARS = 100_000;

/** The extensions the tool reads, lower-cased. A new format is one entry plus its engine. */
const SUPPORTED_EXTENSIONS = [".docx"] as const;

/** A `.docx` is a zip archive; every zip starts with this local-file-header signature. */
const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04] as const;

const INSTALL_COMMAND = "npm install mammoth";

/** The engine contract: document bytes in, raw text out. */
type DocumentTextExtractor = (bytes: Uint8Array) => Promise<string>;

/**
 * Options for {@link createExtractDocumentTool}.
 *
 * @public
 */
export interface CreateExtractDocumentToolOptions {
  /** Root the tool reads from. Every path is resolved inside it. */
  projectRoot: string;
  /** Name exposed to the model. Omitted ⇒ `extract_document`. */
  name?: string;
  /** Description exposed to the model. Omitted ⇒ the literal below. */
  description?: string;
  /** Ceiling on the file size in bytes. Omitted ⇒ {@link DEFAULT_MAX_DOCUMENT_BYTES}. */
  maxBytes?: number;
  /** Ceiling on the returned text in characters. Omitted ⇒ {@link DEFAULT_MAX_DOCUMENT_CHARS}. */
  maxChars?: number;
  /** Engine that turns the bytes into text. Omitted ⇒ the optional peer `mammoth`, loaded lazily. */
  extractText?: DocumentTextExtractor;
}

const limitsSchema = z.object({
  maxBytes: z.number().int().positive(),
  maxChars: z.number().int().positive(),
});

type DocumentErrorCode =
  | "path_traversal"
  | "unsupported_document_type"
  | "not_found"
  | "not_a_document"
  | "document_too_large"
  | "document_unreadable"
  | "document_engine_missing";

interface ExtractDocumentOk {
  ok: true;
  path: string;
  format: "docx";
  chars: number;
  truncated: boolean;
  text: string;
}

/** A failure before the path is attached: the read helper does not know the input path. */
interface DocumentFailureBody {
  ok: false;
  error: DocumentErrorCode;
  [extra: string]: unknown;
}

type ExtractDocumentFailure = DocumentFailureBody & { path: string };

const json = (result: ExtractDocumentOk | ExtractDocumentFailure): string => JSON.stringify(result);

/**
 * Extract the text of a `.docx` inside the project root.
 *
 * @public
 */
export function createExtractDocumentTool(options: CreateExtractDocumentToolOptions): CustomTool {
  const { projectRoot } = options;
  const limits = parseLimits(options);
  const extract = options.extractText;

  return Tool.create({
    name: options.name ?? "extract_document",
    description:
      options.description ??
      "Extract the text of an office document (.docx) in the project. Returns the text, cut at a character limit.",
    inputSchema: z.object({
      path: z.string().describe("Path to the document, relative to the project root."),
    }),
    handler: async (input: { path: string }): Promise<string> => {
      // Same order as `view_image`: the shared scope guard (lexical and symlink escapes), then the
      // any-depth secret guard, and only then a join that can no longer throw outside the envelope.
      const refused = checkPathScope(input.path, projectRoot);
      if (refused !== null) return refused;
      if (isForbiddenAtAnyDepth(input.path)) {
        return json({ ok: false, error: "path_traversal", path: input.path });
      }
      if (!isSupported(input.path)) {
        return json({
          ok: false,
          error: "unsupported_document_type",
          path: input.path,
          supported: [...SUPPORTED_EXTENSIONS],
        });
      }

      const outcome = readWithinBudget(safePathJoin(projectRoot, input.path), limits.maxBytes);
      if (!outcome.ok) return json({ ...outcome.failure, path: input.path });

      return json(await extractWithin(outcome.bytes, input.path, limits.maxChars, extract));
    },
  }) as unknown as CustomTool;
}

const isSupported = (path: string): boolean =>
  (SUPPORTED_EXTENSIONS as readonly string[]).includes(extname(path).toLowerCase());

/** Validates the numeric options once, at construction, so a bad limit fails the factory call. */
function parseLimits(options: CreateExtractDocumentToolOptions): z.infer<typeof limitsSchema> {
  const parsed = limitsSchema.safeParse({
    maxBytes: options.maxBytes ?? DEFAULT_MAX_DOCUMENT_BYTES,
    maxChars: options.maxChars ?? DEFAULT_MAX_DOCUMENT_CHARS,
  });
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new RangeError(`createExtractDocumentTool: invalid options (${detail})`);
  }
  return parsed.data;
}

type ReadOutcome =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly failure: DocumentFailureBody };

const NOT_A_DOCUMENT: ReadOutcome = {
  ok: false,
  failure: { ok: false, error: "not_a_document" },
};

const hasZipSignature = (bytes: Uint8Array): boolean =>
  ZIP_SIGNATURE.every((byte, index) => bytes[index] === byte);

/**
 * Sizes, reads and checks one file through a single descriptor (CodeQL js/file-system-race): the
 * size cap must describe the bytes actually returned, so the read is bounded by the size the
 * descriptor reported, and a file that grows after `fstat` cannot push past the cap.
 */
function readWithinBudget(absolute: string, maxBytes: number): ReadOutcome {
  const opened = openForRead(absolute);
  if (!opened.ok) return opened;
  const { fd } = opened;
  try {
    const stat = fstatSync(fd);
    // A directory named `x.docx` opens on Linux; it is still not a document.
    if (!stat.isFile()) return NOT_A_DOCUMENT;
    // `>` and not `>=`: a file of exactly the limit fits.
    if (stat.size > maxBytes) {
      return {
        ok: false,
        failure: {
          ok: false,
          error: "document_too_large",
          bytes: stat.size,
          limit_bytes: maxBytes,
        },
      };
    }
    const buffer = Buffer.alloc(stat.size);
    const bytes = new Uint8Array(buffer.subarray(0, readSync(fd, buffer, 0, stat.size, 0)));
    return hasZipSignature(bytes) ? { ok: true, bytes } : NOT_A_DOCUMENT;
  } finally {
    closeSync(fd);
  }
}

/**
 * Opens the file, telling a missing file (`not_found`, which the model answers with another path)
 * apart from one it may not read (`document_unreadable` with the system's message).
 */
function openForRead(
  absolute: string,
): { readonly ok: true; readonly fd: number } | Extract<ReadOutcome, { ok: false }> {
  try {
    return { ok: true, fd: openSync(absolute, "r") };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, failure: { ok: false, error: "not_found" } };
    }
    return {
      ok: false,
      failure: { ok: false, error: "document_unreadable", message: messageOf(err) },
    };
  }
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Runs the engine, trims and cuts its text, mapping every engine failure to a typed result. */
async function extractWithin(
  bytes: Uint8Array,
  path: string,
  maxChars: number,
  injected: DocumentTextExtractor | undefined,
): Promise<ExtractDocumentOk | ExtractDocumentFailure> {
  const engine = injected ? { ok: true as const, extract: injected } : await loadMammoth();
  if (!engine.ok) {
    return {
      ok: false,
      error: "document_engine_missing",
      path,
      install: INSTALL_COMMAND,
      message: engine.message,
    };
  }
  let text: string;
  try {
    text = (await engine.extract(bytes)).trim();
  } catch (err) {
    // A zip that is not a Word document (an `.xlsx` renamed, a corrupt or encrypted file) lands here.
    return { ok: false, error: "document_unreadable", path, message: messageOf(err) };
  }
  return {
    ok: true,
    path,
    format: "docx",
    chars: text.length,
    truncated: text.length > maxChars,
    text: text.slice(0, maxChars),
  };
}

/** The slice of `mammoth`'s API this tool uses; declared here so the build never needs its types. */
interface MammothLike {
  extractRawText(input: { buffer: Buffer }): Promise<{ value: string }>;
}

/**
 * Loads the optional `mammoth` peer, or the reason it could not be loaded.
 *
 * `mammoth` is CommonJS: an ESM `import()` exposes it under `default`, the CJS build's `require`
 * returns it bare, so both shapes are read. Any load failure counts, not only a missing module;
 * the cause is kept in `message` so a broken install is not reported as a merely absent one.
 * Nothing is cached, so installing the peer mid-session takes effect on the next call.
 */
async function loadMammoth(): Promise<
  | { readonly ok: true; readonly extract: DocumentTextExtractor }
  | { readonly ok: false; readonly message: string }
> {
  try {
    const loaded = (await import("mammoth")) as unknown as MammothLike & { default?: MammothLike };
    const mammoth = loaded.default ?? loaded;
    return {
      ok: true,
      extract: async (bytes) => {
        const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return (await mammoth.extractRawText({ buffer })).value;
      },
    };
  } catch (err) {
    return { ok: false, message: messageOf(err) };
  }
}
