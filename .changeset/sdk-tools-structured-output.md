---
'@theokit/sdk-tools': patch
---

Add `structured_output`, a built-in tool that returns the model's object only when it validates against the consumer's zod schema, imported from the subpath `@theokit/sdk-tools/structured-output` (`createStructuredOutputTool({ schema })`). A valid call returns `{ ok: true, output }` with the parsed value; an invalid or non-object call returns the typed `invalid_structured_output` result with up to `maxIssues` `{ path, message }` issues and the full `issue_count`, and never throws. A schema that is not an object, or a `maxIssues` that is not a positive integer, fails at construction. The tool does not end the agent turn: the host stops on `ok: true`.
