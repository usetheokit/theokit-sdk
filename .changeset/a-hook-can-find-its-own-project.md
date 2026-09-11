---
"@theokit/sdk": patch
---

A native hook can locate its own project, and a ported hook script receives the field names it was written against.

**The project directory, in both dialects.** `CLAUDE_PROJECT_DIR` was supplied to commands imported
from Claude Code (#522, after a hook written the documented way expanded to a leading `/` and denied
every turn). The native dialect got `{}`, on the reasoning that a `.theokit/` hook "is written
against THIS runtime and inherits it already" — true of the runtime's *behaviour*, not of a project
*path*. Nothing in the inherited environment says where the project is, so a native hook had to
depend on the process cwd: the exact dependency the foreign fix removed. `THEOKIT_PROJECT_DIR` is
the native counterpart, under the native spelling, because a ported script reaches for the name its
own docs use.

**The stdin payload.** It carried this runtime's field names only. A script ported from Claude Code
reads `tool_name`, `tool_input`, `tool_response`, `hook_event_name` and `cwd` — it got `undefined`
for every one, and **ran**, deciding on nothing while looking like a working guard. That is worse
than a script that fails: the operator's evidence that the guard works is identical either way.

The documented names are added **beside** the existing ones, never instead. Both dialects execute
through one path, so renaming would break every native script to fix the ported ones.

Only what this runtime knows. `session_id`, `transcript_path`, `permission_mode` and `prompt_id`
stay absent because their values would have to be invented — a script that branches on an invented
session id branches on a lie. Same trade as `CLAUDE_PLUGIN_ROOT`, which stays unset for the same
reason one module over.
