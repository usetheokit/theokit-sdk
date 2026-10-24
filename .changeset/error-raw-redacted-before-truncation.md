---
"@theokit/sdk": patch
---

A provider error's `metadata.raw` no longer carries the start of a credential that sat across the
2048-character cut. The body used to be cut first and redacted after, so a key cut short of the
length its pattern needs matched nothing: 12 characters of an `sk-` key, or the key lines of a PEM
block before the cut, reached `metadata.raw` in clear. The whole body is now redacted and the
redacted text is cut. Two visible differences follow. A body that redaction shrinks to 2048
characters or fewer comes back whole, with no `…`. And when the text is still longer, the cut can
fall inside a mask such as `sk-V2w...y5Z6`, which leaves part of the mask and never more of the key
than the mask itself shows. Redaction reads at most the first 64 KiB of the body, so its cost has a
bound whatever the provider returns. A longer body comes back cut, always with `…`, and without the
last 16 KiB of its redacted text, where a credential cut by that bound could sit. A pattern
registered with `Security.addPattern` now sees up to those 64 KiB, not the first 2048 characters, so
it should stay linear in its input. The cut also no longer splits a surrogate pair, such as an
emoji, at the 2048th character.
