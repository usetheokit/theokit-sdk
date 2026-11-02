/**
 * `@theokit/sdk-tools/screenshot-logbook` — the `screenshot_logbook` tool's own entry.
 *
 * Kept out of the package barrel on purpose: the root `dist/index.js` has a gzip budget
 * (`.bundle-budget.json`) this module would exceed (33511 / 32000 bytes measured with it).
 */
export {
  type CreateScreenshotLogbookToolOptions,
  createScreenshotLogbookTool,
  DEFAULT_MAX_CAPTION_CHARS,
  DEFAULT_MAX_ENTRIES,
  type LogbookEntry,
  type ScreenshotLogbookResult,
} from "./screenshot-logbook.js";
