---
'@theokit/sdk-tools': patch
---

The optional `simple-git` peer range moves from `^3.0.0` to `^4.0.1`. Every 3.x release up to
3.36.0 is covered by published advisories (GHSA-x6jw-m9v5-85vh, GHSA-g4wm-2vf7-vfgr,
GHSA-858h-whjf-mvg5): Git configuration includes and abbreviated long options can lead to command
execution. 4.0.1 is the first release that fixes all of them.

No tool in this package imports `simple-git`. `createGitDiffTool` and `createGitStatusTool` run
`git` as a child process, so their behaviour does not change. A project that still has
`simple-git` 3.x installed gets an unmet-peer warning and nothing else.
