import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createExtractDocumentTool } from "../src/extract-document.js";

/**
 * `extract_document` — give an agent the text of an office document inside the project root.
 *
 * Most of these tests are about the boundary, as for `view_image`: a reader that honours any path
 * is a file exfiltration primitive. The rest pin the typed failures a model reads to decide what
 * to try next, and the optional `mammoth` engine, whose absence must be a result, never a throw.
 */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "hello.docx");
const FIXTURE_BYTES = 928;
const FIXTURE_TEXT = "Hello theokit docx\n\nSecond paragraph";

let projectRoot: string;
let outsideDir: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "extract-document-"));
  outsideDir = mkdtempSync(join(tmpdir(), "extract-document-outside-"));
});
afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

type Tool = ReturnType<typeof createExtractDocumentTool>;

/** The envelope the handler returns, parsed. */
const call = async (tool: Tool, path: string) =>
  JSON.parse((await tool.handler({ path }, {} as never)) as string) as Record<string, unknown>;

const engineSpy = (text = FIXTURE_TEXT) => vi.fn(async (_bytes: Uint8Array) => text);

const copyFixture = (name = "hello.docx") => copyFileSync(FIXTURE, join(projectRoot, name));

describe("extract_document reads a .docx inside the project root", () => {
  it("reads_the_text_of_a_docx_inside_the_root", async () => {
    // The real `mammoth` engine on the committed fixture: the one test of the default path.
    copyFixture();
    const tool = createExtractDocumentTool({ projectRoot });

    expect(await call(tool, "hello.docx")).toEqual({
      ok: true,
      path: "hello.docx",
      format: "docx",
      chars: FIXTURE_TEXT.length,
      truncated: false,
      text: FIXTURE_TEXT,
    });
  });

  it("uses_the_injected_extract_text", async () => {
    // EC-5: the extension is compared lower-cased.
    copyFixture("HELLO.DOCX");
    const extractText = engineSpy("  from the injected engine\n");
    const tool = createExtractDocumentTool({ projectRoot, extractText });

    const result = await call(tool, "HELLO.DOCX");

    expect(extractText).toHaveBeenCalledTimes(1);
    const bytes = extractText.mock.calls[0]?.[0] as Uint8Array;
    expect(bytes.length).toBe(FIXTURE_BYTES);
    expect(result).toMatchObject({ ok: true, text: "from the injected engine", chars: 24 });
  });

  it("truncates_at_max_chars", async () => {
    copyFixture();
    const tool = createExtractDocumentTool({ projectRoot, maxChars: 5, extractText: engineSpy() });

    const result = await call(tool, "hello.docx");

    expect(result).toMatchObject({ truncated: true, text: "Hello", chars: 36 });
    expect((result.text as string).length).toBe(5);

    // At exactly the limit nothing is cut.
    const atLimit = createExtractDocumentTool({
      projectRoot,
      maxChars: 36,
      extractText: engineSpy(),
    });
    expect(await call(atLimit, "hello.docx")).toMatchObject({
      truncated: false,
      text: FIXTURE_TEXT,
    });
  });
});

