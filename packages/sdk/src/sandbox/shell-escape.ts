/**
 * POSIX shell escaping for values interpolated into a `SandboxBackend.execute`
 * command string. `execute` runs via `/bin/sh -c`, so any untrusted value
 * (repo URL, ref, path) MUST be quoted to prevent command injection.
 */

/**
 * Quotes `arg` as one word for POSIX `sh`, for a command line you build yourself and hand to
 * `SandboxBackend.execute`. A value from outside cannot end the word and start another command,
 * whatever it holds: quotes, `$()`, backticks, newlines, backslashes. An empty string comes back as
 * `''`. Quoting does not stop the program you call from reading a leading dash as an option, so put
 * `--` before the value for one that parses options. The derived helpers and `provisionRepo` use this
 * same quoter.
 *
 * Wrap `arg` in single quotes, escaping embedded single quotes (`'\''`). A backslash before a quote,
 * a backslash or the end is written outside the quotes too (`'\\'`), so the word parses the same
 * under fish, which reads `\'` and `\\` inside single quotes as escapes, as under sh (B-600): the PTY
 * runs the sandbox wrap under the user's `$SHELL`. After the first pass an original quote reads
 * `'\''`, whose own backslash is always followed by `''`, so the second pass never matches it.
 */
export function shellEscapePosix(arg: string): string {
  const quotesEscaped = arg.replace(/'/g, "'\\''");
  return `'${quotesEscaped.replace(/\\(?=\\|'\\''|$)/g, "'\\\\'")}'`;
}
