/**
 * `@theokit/sdk-tools/extract-document` — the `extract_document` tool's own entry.
 *
 * Kept out of the package barrel on purpose: the root `dist/index.js` has a gzip budget
 * (`.bundle-budget.json`) this module would exceed, and a consumer that never reads an office
 * document should not load it.
 */
export {
  type CreateExtractDocumentToolOptions,
  createExtractDocumentTool,
} from "./extract-document.js";
