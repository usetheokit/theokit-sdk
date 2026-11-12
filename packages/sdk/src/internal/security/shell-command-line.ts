/**
 * Reads a shell command line as the list of commands it runs, for permission rules.
 *
 * A line such as `git status && ls $(pwd)` runs three commands, and a rule about one of them has to
 * see each of them. The reader splits outside quotes on `;`, `&&`, `||`, `|`, `&` and newlines, and
 * reads the contents of `$(...)`, backticks, `<(...)`, `>(...)` and `( ... )` subshells as further
 * commands. A comment is dropped up to the end of its line, and a leading reserved word (`if`,
 * `then`, `do`, `{`, `!` and the like) is dropped from the command it introduces.
 *
 * It is NOT a shell. It does not expand variables, aliases or functions, and it does not look inside
 * a command that runs another one (`sudo`, `env`, `xargs`, `sh -c`, `eval`). A line with a construct
 * it does not follow (an unbalanced quote or parenthesis, a heredoc, a `(` that does not open a
 * subshell) is reported as unreadable rather than guessed at, and the caller decides what an
 * unreadable line means.
 */

/** One command of a line, in two spellings: as written, and with quotes and escapes removed. */
export interface ShellCommand {
  /** The command as written, trimmed, without a leading reserved word. */
  readonly raw: string;
  /** The same text after quote removal: `"rm" -rf /` reads `rm -rf /`. */
  readonly unquoted: string;
}

export interface ShellCommandLine {
  /** Every command the line runs, outermost first within each nesting level. */
  readonly commands: readonly ShellCommand[];
  /** `false` when the line holds a construct this reader does not follow. */
  readonly readable: boolean;
}

/** Words that open or continue a compound command; the command they introduce follows them. */
const RESERVED_WORDS = new Set([
  "!",
  "{",
  "}",
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "while",
  "until",
  "do",
  "done",
  "time",
]);

const SEPARATORS = new Set([";", "&", "|", "\n"]);
const WORD_BREAKS = new Set([" ", "\t", "\n", ";", "&", "|", "(", ")"]);

class UnreadableShellLine extends Error {}

interface Segment {
  raw: string;
  unquoted: string;
}

/** Split `line` into the commands it runs. Never throws. */
export function readShellCommandLine(line: string): ShellCommandLine {
  const commands: ShellCommand[] = [];
  try {
    new ShellLineReader(line, commands).readList(false);
    return { commands, readable: true };
  } catch (error) {
    // A RangeError is the call stack running out on a line nested too deeply to read, which is an
    // unreadable line, not a failure of the permission check that asked.
    if (error instanceof UnreadableShellLine || error instanceof RangeError) {
      return { commands, readable: false };
    }
    throw error;
  }
}

class ShellLineReader {
  #pos = 0;

  constructor(
    private readonly src: string,
    private readonly out: ShellCommand[],
  ) {}

  /** Read commands up to the end of the input, or up to the `)` that closes a nested list. */
  readList(nested: boolean): void {
    let segment: Segment = { raw: "", unquoted: "" };
    while (this.#pos < this.src.length) {
      const ch = this.src.charAt(this.#pos);
      if (ch === ")") {
        if (!nested) throw new UnreadableShellLine();
        this.#pos += 1;
        this.#flush(segment);
        return;
      }
      if (this.#isSeparator(ch)) {
        this.#pos += 1;
        this.#flush(segment);
        segment = { raw: "", unquoted: "" };
        continue;
      }
      this.#step(ch, segment);
    }
    if (nested) throw new UnreadableShellLine();
    this.#flush(segment);
  }

  #step(ch: string, segment: Segment): void {
    const read = this.#readerFor(ch, this.src.charAt(this.#pos + 1));
    if (read === undefined) this.#append(segment, ch, ch);
    else read(segment);
  }

