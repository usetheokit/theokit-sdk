---
"@theokit/sdk": minor
---

Seventeen symbols marked `@public` were reachable from no entry in the export map. They are now.

`@public` in a docblock is a promise that somebody outside the package is meant to name the symbol.
Nothing verified the promise, and the export map is exactly where it breaks quietly: a symbol can be
declared, documented, and compiled into a chunk while being importable from nowhere. A consumer
following the documentation got `has no exported member`.

Three of the seventeen are worth naming, because their kind made the gap expensive:

- **`CompressionFailedError`, `CompressionModelUnresolvedError`** — typed errors. `catch (e) { if (e
  instanceof CompressionFailedError) }` did not compile for any consumer, which is the entire reason
  a typed error exists rather than a message string.
- **`defineSubscription`** — a `define*` extension point, so the extension could not be written.
- **`withheldSpecs`** — names which instruction files a repository lost and which grant restores each
  one. It shipped unreachable in 5.7.0: the capability worked and the accessor did not.

Now importable: `AgentBuilderDeps`, `EnvPolicy`, `ForkOptions`, `ForkResult`, `HookApprovalGate`,
`HookApprovalRequest`, `LlmCallContext`, `ToolContext`, `createTokenLimiter`,
`createUnicodeNormalizer` (root); `admittedSpecs`, `withheldSpecs` (`/context`);
`CompressionFailedError`, `CompressionModelUnresolvedError`, `CompressionConfig` (`/compaction`);
`defineSubscription` (`/subscription`).

**One went the other way.** `truncateWithMarker` lost its marker rather than gaining an export: it is
a pure truncation helper whose docblock describes implementation edge cases, not a contract, and an
export is a semver commitment somebody then has to keep.

`withheldSpecs` also gained a named return type, `WithheldSpec`, and that is not style. The DTS
rollup only pulls a symbol into a chunk when a public type references it — with an anonymous return
type nothing referenced the function, the re-export dangled, and the build failed with TS2305 in
whichever file carried it. Naming the return value is what makes the function packable, and it gives
a consumer something to write in their own signature.

**A gate now holds the promise.** `quality:public-surface` generates one probe per export-map entry
and lets `tsc` answer which names it cannot resolve.
