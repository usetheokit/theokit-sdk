/**
 * `read_pdf` — let the agent read the text of a PDF in the project.
 *
 * ## Why this is a built-in
 *
 * A PDF is the one common document an agent cannot read with `read_file`: the bytes are a
 * compressed object graph, not text. The confinement is the same as `view_image`'s and is the part
 * worth reviewing once: a document reader that honours any path is a file exfiltration primitive.
 *
 * ## The engine
 *
 * Text extraction is delegated to `unpdf`, an OPTIONAL peer loaded lazily on the first call, so a
 * consumer of the other tools never pays for it. Its absence is a typed `pdf_engine_missing`
 * result naming the install command, never a throw. A consumer can pass `extractText` to use any
 * other engine; the envelope stays the same.
 *
 * ## Result shape
 *
 *   - `{ ok: true, path, pages, chars, truncated, text }` — `chars` is the length of the whole
 *     extracted text; `text` is cut at `maxChars` and `truncated` says whether it was.
 *   - `{ ok: false, error: "path_traversal" | "not_found" | "not_a_pdf" | "pdf_too_large" |
 *     "pdf_unreadable" | "pdf_engine_missing", path, … }`
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";

import type { CustomTool } from "@theokit/sdk";
import { Tool } from "@theokit/sdk";
import { z } from "zod";

import { safePathJoin } from "./internal/path-guard.js";
import { checkPathScope, isForbiddenAtAnyDepth } from "./path-scope.js";

/** Default ceiling on the file read, in bytes on disk: 10 MB. */
const DEFAULT_MAX_PDF_BYTES = 10 * 1024 * 1024;

/** Default ceiling on the text returned to the model, in characters. */
const DEFAULT_MAX_PDF_CHARS = 100_000;

/** Every PDF starts with this header; anything else is refused before the engine sees it. */
const PDF_MAGIC = "%PDF-";

const INSTALL_COMMAND = "npm install unpdf";

/** The engine contract: PDF bytes in, page count and text out. */
type PdfTextExtractor = (bytes: Uint8Array) => Promise<{ pages: number; text: string }>;

/**
 * Options for {@link createReadPdfTool}.
 *
 * @public
 */
export interface CreateReadPdfToolOptions {
  /** Root the tool reads from. Every path is resolved inside it. */
  projectRoot: string;
  /** Name exposed to the model. Omitted ⇒ `read_pdf`. */
  name?: string;
  /** Description exposed to the model. Omitted ⇒ the literal below. */
  description?: string;
  /** Ceiling on the file size in bytes. Omitted ⇒ {@link DEFAULT_MAX_PDF_BYTES}. */
  maxBytes?: number;
  /** Ceiling on the returned text in characters. Omitted ⇒ {@link DEFAULT_MAX_PDF_CHARS}. */
  maxChars?: number;
  /** Engine that turns the bytes into text. Omitted ⇒ the optional peer `unpdf`, loaded lazily. */
  extractText?: PdfTextExtractor;
}

const limitsSchema = z.object({
  maxBytes: z.number().int().positive(),
  maxChars: z.number().int().positive(),
});

type PdfErrorCode =
  | "path_traversal"
  | "not_found"
  | "not_a_pdf"
  | "pdf_too_large"
  | "pdf_unreadable"
  | "pdf_engine_missing";

interface ReadPdfOk {
  ok: true;
  path: string;
  pages: number;
  chars: number;
  truncated: boolean;
  text: string;
}

/** A failure before the path is attached: the read helper does not know the input path. */
interface PdfFailureBody {
  ok: false;
  error: PdfErrorCode;
  [extra: string]: unknown;
}

type ReadPdfFailure = PdfFailureBody & { path: string };

const json = (result: ReadPdfOk | ReadPdfFailure): string => JSON.stringify(result);

/**
 * Read the text of a PDF inside the project root.
 *
 * @public
 */
export function createReadPdfTool(options: CreateReadPdfToolOptions): CustomTool {
  const { projectRoot } = options;
  const limits = parseLimits(options);
  const extract = options.extractText;

  return Tool.create({
    name: options.name ?? "read_pdf",
    description:
      options.description ??
      "Read the text of a PDF file in the project. Returns the page count and the text, cut at a character limit.",
    inputSchema: z.object({
      path: z.string().describe("Path to the PDF, relative to the project root."),
    }),
    handler: async (input: { path: string }): Promise<string> => {
      // Same order as `view_image`: the shared scope guard (lexical and symlink escapes), then the
      // any-depth secret guard, and only then a join that can no longer throw outside the envelope.
      const refused = checkPathScope(input.path, projectRoot);
      if (refused !== null) return refused;
      if (isForbiddenAtAnyDepth(input.path)) {
        return json({ ok: false, error: "path_traversal", path: input.path });
      }

      const outcome = readWithinBudget(safePathJoin(projectRoot, input.path), limits.maxBytes);
      if (!outcome.ok) return json({ ...outcome.failure, path: input.path });

      return json(await extractWithin(outcome.bytes, input.path, limits.maxChars, extract));
    },
  }) as unknown as CustomTool;
}