  /** The construct a character opens outside quotes, or `undefined` for a plain character. */
  #readerFor(ch: string, next: string): ((segment: Segment) => void) | undefined {
    const pair = this.#pairReaderFor(ch + next);
    if (pair !== undefined) return pair;
    switch (ch) {
      case "'":
        return (s) => this.#singleQuoted(s);
      case '"':
        return (s) => this.#doubleQuoted(s);
      case "\\":
        return (s) => this.#escaped(s, false);
      case "`":
        return (s) => this.#backticks(s);
      case "(":
        return (s) => this.#subshell(s);
      case "#":
        return this.#atWordStart() ? () => this.#comment() : undefined;
      default:
        return undefined;
    }
  }

  /** Two-character openers: substitutions, `$'...'` and the `<<` family. */
  #pairReaderFor(pair: string): ((segment: Segment) => void) | undefined {
    switch (pair) {
      case "$(":
      case "<(":
      case ">(":
        return (s) => this.#substitution(s, 2);
      case "$'":
        return (s) => this.#ansiQuoted(s);
      case "<<":
        return (s) => this.#hereString(s);
      default:
        return undefined;
    }
  }

  /** `&` and `|` that belong to a redirection (`2>&1`, `&>file`, `>|file`) do not split. */
  #isSeparator(ch: string): boolean {
    if (!SEPARATORS.has(ch)) return false;
    const before = this.src.charAt(this.#pos - 1);
    const after = this.src.charAt(this.#pos + 1);
    if (ch === "&") return before !== ">" && before !== "<" && after !== ">";
    if (ch === "|") return before !== ">";
    return true;
  }

  #append(segment: Segment, raw: string, unquoted: string): void {
    segment.raw += raw;
    segment.unquoted += unquoted;
    this.#pos += raw.length;
  }

  #singleQuoted(segment: Segment): void {
    const close = this.src.indexOf("'", this.#pos + 1);
    if (close === -1) throw new UnreadableShellLine();
    const body = this.src.slice(this.#pos + 1, close);
    this.#append(segment, `'${body}'`, body);
  }

  /** `$'...'`: a single-quoted string in which a backslash escapes the next character. */
  #ansiQuoted(segment: Segment): void {
    const start = this.#pos;
    let unquoted = "";
    let i = this.#pos + 2;
    while (i < this.src.length && this.src.charAt(i) !== "'") {
      if (this.src.charAt(i) === "\\") i += 1;
      unquoted += this.src.charAt(i);
      i += 1;
    }
    if (i >= this.src.length) throw new UnreadableShellLine();
    this.#append(segment, this.src.slice(start, i + 1), unquoted);
  }

  #doubleQuoted(segment: Segment): void {
    this.#append(segment, '"', "");
    while (this.#pos < this.src.length) {
      const ch = this.src.charAt(this.#pos);
      if (ch === '"') {
        this.#append(segment, '"', "");
        return;
      }
      this.#stepInDoubleQuotes(ch, segment);
    }
    throw new UnreadableShellLine();
  }

  #stepInDoubleQuotes(ch: string, segment: Segment): void {
    if (ch === "\\") this.#escaped(segment, true);
    else if (ch === "`") this.#backticks(segment);
    else if (ch === "$" && this.src.charAt(this.#pos + 1) === "(") this.#substitution(segment, 2);
    else this.#append(segment, ch, ch);
  }

  /** A backslash. Inside double quotes it only escapes `$`, `` ` ``, `"`, `\` and a newline. */
  #escaped(segment: Segment, inDoubleQuotes: boolean): void {
    if (this.#pos + 1 >= this.src.length) throw new UnreadableShellLine();
    const next = this.src.charAt(this.#pos + 1);
    const escapes = !inDoubleQuotes || '$`"\\'.includes(next);
    const unquoted = next === "\n" ? "" : escapes ? next : `\\${next}`;
    this.#append(segment, `\\${next}`, unquoted);
  }

  /** `$(...)`, `<(...)` or `>(...)`: the body is a list of commands of its own. */
  #substitution(segment: Segment, openerLength: number): void {
    const start = this.#pos;
    this.#pos += openerLength;
    this.readList(true);
    const text = this.src.slice(start, this.#pos);
    segment.raw += text;
    segment.unquoted += text;
  }

  #backticks(segment: Segment): void {
    let close = this.#pos + 1;
    while (close < this.src.length && this.src.charAt(close) !== "`") {
      close += this.src.charAt(close) === "\\" ? 2 : 1;
    }
    if (close >= this.src.length) throw new UnreadableShellLine();
    const body = this.src.slice(this.#pos + 1, close);
    // Inside backticks the shell first turns an escaped backtick, `$` or backslash into the bare
    // character. That is how a substitution nested in another one is written.
    const unescaped = body.replace(/\\([`$\\])/g, "$1");
    new ShellLineReader(unescaped, this.out).readList(false);
    const text = `\`${body}\``;
    this.#append(segment, text, text);
  }

  /** `<<<` is a here-string and reads on; `<<` starts a heredoc, whose body this reader cannot see. */
  #hereString(segment: Segment): void {
    if (this.src.charAt(this.#pos + 2) !== "<") throw new UnreadableShellLine();
    this.#append(segment, "<<<", "<<<");
  }

  /** `( ... )` where a command starts is a subshell; a `(` anywhere else is not followed. */
  #subshell(segment: Segment): void {
    if (stripReservedWords(segment.raw.trim()) !== "") throw new UnreadableShellLine();
    this.#pos += 1;
    this.readList(true);
  }

  #atWordStart(): boolean {
    return this.#pos === 0 || WORD_BREAKS.has(this.src.charAt(this.#pos - 1));
  }

  /** A comment runs to the end of its line; the newline still separates commands. */
  #comment(): void {
    const end = this.src.indexOf("\n", this.#pos);
    this.#pos = end === -1 ? this.src.length : end;
  }

  #flush(segment: Segment): void {
    const raw = stripReservedWords(segment.raw.trim());
    if (raw === "") return;
    this.out.push({ raw, unquoted: stripReservedWords(segment.unquoted.trim()) });
  }
}

function stripReservedWords(text: string): string {
  let rest = text;
  for (;;) {
    const match = /^(\S+)(\s+|$)/.exec(rest);
    if (match === null || !RESERVED_WORDS.has(match[1] ?? "")) return rest;
    rest = rest.slice(match[0].length);
  }
}
