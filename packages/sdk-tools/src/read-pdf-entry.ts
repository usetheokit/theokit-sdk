/**
 * `@theokit/sdk-tools/read-pdf` — the `read_pdf` tool's own entry.
 *
 * Kept out of the package barrel on purpose: the root `dist/index.js` has a
 * gzip budget (`.bundle-budget.json`) this module would exceed, and a consumer
 * that never reads a PDF should not load it.
 */
export { type CreateReadPdfToolOptions, createReadPdfTool } from "./read-pdf.js";
