---
'@theokit/sdk-tools': patch
---

Add `extract_document`, a built-in tool that returns the text of a `.docx` inside the project root, imported from the subpath `@theokit/sdk-tools/extract-document` (`createExtractDocumentTool`). Paths outside the root, absolute paths and secret paths are refused before any file is opened, and failures are typed results (`unsupported_document_type`, `not_found`, `not_a_document`, `document_too_large`, `document_unreadable`, `document_engine_missing`). Text is cut at `maxChars` with `truncated` set. The engine is the optional peer `mammoth` (`npm install mammoth`), loaded on first call; pass `extractText` to use another engine.
