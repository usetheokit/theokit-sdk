---
'@theokit/sdk-tools': patch
---

New `createReadPdfTool`, imported from the subpath `@theokit/sdk-tools/read-pdf`: a `read_pdf` built-in that gives an agent the text of a PDF inside the
project root, with its page count and character count. It refuses traversal, absolute paths outside
the root, secret paths and symlinks that escape the root before opening a file, and returns typed
`not_found`, `not_a_pdf`, `pdf_too_large`, `pdf_unreadable` and `pdf_engine_missing` results
instead of throwing. The text is cut at `maxChars` (default 100000) with `truncated` set; files over
`maxBytes` (default 10 MB) are refused unread.

Text extraction uses `unpdf`, a new optional peer loaded on the first call: install it with
`npm install unpdf` to use the default engine. Without it the tool returns `pdf_engine_missing`
with that command and the load error. Pass `extractText` to use another engine. `unpdf` 2.x
declares Node >=24 in its `engines`; the tool's tests pass with it on Node 22.12.

The tool ships from its own entry, not from the package root, so `@theokit/sdk-tools` itself does
not grow: `import { createReadPdfTool } from "@theokit/sdk-tools/read-pdf"`.