describe("extract_document refuses what it must, without calling the engine", () => {
  it("refuses_traversal_absolute_and_secret_paths", async () => {
    copyFileSync(FIXTURE, join(outsideDir, "outside.docx"));
    mkdirSync(join(projectRoot, ".git"));
    copyFileSync(FIXTURE, join(projectRoot, ".git", "x.docx"));
    // EC-3: a link inside the root that points outside it.
    symlinkSync(join(outsideDir, "outside.docx"), join(projectRoot, "link.docx"));
    const extractText = engineSpy();
    const tool = createExtractDocumentTool({ projectRoot, extractText });

    const paths = ["../outside.docx", join(outsideDir, "outside.docx"), ".git/x.docx", "link.docx"];
    for (const path of paths) {
      expect(await call(tool, path), path).toMatchObject({
        ok: false,
        error: "path_traversal",
        path,
      });
    }
    expect(extractText).toHaveBeenCalledTimes(0);
  });

  it("returns_unsupported_document_type", async () => {
    writeFileSync(join(projectRoot, "legacy.doc"), "x");
    const extractText = engineSpy();
    const tool = createExtractDocumentTool({ projectRoot, extractText });

    expect(await call(tool, "legacy.doc")).toEqual({
      ok: false,
      error: "unsupported_document_type",
      path: "legacy.doc",
      supported: [".docx"],
    });
    expect(extractText).toHaveBeenCalledTimes(0);
  });

  it("returns_not_found", async () => {
    const extractText = engineSpy();
    const tool = createExtractDocumentTool({ projectRoot, extractText });

    expect(await call(tool, "missing.docx")).toEqual({
      ok: false,
      error: "not_found",
      path: "missing.docx",
    });
    expect(extractText).toHaveBeenCalledTimes(0);
  });

  it("returns_not_a_document", async () => {
    // EC-6: a legacy `.doc` renamed `.docx` is not a zip; nor is an empty file or a directory.
    writeFileSync(join(projectRoot, "renamed.docx"), "\xD0\xCF\x11\xE0 legacy word");
    writeFileSync(join(projectRoot, "empty.docx"), "");
    mkdirSync(join(projectRoot, "folder.docx"));
    const extractText = engineSpy();
    const tool = createExtractDocumentTool({ projectRoot, extractText });

    for (const path of ["renamed.docx", "empty.docx", "folder.docx"]) {
      expect(await call(tool, path)).toEqual({ ok: false, error: "not_a_document", path });
    }
    expect(extractText).toHaveBeenCalledTimes(0);
  });

  it("returns_document_too_large_without_calling_the_engine", async () => {
    copyFixture();
    const extractText = engineSpy();
    const tool = createExtractDocumentTool({ projectRoot, maxBytes: 100, extractText });

    expect(await call(tool, "hello.docx")).toEqual({
      ok: false,
      error: "document_too_large",
      path: "hello.docx",
      bytes: FIXTURE_BYTES,
      limit_bytes: 100,
    });
    expect(extractText).toHaveBeenCalledTimes(0);

    // `>` and not `>=`: a file of exactly the limit fits.
    const atLimit = createExtractDocumentTool({
      projectRoot,
      maxBytes: FIXTURE_BYTES,
      extractText,
    });
    expect(await call(atLimit, "hello.docx")).toMatchObject({ ok: true });
  });

  it("returns_document_unreadable_with_the_engine_message", async () => {
    copyFixture();
    const tool = createExtractDocumentTool({
      projectRoot,
      extractText: async () => {
        throw new Error("boom");
      },
    });

    const result = await call(tool, "hello.docx");

    expect(result).toMatchObject({ ok: false, error: "document_unreadable", path: "hello.docx" });
    expect(result.message).toContain("boom");
  });

  it("rejects_a_non_positive_max_chars", () => {
    expect(() => createExtractDocumentTool({ projectRoot, maxChars: 0 })).toThrow(/maxChars/);
    expect(() => createExtractDocumentTool({ projectRoot, maxChars: -1 })).toThrow(/maxChars/);
    expect(() => createExtractDocumentTool({ projectRoot, maxBytes: 0 })).toThrow(/maxBytes/);
  });
});

describe("extract_document without the optional mammoth engine", () => {
  afterEach(() => {
    vi.doUnmock("mammoth");
    vi.resetModules();
  });

  it("reports_document_engine_missing_instead_of_throwing", async () => {
    vi.resetModules();
    vi.doMock("mammoth", () => {
      throw new Error("Cannot find package 'mammoth'");
    });
    const { createExtractDocumentTool: createWithoutEngine } = await import(
      "../src/extract-document.js"
    );
    copyFixture();
    const tool = createWithoutEngine({ projectRoot });

    const result = await call(tool, "hello.docx");

    expect(result).toMatchObject({
      ok: false,
      error: "document_engine_missing",
      path: "hello.docx",
      install: "npm install mammoth",
    });
    // The cause travels with the hint, so a broken install is not read as an absent one.
    expect(typeof result.message).toBe("string");
    expect((result.message as string).length).toBeGreaterThan(0);
  });
});
