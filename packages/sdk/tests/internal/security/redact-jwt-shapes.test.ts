/**
 * The JWT step of `redactSecrets` must mask exactly what it masked at `1456fee2`.
 *
 * The JWT entry of BUILTIN_PATTERNS was a regex, `eyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}`,
 * quadratic on a run of `eyJ` it cannot complete. Replacing it with a scan moves the boundary of what
 * is masked, so every row below pins the output the regex gave, printed by `redactSecrets` at that
 * commit. Each row is green before the scan and must stay green after it. Three rows (the second run
 * failing with an `eyJ` later in it, an `eyJ` inside the second run, and a letter glued before a
 * first segment of 3) exist because a plausible wrong scan passed every other row.
 */
import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../../src/internal/security/index.js";

/** The well-formed three-segment token the discovery's RED file uses. */
const STANDARD_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

describe("redactSecrets masks the same JWT shapes as the regex it replaced", () => {
  it("masks the standard token to the maskToken shape", () => {
    expect(redactSecrets(`a ${STANDARD_TOKEN} b`)).toBe("a eyJhbG...sw5c b");
  });

  it("masks a token whose segments sit at the 4-character floor", () => {
    expect(redactSecrets("a eyJabcd.eyJefgh.ijkl b")).toBe("a eyJabc...ijkl b");
  });

  it("leaves a token whose first segment has 3 characters unchanged", () => {
    expect(redactSecrets("a eyJabc.eyJefgh.ijkl b")).toBe("a eyJabc.eyJefgh.ijkl b");
  });

  it("leaves a token whose second segment has 3 characters unchanged", () => {
    expect(redactSecrets("a eyJabcd.eyJefg.ijkl b")).toBe("a eyJabcd.eyJefg.ijkl b");
  });

  it("leaves a token whose third segment has 3 characters unchanged", () => {
    expect(redactSecrets("a eyJabcd.eyJefgh.ijk b")).toBe("a eyJabcd.eyJefgh.ijk b");
  });

  it("masks a token whose segments hold - and _", () => {
    expect(redactSecrets("a eyJa-_d.eyJe_-h.i-_l b")).toBe("a eyJa-_...i-_l b");
  });

  it("masks a token glued to a preceding letter from its eyJ", () => {
    expect(redactSecrets("a xeyJabcd.eyJefgh.ijkl b")).toBe("a xeyJabc...ijkl b");
  });

  it("leaves a token glued to a letter with a first segment of 3 unchanged", () => {
    expect(redactSecrets("a xeyJabc.eyJefgh.ijkl b")).toBe("a xeyJabc.eyJefgh.ijkl b");
  });

  it("masks two tokens in one string", () => {
    expect(redactSecrets("a eyJabcd.eyJefgh.ijkl b eyJmnop.eyJqrst.uvwx c")).toBe(
      "a eyJabc...ijkl b eyJmno...uvwx c",
    );
  });

  it("takes a long third segment whole", () => {
    expect(redactSecrets("a eyJabcd.eyJefgh.ijklmnopqrst b")).toBe("a eyJabc...qrst b");
  });

  it("masks a second token that follows a third segment and a dot", () => {
    expect(redactSecrets("a eyJa1234.eyJb1234.c1234.eyJd1234.eyJe1234.f1234 b")).toBe(
      "a eyJa12...1234.eyJd12...1234 b",
    );
  });

  it("masks the next run when a first run fails", () => {
    expect(redactSecrets("a eyJa.eyJbbbb.eyJcccc.dddd b")).toBe("a eyJa.eyJbbb...dddd b");
  });

  it("masks a later run when a second segment is short", () => {
    expect(redactSecrets("a eyJaaaa.eyJbb.eyJcccc.eyJdddd.eeee b")).toBe(
      "a eyJaaaa.eyJbb.eyJccc...eeee b",
    );
  });

  it("masks from the first eyJ when a second eyJ sits inside the first run", () => {
    expect(redactSecrets("a eyJ1eyJ2222.eyJ3333.4444 b")).toBe("a eyJ1ey...4444 b");
  });

  it("starts a token at an eyJ later in a second run that failed", () => {
    expect(redactSecrets("a eyJaaaa.abeyJcccc.eyJdddd.eeee b")).toBe("a eyJaaaa.abeyJccc...eeee b");
  });

  it("leaves a token whose second run holds eyJ only after its start unchanged", () => {
    expect(redactSecrets("a eyJaaaa.xeyJbbbb.cccc b")).toBe("a eyJaaaa.xeyJbbbb.cccc b");
  });

  it("leaves a second segment without eyJ unchanged", () => {
    expect(redactSecrets("a eyJabcd.abcd.efgh b")).toBe("a eyJabcd.abcd.efgh b");
  });

  it("leaves a token with two segments only unchanged", () => {
    expect(redactSecrets("a eyJabcd.eyJefgh b")).toBe("a eyJabcd.eyJefgh b");
  });

  it("leaves a first run ended by + unchanged", () => {
    expect(redactSecrets("a eyJab+d.eyJefgh.ijkl b")).toBe("a eyJab+d.eyJefgh.ijkl b");
  });

  it("leaves an uppercase EYJ token unchanged", () => {
    expect(redactSecrets("a EYJabcd.EYJefgh.ijkl b")).toBe("a EYJabcd.EYJefgh.ijkl b");
  });

  it("masks a token between non-ASCII characters", () => {
    expect(redactSecrets("éeyJabcd.eyJefgh.ijklé")).toBe("éeyJabc...ijklé");
  });

  it("masks a JWT after Bearer to Bearer ***", () => {
    expect(redactSecrets(`Authorization: Bearer ${STANDARD_TOKEN}`)).toBe(
      "Authorization: Bearer ***",
    );
  });

  it("keeps the masked prefix after jwt=, so the JWT step runs before the key=value sweep", () => {
    expect(redactSecrets(`jwt=${STANDARD_TOKEN}`)).toBe("jwt=eyJhbG...sw5c");
  });
});
