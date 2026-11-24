# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report it through GitHub's private vulnerability reporting, which is enabled on this
repository:

**[Report a vulnerability](https://github.com/usetheokit/theokit-sdk/security/advisories/new)**

That form opens a private thread visible only to the maintainers. It is the only
channel we can promise to read for this — there is no security mailing list, and a
DM or a comment on an unrelated issue will be missed.

If you cannot use the form, open a public issue containing **only** the sentence
"requesting a private channel for a security report" and nothing about the finding
itself, and a maintainer will open the private thread.

### What to include

The same things any bug report needs, plus the reach of the problem:

- Affected package and version (`@theokit/sdk@4.53.0`, and whether other `@theokit/*`
  packages share the code path).
- What an attacker can do, stated concretely — read a file outside the workspace,
  reach the network from a sandboxed tool, recover a credential from a log.
- The smallest reproduction you have. A failing test is ideal; exact steps are fine.
- Whether it needs a specific configuration (a provider, a tool, a sandbox mode, an
  MCP server), or reproduces on defaults.
- Anything about the impact you are unsure of. An honest "I could reach X but not
  prove Y" is more useful than a guess in either direction.

**Never include a real credential in the report.** If a key of yours leaked, rotate it
first, then report the code path that leaked it.

### What to expect

- **Acknowledgement within 3 business days.** If you do not hear back, the report did
  not reach us — please ping the thread.
- **An assessment within 10 business days**: whether we can reproduce it, the severity
  we assign and why, and whether we intend to fix it.
- **A fix in a patch release** for anything we accept as a vulnerability, with a
  GitHub Security Advisory and a CVE where one applies.
- **Credit in the advisory** under the name you choose, unless you prefer not to be
  named.

We do not run a paid bounty programme.

### Disclosure

We ask for coordinated disclosure: give us the assessment window above before going
public, and we will agree a date with you rather than let a report sit indefinitely.
If a fix is going to take longer than expected, we will tell you why instead of going
quiet.

If you find a vulnerability that is already public, or being exploited, say so in the
report — that changes the timeline and we will treat it accordingly.

## Supported versions

| Version | Supported |
| --- | --- |
| `@theokit/sdk` 4.x (latest minor) | Yes |
| `@theokit/sdk` 4.x (older minors) | Upgrade to the latest 4.x |
| `@theokit/sdk` 3.x and earlier | No |

Fixes land on the latest minor. We do not backport to earlier minors — the codemods
under `@theokit/codemod-sdk-2-0` and `@theokit/codemod-sdk-3-0` exist to make the
upgrade mechanical.

The extension packages (`@theokit/sdk-*`, `@theokit/memory-*`, `@theokit/acp`,
`@theokit/cli`) are supported at their latest published version.

## What is in scope

This is an SDK that runs agent code: it spawns processes, resolves paths supplied by
callers, sandboxes tool execution, stores sessions on disk and forwards credentials to
model providers. Findings in any of that are in scope, in particular:

- Escaping the filesystem or network confinement of a sandboxed tool.
- Path traversal through a caller-supplied path (`path-safety`, session and memory
  storage).
- Leaking a credential into a log, a session transcript, an error message or a
  telemetry span.
- Prompt or tool-result content that reaches a shell, a file write or an HTTP request
  without the boundary the SDK claims to enforce.
- Cross-tenant leakage between memory or cache scopes.
- Supply-chain problems in what we publish: the released tarball's contents, its
  provenance attestation, or this repository's release workflow.

## What is not in scope

- A model producing wrong, harmful or biased output. That is a model property; the SDK
  does not claim to prevent it.
- An attacker who already has code execution on the developer's machine, or the
  contents of a `.env` the user chose to commit.
- Denial of service through obviously unbounded input to a local API, absent a concrete
  impact beyond the caller's own process.
- Vulnerabilities in a provider's service rather than in our client for it — report
  those to the provider.
- Anything requiring a configuration the documentation explicitly warns against, unless
  the warning itself is what turns out to be wrong.

When in doubt, report it. Deciding scope is our job, not yours.