/** Validates the numeric options once, at construction, so a bad limit fails the factory call. */
function parseLimits(options: CreateReadPdfToolOptions): z.infer<typeof limitsSchema> {
  const parsed = limitsSchema.safeParse({
    maxBytes: options.maxBytes ?? DEFAULT_MAX_PDF_BYTES,
    maxChars: options.maxChars ?? DEFAULT_MAX_PDF_CHARS,
  });
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new RangeError(`createReadPdfTool: invalid options (${detail})`);
  }
  return parsed.data;
}

type ReadOutcome =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly failure: PdfFailureBody };

/**
 * Sizes, reads and checks one file through a single descriptor (CodeQL js/file-system-race #22):
 * the size cap must describe the bytes actually returned, so the read is bounded by the size the
 * descriptor reported, and a file that grows after `fstat` cannot push past the cap.
 */
function readWithinBudget(absolute: string, maxBytes: number): ReadOutcome {
  const opened = openForRead(absolute);
  if (!opened.ok) return opened;
  const { fd } = opened;
  try {
    const stat = fstatSync(fd);
    // A directory named `x.pdf` opens on Linux; it is still not a PDF.
    if (!stat.isFile()) return { ok: false, failure: { ok: false, error: "not_a_pdf" } };
    // `>` and not `>=`: a file of exactly the limit fits.
    if (stat.size > maxBytes) {
      return {
        ok: false,
        failure: { ok: false, error: "pdf_too_large", bytes: stat.size, limit_bytes: maxBytes },
      };
    }
    const buffer = Buffer.alloc(stat.size);
    const bytes = new Uint8Array(buffer.subarray(0, readSync(fd, buffer, 0, stat.size, 0)));
    if (Buffer.from(bytes.subarray(0, PDF_MAGIC.length)).toString("latin1") !== PDF_MAGIC) {
      return { ok: false, failure: { ok: false, error: "not_a_pdf" } };
    }
    return { ok: true, bytes };
  } finally {
    closeSync(fd);
  }
}

/**
 * Opens the file, telling a missing file (`not_found`, which the model answers with another path)
 * apart from one it may not read (`pdf_unreadable` with the system's message).
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
    return { ok: false, failure: { ok: false, error: "pdf_unreadable", message: messageOf(err) } };
  }
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Runs the engine and cuts its text, mapping every engine failure to a typed result. */
async function extractWithin(
  bytes: Uint8Array,
  path: string,
  maxChars: number,
  injected: PdfTextExtractor | undefined,
): Promise<ReadPdfOk | ReadPdfFailure> {
  const engine = injected ? { ok: true as const, extract: injected } : await loadUnpdf();
  if (!engine.ok) {
    return {
      ok: false,
      error: "pdf_engine_missing",
      path,
      install: INSTALL_COMMAND,
      message: engine.message,
    };
  }
  let extracted: { pages: number; text: string };
  try {
    extracted = await engine.extract(bytes);
  } catch (err) {
    return { ok: false, error: "pdf_unreadable", path, message: messageOf(err) };
  }
  const { pages, text } = extracted;
  return {
    ok: true,
    path,
    pages,
    chars: text.length,
    truncated: text.length > maxChars,
    text: text.slice(0, maxChars),
  };
}

/**
 * Loads the optional `unpdf` peer, or the reason it could not be loaded.
 *
 * Any load failure counts, not only a missing module: an ESM-only package required from the CJS
 * build on an older Node fails differently, and the caller's answer is the same install hint. The
 * cause is kept in `message` so a broken install is not reported as a merely absent one. Nothing is
 * cached, so installing the peer mid-session takes effect on the next call.
 */
async function loadUnpdf(): Promise<
  | { readonly ok: true; readonly extract: PdfTextExtractor }
  | { readonly ok: false; readonly message: string }
> {
  try {
    const unpdf = await import("unpdf");
    return {
      ok: true,
      extract: async (bytes) => {
        const { totalPages, text } = await unpdf.extractText(bytes, { mergePages: true });
        return { pages: totalPages, text };
      },
    };
  } catch (err) {
    return { ok: false, message: messageOf(err) };
  }
}
