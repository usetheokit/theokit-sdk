/**
 * POSIX shell escaping for values interpolated into a `SandboxBackend.execute`
 * command string. `execute` runs via `/bin/sh -c`, so any untrusted value
 * (repo URL, ref, path) MUST be quoted to prevent command injection.
 *
 * @internal
 */

/**
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
