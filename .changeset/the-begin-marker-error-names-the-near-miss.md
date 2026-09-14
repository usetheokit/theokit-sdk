---
"@theokit/sdk-tools": patch
---

A V4A patch opening with `*** Begin Patch ***` now gets an error that names the near miss.

The message was `Invalid patch: missing '*** Begin Patch'`. That is true about the exact match and
misleading about the text on screen: the symmetric form CONTAINS the string it says is missing, so a
writer greps for an absent line while the defect is three characters at the end of a line already
there.

Measured on a live run: a model wrote the symmetric form by analogy with the `*** Add File: …`
headers this format also uses, spent three attempts against the old message, and abandoned the step.
The analogy is the reason the mistake is common — every other marker in V4A carries a trailing
token, and this one does not.

The variant is **not** accepted. V4A is parsed by other tools, and widening it here would make a
patch this runtime writes unreadable elsewhere. The error teaches the exact spelling instead: it
quotes the offending line back and says which part to drop.

Detection is a near-miss test — a line that starts with the marker and is not equal to it — so it
also covers `*** Begin Patch v2` and any other trailing suffix, not the one spelling that prompted
it. A patch with no marker at all keeps the original message.
