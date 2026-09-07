---
"@theokit/sdk": patch
---

README: say that `.theokit/settings.json` is read, because it is

Docs only. The `## Hooks` section named `.theokit/hooks.json` and nothing else, and the only mention of `settings.json` / `settings.local.json` sat in the Claude Code compatibility table — which reads as being about `.claude/`.

So a reader asking *"what does this package read in `.theokit/`?"* got `hooks.json`, full stop. That answer is wrong: `hookConfigCandidates` reads `hooks.json`, `settings.json` and `settings.local.json` from **every** config root, and `theokitConfigRoot` is always one of them.

This is not an omission that merely leaves someone uninformed — it returns the wrong answer to the person doing the right thing. Measured in 2026-09: a consumer put its own configuration in `.theokit/settings.json` with a `hooks` array of its own shape, and hit a hard refusal on **every turn**. The file parsed perfectly for the product that wrote it; the collision was one of shape, not of location, and nothing in this README would have warned them.

The section now names all three files and states the consequence: `.theokit/` is this package's filebase, so a `hooks` key there is read and validated here, whatever else wrote the file.
