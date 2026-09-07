---
"@theokit/sdk": minor
---

`listSessions` — enumerate sessions, and say where each id came from (#598)

Every transcript helper this package published mapped **forward** — `sessionUuidFor`,
`transcriptPath`, `legacyTranscriptPath`, `encodeProjectDir`, `transcriptRoot`. **None enumerated.**
So a consumer that needed the list rebuilt it, and two independent ones did, in opposite directions,
and both derived the session id from the **filename**:

| consumer | direction | what broke |
|---|---|---|
| `@theokit/agents` | file → id | `sessionIdOf` returned the file stem |
| a downstream agent runtime | id → file | compared session ids against filenames |

The second was measured against `5.0.1`: the protected set never matched, so **neither the registered
sessions nor the live one were protected and everything classified as an orphan** — a garbage
collector that would delete the session in use.

```ts
import { listSessions } from "@theokit/sdk/persistence";

for (const s of await listSessions(process.cwd())) {
  if (s.idSource === "unavailable") continue;   // do not guess, and do not delete
  …
}
```

**Documentation was not the fix, and that is the argument for the primitive.** The rename was
documented thoroughly. One of those two consumers had *read* it and broke anyway; the other had not
and broke identically. Two samples, one informed and one not, the same defect — so the cause is the
shape of the surface rather than the reader. Nor can it be closed with an inverse: the filename is a
UUIDv8 over SHA-256, which has none.

**Every entry carries `idSource`, and an unreadable id is `undefined` rather than guessed.** An
`id: string` that is sometimes read from the transcript and sometimes inferred is the same defect one
layer up — a value that reads as authoritative and occasionally is not, which is exactly what
produced the garbage-collector failure. A caller deciding what to *delete* needs to tell "not
registered" from "I could not read this file"; in a plain list those look identical and mean opposite
things.

Reading is capped (64KB by default, `idScanBytes`) because the id lives in the first record and a
transcript grows without bound: bounded work with a declared outcome beats an unbounded read.

Evidence gathered by the `theocode` session, which measured its own failure and obtained the
sibling's `file:line` rather than paraphrasing it.
