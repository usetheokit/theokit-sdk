---
"@theokit/sdk": patch
---

Block-style YAML lists in frontmatter now parse instead of vanishing.

`parseSimpleYaml` is line-oriented: it splits each line on the first `:` and coerces what follows.
A continuation line `- item` has no colon, so it was skipped outright, while the key line above it
had an empty value and coerced to `undefined`. The key disappeared entirely — a reader saw
`paths:` on disk, found no behaviour, and had nothing to grep for.

Two things made this worth fixing rather than documenting:

- **The file's own docblock recommended the shape it could not read.** Listing the inline form's
  comma limitation, it advised "Use multi-line lists or reword if you need this." Multi-line lists
  were the one shape this parser did not support.
- **Two parsers in this package disagreed about the same frontmatter.** The sibling
  `context-yaml-lite.ts` already reads block lists, and its comment records that adding them was a
  repair rather than a feature. Which loader read a file decided whether its list existed.

Blank and `#` lines do not end a list; the first other line does, and the caller resumes there — so
the key written after a block list is no longer swallowed by it. A bare `key:` with no items under
it still yields `undefined`, which is what a caller's Zod default relies on.

The collection and the key/value split moved into `collectBlockList` and `splitEntry`. That is not
tidying: inlining the collection put `parseSimpleYaml` at a cognitive complexity of 24 against the
repository's limit of 10, measured on the same file path where the pre-change version raised no
such diagnostic.
