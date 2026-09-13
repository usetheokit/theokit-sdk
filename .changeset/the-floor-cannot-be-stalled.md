---
'@theokit/sdk': patch
---

Fixes a ReDoS in the critical-path floor's destructive-command matcher (CodeQL: polynomial regular
expression on uncontrolled data).

```
/(?:^|[;&|]\s*)\s*(rm|rmdir|shred|mkfs\S*|dd)\s/
             ^^^  ^^^   adjacent quantifiers over overlapping classes
                        and an unbounded \S* inside the alternation
```

Measured on the inputs CodeQL named: 60 000 spaces after a `;` took **2 094ms**, and 12 000 `&mkfs`
repetitions took **600ms** — clean quadratic growth. After the rewrite, 0.36ms and 0.33ms.

It mattered because of the commit beside it. While nothing called the floor, a slow matcher was a
latent cost; wiring the floor into `permission-plugin.ts` put it in front of **every tool call**, so
one crafted argument stalls the agent instead of being refused by it. Making a guard reachable and
making its cost matter are the same act.

The separator no longer consumes whitespace the following `\s*` already consumes, and the `mkfs`
suffix is a bounded dotted variant (`mkfs.ext4`, `mkfs.xfs`, `mkfs.btrfs`) rather than "any run of
non-space". Verified identical across thirteen cases spanning every branch.

Also documented, because measuring it turned it up: a DEVICE NODE is not a critical path.
`mkfs.ext4 /dev/sda` and `dd of=/dev/sda` pass this floor — the tier is about the working directory,
the home directory and the filesystem root, and `/dev/sda` is none of them. A reader who sees `mkfs`
in the pattern reasonably concludes otherwise, so a test now pins the real behaviour.
