import { describe, expect, it } from "vitest";

import { parseV4A } from "../src/internal/v4a-patch.js";

/**
 * The error said a marker was missing while the marker was on screen.
 *
 * `parseV4A` matches the opening line exactly, so `*** Begin Patch ***` — the symmetric form a
 * writer reaches for by analogy with the `*** Add File: …` headers — scans to EOF and reports
 * `missing '*** Begin Patch'`. That sentence is true about the comparison and misleading about the
 * text: the string IS there, and the reader goes looking for an absent line instead of at the three
 * characters ending a line right in front of them.
 *
 * Measured 2026-09-13 on a live run against `openai/gpt-4o-2024-11-20`: three attempts spent on this
 * message, then the step abandoned and the file created with `run_shell` instead.
 *
 * The variant is deliberately NOT accepted. V4A is a format other tools parse too, and widening it
 * here would make a patch this runtime writes unreadable elsewhere. The error teaches the spelling.
 */
describe("the missing-Begin-Patch error", () => {
  it("names the near miss and what to remove", () => {
    const patch = ["*** Begin Patch ***", "*** Add File: a.txt", "+alpha", "*** End Patch"].join(
      "\n",
    );

    let message = "";
    try {
      parseV4A(patch);
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message, "the parser accepted a form it does not support").not.toBe("");
    expect(
      message,
      "the near miss is not quoted, so the reader cannot see the difference",
    ).toContain("*** Begin Patch ***");
    expect(message, "nothing tells the writer what to remove").toMatch(/trailing|Drop everything/);
  });

  it("still says the plain thing when there is no marker at all", () => {
    // The control. A patch with nothing resembling the marker must not be described as a near miss —
    // that would send the reader hunting for a line they never wrote.
    let message = "";
    try {
      parseV4A("just some text\n+alpha\n");
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain("missing '*** Begin Patch'");
    expect(message).not.toMatch(/trailing|Drop everything/);
  });

  it("catches any trailing suffix, not the one spelling that prompted it", () => {
    // The detection is `startsWith(BEGIN) && !== BEGIN`, so its reach is every trailing suffix. That
    // generality is the point of the fix and was asserted in the changeset before anything measured
    // it — a claim written to support its own argument is the one least likely to be checked.
    const patch = ["*** Begin Patch v2", "*** Add File: a.txt", "+alpha", "*** End Patch"].join(
      "\n",
    );

    let message = "";
    try {
      parseV4A(patch);
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message, "a suffix other than '***' fell through to the flat message").toContain(
      "*** Begin Patch v2",
    );
    expect(message).toMatch(/trailing|Drop everything/);
  });

  it("parses the correct spelling unchanged", () => {
    // The regression guard: the fix touches only the failure path, and a valid patch must be
    // unaffected by it.
    const patch = ["*** Begin Patch", "*** Add File: a.txt", "+alpha", "*** End Patch"].join("\n");

    expect(() => parseV4A(patch)).not.toThrow();
    expect(parseV4A(patch).length).toBeGreaterThan(0);
  });
});
