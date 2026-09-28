---
'@theokit/sdk': patch
---

The provider catalog is embedded at build time instead of read from disk, so the SDK runs on a
runtime with no filesystem.

`loadProviderCatalog` read `provider-catalog.json` with `readFileSync`, from a directory computed as
`dirname(fileURLToPath(import.meta.url))` at module scope. Both halves break on Cloudflare Workers,
Vercel Functions and any bundled deployment — and the catalog is only model METADATA, so an
environment that could not read it could not run a turn at all.

Measured end to end while deploying a TheoKit app (theokit#705). Cloudflare executes the top-level
module during validation, so the upload was refused before any request existed with
`The "path" argument must be of type string … Received undefined` (code 10021). With
`import.meta.url` substituted by the consumer's bundler the module initialised and the turn failed
with `[unenv] fs.readFileSync is not implemented yet!`; with a newer `compatibility_date` that became
the honest `ENOENT: readAll '/provider-catalog.json'`. The same `ENOENT` reached a deployed Vercel
function, whose bundle carries the JS and not the JSON.

No consumer's bundler could fix it from outside. Probed from inside a deployed worker, workerd's
whole virtual filesystem is `/bundle/worker.js`, an empty `/tmp` and `/dev` — there is nowhere to
place this package's private data file such that `join(dirname(<a file URL>), …)` finds it, short of
hardcoding our internal layout into their build.

The import uses `with { type: "json" }`, following `internal/budget/pricing-registry.ts`, which has
imported a sibling JSON that way in this package for as long as it has existed. Bundlers inline it,
so the emitted module carries the data and reaches for nothing. The build no longer copies the JSON
into `dist`, because nothing reads it there.
