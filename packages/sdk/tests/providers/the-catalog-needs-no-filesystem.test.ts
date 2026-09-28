/**
 * The provider catalog must not need a filesystem.
 *
 * `loadProviderCatalog` read `provider-catalog.json` with `readFileSync`, from a directory it computed
 * as `dirname(fileURLToPath(import.meta.url))` at MODULE SCOPE. Both halves break on a runtime with no
 * filesystem, in that order, and the catalog is only model METADATA — so an environment that cannot
 * read it could not run a turn at all.
 *
 * Measured end to end on 2026-09-28, driving a real deploy of a TheoKit app (theokit#705):
 *
 *   1. Cloudflare EXECUTES the top-level module during validation, so the upload was refused before a
 *      request existed:
 *
 *          ✘ Uncaught TypeError: The "path" argument must be of type string or an instance of URL.
 *            Received undefined
 *              at fileURLToPath (node-internal:internal_url:155:15)   [code: 10021]
 *
 *   2. With `import.meta.url` substituted by the bundler, the module initialises and the TURN fails:
 *
 *          agent turn failed (SDK_ERROR): [unenv] fs.readFileSync is not implemented yet!
 *
 *   3. With a newer `compatibility_date`, workerd implements `readFileSync` and the error sharpens to
 *      the honest one:
 *
 *          agent turn failed (ENOENT): no such file or directory, readAll '/provider-catalog.json'
 *
 * The same `ENOENT` reached a deployed Vercel function, whose bundle carries the JS and not the JSON.
 *
 * ## Why no bundler can fix this from outside
 *
 * Probed from inside a deployed worker, workerd's whole virtual filesystem is `/bundle/worker.js`,
 * an empty `/tmp`, and `/dev`. There is no location a consumer's bundler can place this package's
 * private data file such that `join(dirname(<some file URL>), 'provider-catalog.json')` finds it —
 * short of hardcoding this package's internal layout into their build.
 *
 * ## What is asserted
 *
 * That the catalog resolves with `node:fs` unusable. Mocked to throw rather than absent, because an
 * absent module is a different failure: a call that never happens and a call that happens against a
 * broken module both have to pass.
 *
 * The shape follows `internal/budget/pricing-registry.ts`, which has imported a sibling JSON with
 * `with { type: "json" }` in this package for as long as it has existed. No new pattern.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => {
  const refuse = (): never => {
    throw new Error("fs is not available on this runtime");
  };
  return {
    readFileSync: refuse,
    existsSync: refuse,
    readdirSync: refuse,
    statSync: refuse,
    writeFileSync: refuse,
    default: { readFileSync: refuse, existsSync: refuse },
  };
});

describe("the provider catalog needs no filesystem", () => {
  it("loads with node:fs unusable", async () => {
    const { loadProviderCatalog } = await import("../../src/internal/providers/catalog-loader.js");

    const catalog = loadProviderCatalog();

    expect(
      Object.keys(catalog).length,
      "the catalog is empty with fs unusable, so it is still being read from disk — an environment " +
        "with no filesystem cannot run a turn, and the catalog is only model metadata",
    ).toBeGreaterThan(0);
  });

  it("carries the providers a consumer actually names", async () => {
    // COUNTERPROOF for the case above: `{ a: 1 }` satisfies a length check. These three are the
    // credential chain `resolve-credential.ts` walks in order, so their absence is observable.
    const { loadProviderCatalog } = await import("../../src/internal/providers/catalog-loader.js");

    const ids = Object.keys(loadProviderCatalog());

    expect(ids).toContain("openrouter");
    expect(ids).toContain("anthropic");
    expect(ids).toContain("openai");
  });

  it("indexes model info with node:fs unusable", async () => {
    // `getCatalogModelInfo` is what a turn calls, through `ensureModelIndexLoaded` → the loader. It is
    // the path that failed on a deployed worker, and it is a different entry point from the one above.
    const { getCatalogModelInfo } = await import("../../src/internal/providers/catalog-loader.js");

    expect(() => getCatalogModelInfo("openai/gpt-4o-mini")).not.toThrow();
  });

  it("still lets a test inject a malformed entry", async () => {
    // The `_testInjectMalformed` seam predates this change and the WARN-and-skip contract depends on
    // it. A rewrite that dropped the option would compile and silently delete that coverage.
    const { loadProviderCatalog } = await import("../../src/internal/providers/catalog-loader.js");

    const catalog = loadProviderCatalog({ _testInjectMalformed: true });

    expect(catalog["malformed-provider"]).toBeUndefined();
    expect(Object.keys(catalog).length).toBeGreaterThan(0);
  });

  it("does not resolve a directory at module scope", async () => {
    // The first of the two failures, and the one that refused the upload before any code ran. It is
    // invisible to the cases above: they exercise the load, and this one happens at import.
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(
      new URL("../../src/internal/providers/catalog-loader.ts", import.meta.url),
      "utf-8",
    );
    const beforeFirstFunction = source.slice(0, source.search(/^(export )?function /m));
    const code = beforeFirstFunction
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

    expect(
      code.includes("fileURLToPath("),
      "the module resolves a path at load time; `import.meta.url` is undefined on Workers and " +
        "Cloudflare executes the top-level module during validation, so this refuses the upload",
    ).toBe(false);
    expect(code).not.toContain("readFileSync");
  });
});
