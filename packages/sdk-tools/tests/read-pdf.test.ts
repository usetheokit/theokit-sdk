import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createReadPdfTool } from "../src/read-pdf.js";

/**
 * `read_pdf` — give an agent the text of a PDF inside the project root.
 *
 * Like `view_image`, most of these tests are about the boundary: a reader that honours any path is
 * a file exfiltration primitive. The rest pin the typed failures a model reads to decide what to
 * try next, and the optional `unpdf` engine, whose absence must be a result and never a throw.
 */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "hello.pdf");
const FIXTURE_TEXT = "Hello theokit pdf";

let projectRoot: string;
let outsideDir: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "read-pdf-"));
  outsideDir = mkdtempSync(join(tmpdir(), "read-pdf-outside-"));
});
afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

type Tool = ReturnType<typeof createReadPdfTool>;

/** The envelope the handler returns, parsed. */
const call = async (tool: Tool, path: string) =>
  JSON.parse((await tool.handler({ path }, {} as never)) as string) as Record<string, unknown>;

const engineSpy = (text = FIXTURE_TEXT) =>
  vi.fn(async (_bytes: Uint8Array) => ({ pages: 1, text }));

describe("read_pdf reads a PDF inside the project root", () => {
  it("reads_the_text_of_a_pdf_inside_the_root", async () => {
    // The real `unpdf` engine, on the committed fixture: the one test that proves the default path.
    copyFileSync(FIXTURE, join(projectRoot, "hello.pdf"));
    const tool = createReadPdfTool({ projectRoot });

    const result = await call(tool, "hello.pdf");

    expect(result).toEqual({
      ok: true,
      path: "hello.pdf",
      pages: 1,
      chars: FIXTURE_TEXT.length,
      truncated: false,
      text: FIXTURE_TEXT,
    });
  });

  it("uses_the_injected_extract_text", async () => {
    copyFileSync(FIXTURE, join(projectRoot, "hello.pdf"));
    const extractText = engineSpy("from the injected engine");
    const tool = createReadPdfTool({ projectRoot, extractText });

    const result = await call(tool, "hello.pdf");

    expect(extractText).toHaveBeenCalledTimes(1);
    const bytes = extractText.mock.calls[0]?.[0] as Uint8Array;
    expect(Buffer.from(bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
    expect(result).toMatchObject({ ok: true, text: "from the injected engine", pages: 1 });
  });

  it("truncates_at_max_chars", async () => {
    copyFileSync(FIXTURE, join(projectRoot, "hello.pdf"));
    const tool = createReadPdfTool({ projectRoot, maxChars: 5, extractText: engineSpy() });

    const result = await call(tool, "hello.pdf");

    expect(result.truncated).toBe(true);
    expect(result.text).toBe("Hello");
    expect((result.text as string).length).toBe(5);
    expect(result.chars).toBe(17);

    // At exactly the limit nothing is cut.
    const atLimit = createReadPdfTool({ projectRoot, maxChars: 17, extractText: engineSpy() });
    expect(await call(atLimit, "hello.pdf")).toMatchObject({
      truncated: false,
      text: FIXTURE_TEXT,
    });
  });
});

describe("read_pdf refuses what it must, without opening a file", () => {
  it("refuses_traversal_absolute_and_secret_paths", async () => {
    copyFileSync(FIXTURE, join(outsideDir, "outside.pdf"));
    mkdirSync(join(projectRoot, ".git"));
    copyFileSync(FIXTURE, join(projectRoot, ".git", "x.pdf"));
    // EC-3: a link inside the root that points outside it.
    symlinkSync(join(outsideDir, "outside.pdf"), join(projectRoot, "link.pdf"));
    const extractText = engineSpy();
    const tool = createReadPdfTool({ projectRoot, extractText });

    const paths = ["../outside.pdf", join(outsideDir, "outside.pdf"), ".git/x.pdf", "link.pdf"];
    for (const path of paths) {
      const result = await call(tool, path);
      expect(result, path).toMatchObject({ ok: false, error: "path_traversal", path });
    }
    expect(extractText).toHaveBeenCalledTimes(0);
  });

  it("returns_not_found", async () => {
    const extractText = engineSpy();
    const tool = createReadPdfTool({ projectRoot, extractText });

    expect(await call(tool, "missing.pdf")).toEqual({
      ok: false,
      error: "not_found",
      path: "missing.pdf",
    });
    expect(extractText).toHaveBeenCalledTimes(0);
  });

  it("returns_not_a_pdf", async () => {
    // Both a text file renamed `.pdf` and an empty file lack the `%PDF-` header.
    writeFileSync(join(projectRoot, "notes.pdf"), "just some text");
    writeFileSync(join(projectRoot, "empty.pdf"), "");
    mkdirSync(join(projectRoot, "folder.pdf"));
    const extractText = engineSpy();
    const tool = createReadPdfTool({ projectRoot, extractText });

    expect(await call(tool, "notes.pdf")).toEqual({
      ok: false,
      error: "not_a_pdf",
      path: "notes.pdf",
    });
    expect(await call(tool, "empty.pdf")).toEqual({
      ok: false,
      error: "not_a_pdf",
      path: "empty.pdf",
    });
    expect(await call(tool, "folder.pdf")).toEqual({
      ok: false,
      error: "not_a_pdf",
      path: "folder.pdf",
    });
    expect(extractText).toHaveBeenCalledTimes(0);
  });

  it("returns_pdf_too_large_without_calling_the_engine", async () => {
    copyFileSync(FIXTURE, join(projectRoot, "hello.pdf"));
    const extractText = engineSpy();
    const tool = createReadPdfTool({ projectRoot, maxBytes: 100, extractText });

    expect(await call(tool, "hello.pdf")).toEqual({
      ok: false,
      error: "pdf_too_large",
      path: "hello.pdf",
      bytes: 591,
      limit_bytes: 100,
    });
    expect(extractText).toHaveBeenCalledTimes(0);

    // `>` and not `>=`: a file of exactly the limit fits.
    const atLimit = createReadPdfTool({ projectRoot, maxBytes: 591, extractText });
    expect(await call(atLimit, "hello.pdf")).toMatchObject({ ok: true });
  });

  it("returns_pdf_unreadable_with_the_engine_message", async () => {
    copyFileSync(FIXTURE, join(projectRoot, "hello.pdf"));
    const tool = createReadPdfTool({
      projectRoot,
      extractText: async () => {
        throw new Error("boom");
      },
    });

    const result = await call(tool, "hello.pdf");

    expect(result).toMatchObject({ ok: false, error: "pdf_unreadable", path: "hello.pdf" });
    expect(result.message).toContain("boom");
  });

  it("rejects_a_non_positive_max_chars", () => {
    expect(() => createReadPdfTool({ projectRoot, maxChars: 0 })).toThrow(/maxChars/);
    expect(() => createReadPdfTool({ projectRoot, maxChars: -1 })).toThrow(/maxChars/);
    expect(() => createReadPdfTool({ projectRoot, maxBytes: 0 })).toThrow(/maxBytes/);
  });
});

describe("read_pdf without the optional unpdf engine", () => {
  afterEach(() => {
    vi.doUnmock("unpdf");
    vi.resetModules();
  });

  it("reports_pdf_engine_missing_instead_of_throwing", async () => {
    vi.resetModules();
    vi.doMock("unpdf", () => {
      throw new Error("Cannot find package 'unpdf'");
    });
    const { createReadPdfTool: createWithoutEngine } = await import("../src/read-pdf.js");
    copyFileSync(FIXTURE, join(projectRoot, "hello.pdf"));
    const tool = createWithoutEngine({ projectRoot });

    const result = await call(tool, "hello.pdf");

    expect(result).toMatchObject({
      ok: false,
      error: "pdf_engine_missing",
      path: "hello.pdf",
      install: "npm install unpdf",
    });
    // The cause travels with the hint, so a broken install is not read as an absent one. Vitest
    // wraps the factory's throw in its own message, so the test pins presence, not wording.
    expect(typeof result.message).toBe("string");
    expect((result.message as string).length).toBeGreaterThan(0);
  });
});
