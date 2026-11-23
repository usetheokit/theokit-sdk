---
"@theokit/sdk": major
---

The handle `Security.createMask(...).wrapStreams` returns now has `flush()`: it writes the text the mask holds back, masked, without removing the mask. Writes after it keep being masked.
