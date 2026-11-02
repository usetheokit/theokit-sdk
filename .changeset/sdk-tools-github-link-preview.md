---
'@theokit/sdk-tools': minor
---

Add `createGithubLinkPreviewTool`, imported from `@theokit/sdk-tools/github-link-preview`. It gives an
agent a `github_link_preview` tool that turns a github.com repository, issue or pull request URL into
`{ ok, kind, url, title, state, summary }`: `open`, `closed` or `merged` for issues and pull requests,
`active` or `archived` for repositories. The tool never requests the model's URL. It validates owner,
repository and number and calls one fixed `https://api.github.com` endpoint built from them, with
redirects refused. Defaults: a 10-second timeout covering the body read, a 1 MiB body cap and a
500-character summary; the timeout and summary length are options. The `token` option is optional,
reaches only that request and never appears in a result. Every failure is a typed result
(`unsupported_url`, `redirect_blocked`, `not_found`, `rate_limited` with `retry_after_seconds`,
`upstream_error`, `timeout`, `fetch_failed`, `invalid_response`), never a throw. The tool ships from its
own subpath because the root bundle has no room in its size budget.
