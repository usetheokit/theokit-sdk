---
"@theokit/sdk": minor
---

`@theokit/sdk/context` now exports `splitFrontmatter` and `parseFrontmatterYaml`, one CRLF-safe frontmatter splitter and scalar-YAML parser. They throw `ConfigurationError` codes `frontmatter_unterminated` and `frontmatter_invalid`. The skill, subagent and markdown-config loaders split through them and keep their own error codes; a closing fence on the last line of a file is now accepted everywhere.
