---
"@theokit/sdk": patch
---

Sandbox egress proxy: restricted ranges are built from numeric prefixes, and IPv4 addresses are checked against an IPv4-only list so public IPv4 destinations are no longer refused by the IPv4-mapped IPv6 prefix. Tool-call input matching sorts keys with an explicit comparator.
