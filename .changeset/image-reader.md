---
"@theokit/sdk-tools": minor
---

Export `readImageFile` and `ReadImageResult`: the size-capped, single-descriptor image reader behind `view_image`, so a host that attaches images outside the tool no longer writes its own. It does no path confinement; apply your own policy to untrusted paths.
