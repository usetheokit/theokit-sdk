# @theokit/sdk-pty

Local, `node-pty`-backed implementation of `@theokit/sdk`'s `InteractiveBackend`.

## Install

```bash
pnpm add @theokit/sdk-pty
```

`@theokit/sdk` (>=4.4.1) is a peer dependency. `node-pty` is an OPTIONAL dependency of this package,
so an environment that cannot build the native module still installs — and every method then throws
the SDK's typed `InteractiveUnavailableError`, which is the signal to fall back to non-interactive
exec rather than a crash at import time.

Opt-in and **terminal-surface only** — this is the ONLY package in the theokit
ecosystem that depends on `node-pty` (optionally, so install never fails on a
native build). Core / `@theokit/sdk-tools` / cluster / desktop backends never
touch it.

```ts
import { PtyInteractiveBackend } from "@theokit/sdk-pty";
// inject into an interactive shell tool that depends on InteractiveBackend
const interactive = new PtyInteractiveBackend();
```

When `node-pty` is unavailable (or a spawn fails), every method throws the SDK's
typed `InteractiveUnavailableError` so the caller falls back to non-interactive exec.

## Confined shell

`createConfinedPtyBackend` returns an `InteractiveBackend` where every session starts in `root`
(a `cwd` passed to `startInteractive` is ignored), runs under `interactiveWrapCommand({ mode })`
from `@theokit/sdk/sandbox`, and executes as `env -i <allowlisted vars> HOME=<root> /bin/sh -c <command>`.
The default allowlist is `PATH USER LOGNAME LANG LC_ALL LC_CTYPE TERM TZ`; override it with
`envAllowlist`, and the source with `sourceEnv` (default `process.env`). `maxSessions` defaults to 4.
The scrub applies to the executed command and its descendants; the outer PTY shell is spawned by
`node-pty` first.

```ts
import { createConfinedPtyBackend, probeConfinement } from "@theokit/sdk-pty";

const backend = createConfinedPtyBackend({ root, mode: "workspace-write" });
const proof = await probeConfinement(backend, { inside: `${root}/.probe`, outside: `${root}.probe` });
if (!proof.confined) console.warn(proof.reason, proof.detail); // do not enable the shell
```

`probeConfinement` starts a real session that touches `inside` and `outside`, waits up to
`timeoutMs` (default 3000) for `inside`, waits 300 ms more, then kills the session and removes both
files (use distinct, disposable paths). Results: `{ confined: true }`, or `confined: false` with
`reason` `cannot_write_inside`, `wrote_outside`, or `start_failed` (`startInteractive` rejected;
`detail` holds the message). A passing probe holds for this host at this moment only; if the
sandbox is unavailable `interactiveWrapCommand` wraps nothing, which the probe reports as
`wrote_outside`.

## API reference

Every symbol this package exports, with the exact specifier to import it from, is in the generated
capability map that ships inside `@theokit/sdk`:

```
node_modules/@theokit/sdk/docs/harness-capability-map.md   # symbol -> import specifier
node_modules/@theokit/sdk/docs/error-codes.md              # every `code` an error can carry
```

Both are generated from the built type declarations, so they describe the version you installed
rather than the version someone wrote a page about.
