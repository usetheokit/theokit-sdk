import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { shellEscapePosix } from "../../src/sandbox/index.js";

const HOSTILE = [
  'it\'s a "quoted" value',
  "$(touch /tmp/should-not-exist) and $HOME",
  "`id`",
  "line one\nline two",
  "-rf --no-preserve-root",
  "back\\slash \\' and \\\\",
  "",
];

describe("shellEscapePosix from the public sandbox subpath", () => {
  it.each(HOSTILE)("round-trips %j through sh -c printf", (input) => {
    const out = execFileSync("sh", ["-c", `printf %s ${shellEscapePosix(input)}`], {
      encoding: "utf8",
    });

    expect(out).toBe(input);
  });

  it("round-trips a hostile value passed as the argument after a leading dash", () => {
    const hostile = "-n '$(id)'\n`id`";

    const out = execFileSync("sh", ["-c", `printf '%s|' -- ${shellEscapePosix(hostile)}`], {
      encoding: "utf8",
    });

    expect(out).toBe(`--|${hostile}|`);
  });
});
