/**
 * `ErrorMetadata.raw` must not carry a credential that straddles the 2048-character cut.
 *
 * `truncateRaw` must redact the whole body before it cuts: a slice taken first leaves a key cut
 * short of its pattern's minimum length, which matches nothing, so its leading fragment would reach
 * `raw` in clear. Every key below
 * is synthetic, and the filler before each one is neutral text: a `token=` or `Bearer` prefix would
 * let the parametric sweep mask the fragment by another route and hide the vendor-pattern gap.
 */

import { describe, expect, it } from "vitest";

import { buildErrorMetadata } from "../../../src/internal/error-mappers/shared.js";
import { maskToken } from "../../../src/internal/security/redact.js";
import { _resetForTests } from "../../../src/internal/security/test-reset.js";

const CUT = 2048;
const PREFIX = '{"error":{"message":"upstream rejected the request: ';

function bodyWithKeyAt(key: string, keyStart: number): string {
  const filler = "x".repeat(keyStart - PREFIX.length);
  const body = `${PREFIX}${filler}${key} trailing text"}}`;
  expect(body.indexOf(key)).toBe(keyStart);
  return body;
}

function rawOf(body: string): string {
  const meta = buildErrorMetadata({
    provider: "openai",
    endpoint: "/v1/chat/completions",
    code: "invalid_request",
    status: 400,
    headers: undefined,
    body,
  });
  expect(typeof meta.raw).toBe("string");
  return meta.raw as string;
}

/** Where a window design would have cut the body before redacting it (the refused alternatives). */
const WINDOW = 16384;
const JWT_HEADER = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
const HOSTILE_LENGTH = 224_000;
const COST_BOUND_MS = 500;
const COST_CASE_TIMEOUT_MS = 120_000;

/** `count` distinct synthetic 64-character key lines, none shaped like a vendor credential. */
function keyLines(tag: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    `${tag}${String(i).padStart(2, "0")}${"qRsTuVwXyZab".repeat(6)}`.slice(0, 64),
  );
}

function pemBlock(label: string, lines: string[]): string {
  return `-----BEGIN ${label}PRIVATE KEY-----\n${lines.join("\n")}\n-----END ${label}PRIVATE KEY-----`;
}

function padTo(body: string, length: number): string {
  const padded = `${body} ${"y".repeat(length - body.length - 1)}`;
  expect(padded).toHaveLength(length);
  return padded;
}

/**
 * Eleven PEM blocks of 20 key lines, filler, then `credential` at `credentialStart`. Redaction
 * shrinks each block to 13 characters, which pulls the credential from past the 16384-character
 * window to well inside the 2048-character cut.
 */
function deepBody(credential: string, credentialStart: number, length?: number): string {
  const blocks = Array.from({ length: 11 }, (_, i) => pemBlock("", keyLines(`Deep${i}`, 20))).join(
    "\n",
  );
  const lead = `${PREFIX}${blocks}\n`;
  const filler = "x".repeat(credentialStart - lead.length - 1);
  const head = `${lead}${filler} ${credential}`;
  const body =
    length === undefined ? `${head} end"}}` : `${head} ${"e".repeat(length - head.length - 4)}"}}`;
  expect(body.indexOf(credential)).toBe(credentialStart);
  if (length !== undefined) expect(body).toHaveLength(length);
  return body;
}

function repeatTo(unit: string, length: number): string {
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
}

/**
 * Where a refused design capped the text passed to redaction (review round 2): a credential the cap
 * cut stayed in clear, and a fixed edge drop after it is shorter than a JWT or PEM block can be.
 */
const SIXTY_FOUR_KIB = 65_536;
const PAST_THE_BLOCKS_MARKER = "MARKER-AFTER-THE-KEY-BLOCKS";

/**
 * Private key blocks until one straddles 64 KiB, then a marker. Redaction shrinks each whole block
 * to its 13-character mask, so the redacted body is short enough to come back whole.
 */
function bodyOfKeyBlocksPast64Kib(): { body: string; blocks: string[] } {
  let body = PREFIX;
  const blocks: string[] = [];
  for (let i = 0; body.length <= SIXTY_FOUR_KIB; i++) {
    const block = pemBlock("", keyLines(`Cap${String(i).padStart(3, "0")}`, 20));
    blocks.push(block);
    body += `${block}\n`;
  }
  expect(body.lastIndexOf("-----BEGIN")).toBeLessThan(SIXTY_FOUR_KIB);
  return { body: `${body} ${PAST_THE_BLOCKS_MARKER} end"}}`, blocks };
}

function maskEach(body: string, credentials: string[]): string {
  return credentials.reduce(
    (text, credential) => text.replace(credential, maskToken(credential)),
    body,
  );
}

/** Best of three runs after one warm-up, as the redact linear guards measure. */
function bestElapsedMs(run: () => unknown): number {
  run();
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 3; i++) {
    const started = performance.now();
    run();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

describe("ErrorMetadata.raw redaction at the truncation boundary", () => {
  it("does_not_keep_the_clear_prefix_of_an_sk_key_cut_12_characters_before_the_limit", () => {
    const key = `sk-${"A1b2C3d4E5".repeat(3)}`;
    const keyStart = CUT - 12;
    const fragment = key.slice(0, 12);

    const raw = rawOf(bodyWithKeyAt(key, keyStart));

    expect(raw).not.toContain(fragment);
  });

  it("does_not_keep_the_clear_prefix_of_a_ghp_token_cut_39_characters_before_the_limit", () => {
    const key = `ghp_${"Z9y8X7w6V5".repeat(3)}Z9y8X7`;
    expect(key).toHaveLength(40);
    const keyStart = CUT - 39;
    const fragment = key.slice(0, 39);

    const raw = rawOf(bodyWithKeyAt(key, keyStart));

    expect(raw).not.toContain(fragment);
  });

  it("still_masks_a_key_wholly_inside_the_limit_to_the_maskToken_shape", () => {
    const key = `sk-${"Q7r8S9t0U1".repeat(3)}`;
    const raw = rawOf(bodyWithKeyAt(key, 200));

    expect(raw).not.toContain(key);
    expect(raw).toContain(maskToken(key));
  });
  it("masks_a_private_key_block_that_straddles_the_limit", () => {
    const lines = keyLines("PkLine", 20);
    const block = pemBlock("", lines);
    const blockStart = CUT - 600;
    const body = bodyWithKeyAt(block, blockStart);
    expect(blockStart + block.length).toBeGreaterThan(CUT);

    const raw = rawOf(body);

    for (const line of lines) expect(raw).not.toContain(line);
  });

  it("keeps_raw_within_2049_characters_ending_with_an_ellipsis", () => {
    const key = `sk-${"M4n5O6p7Q8".repeat(3)}`;
    const straddling = padTo(bodyWithKeyAt(key, CUT - 12), 3000);
    const longRaw = rawOf(straddling);
    expect(longRaw.length).toBeLessThanOrEqual(CUT + 1);
    expect(longRaw.endsWith("…")).toBe(true);

    expect(rawOf(padTo(PREFIX, 2000)).endsWith("…")).toBe(false);

    const block = pemBlock("", keyLines("Shrink", 15));
    const shrinking = padTo(bodyWithKeyAt(block, 300), 2100);
    expect(shrinking.length).toBeGreaterThan(CUT);
    expect(rawOf(shrinking)).toBe(shrinking.replace(block, maskToken(block)));

    const exact = "z".repeat(CUT);
    expect(rawOf(exact)).toBe(exact);
    const oneOver = "z".repeat(CUT + 1);
    expect(rawOf(oneOver)).toBe(`${oneOver.slice(0, CUT)}…`);
  });

  it("cuts_a_body_that_redaction_lengthens_past_the_limit_to_2049_characters", () => {
    // Each `token=a ` (8 characters) redacts to `token=*** ` (10): 2048 characters become 2560.
    const body = "token=a ".repeat(CUT / 8);
    expect(body).toHaveLength(CUT);

    const raw = rawOf(body);

    expect(raw).toHaveLength(CUT + 1);
    expect(raw.endsWith("…")).toBe(true);
    expect(raw).not.toContain("token=a ");
  });

  it("only_cuts_the_body_when_redaction_is_off", () => {
    const key = `sk-${"K5l6M7n8O9".repeat(3)}`;
    const body = padTo(bodyWithKeyAt(key, CUT - 12), 3000);
    _resetForTests({ enabled: false });
    try {
      const raw = rawOf(body);

      expect(raw).toBe(`${body.slice(0, CUT)}…`);
      expect(raw).toContain(key.slice(0, 12));
    } finally {
      _resetForTests({ enabled: true });
    }
  });

  it("does_not_split_a_surrogate_pair_at_the_cut", () => {
    const body = `${"a".repeat(CUT - 1)}\u{1F600} tail`;

    expect(rawOf(body)).toBe(`${"a".repeat(CUT - 1)}…`);
  });

  it("redacts_every_private_key_block_of_a_body_longer_than_64_kib", () => {
    const { body, blocks } = bodyOfKeyBlocksPast64Kib();
    const redacted = maskEach(body, blocks);
    expect(redacted.length).toBeLessThanOrEqual(CUT);

    const raw = rawOf(body);

    expect(raw).toBe(redacted);
    expect(raw).toContain(PAST_THE_BLOCKS_MARKER);
  });

  it("masks_a_private_key_block_that_straddles_64_kib_of_the_body", () => {
    const { body, blocks } = bodyOfKeyBlocksPast64Kib();
    const straddling = blocks[blocks.length - 1] as string;
    expect(body.indexOf(straddling) + straddling.length).toBeGreaterThan(SIXTY_FOUR_KIB);

    const raw = rawOf(body);

    const lines = straddling.split("\n").slice(1, -1);
    expect(lines.filter((line) => raw.includes(line))).toEqual([]);
    expect(raw).toContain(maskToken(straddling));
  });

  it("masks_a_jwt_longer_than_16_kib_that_straddles_64_kib_of_the_body", () => {
    // 29 key blocks redact to about 400 characters, which pulls a JWT that starts near 40 KB and
    // ends past 64 KiB inside the cut. Its payload is longer than the 16 KiB edge drop refused in
    // review round 2.
    let lead = PREFIX;
    for (let i = 0; lead.length < 40_000; i++) {
      lead += `${pemBlock("", keyLines(`Jwt${String(i).padStart(2, "0")}`, 20))}\n`;
    }
    const headerAndPayload = `${JWT_HEADER}.eyJ${repeatTo("c3ViIjoiMTIzNDU2Nzg5MCIs", 30_000)}`;
    const jwt = `${headerAndPayload}.${"Sig4nAtUrE".repeat(3)}`;
    const jwtStart = lead.length + 1;
    expect(SIXTY_FOUR_KIB - jwtStart).toBeGreaterThan(16_384);
    expect(jwtStart + jwt.length).toBeGreaterThan(SIXTY_FOUR_KIB);
    const body = `${lead} ${jwt} end"}}`;

    const raw = rawOf(body);

    const leakedSlices: string[] = [];
    for (let i = 0; i + 40 <= headerAndPayload.length; i += 40) {
      const slice = headerAndPayload.slice(i, i + 40);
      if (raw.includes(slice)) leakedSlices.push(slice);
    }
    expect(raw.includes(JWT_HEADER)).toBe(false);
    expect(leakedSlices).toEqual([]);
    expect(raw).toContain(maskToken(jwt));
  });

  it("keeps_the_first_2048_redacted_characters_of_a_body_longer_than_64_kib", () => {
    const key = `sk-${"F3g4H5i6J7".repeat(3)}`;
    const body = padTo(bodyWithKeyAt(key, 100), 70_000);
    const redacted = body.replace(key, maskToken(key));

    const raw = rawOf(body);

    expect(raw).toBe(`${redacted.slice(0, CUT)}…`);
  });

  it("masks_a_credential_that_redaction_brings_inside_the_limit_from_deep_in_the_body", () => {
    const skKey = `sk-${"V2w3X4y5Z6".repeat(3)}`;
    const skBody = deepBody(skKey, 16372, 16412);
    // Soft assertions: each of the three bodies reports on its own, so a fix that covers one shape
    // and leaks another names every body it leaks.
    const skRaw = rawOf(skBody);
    expect.soft(skRaw).not.toContain(skKey.slice(0, 8));
    expect.soft(skRaw).toContain(maskToken(skKey));

    const rsaLines = keyLines("RsaKey", 30);
    const rsaBlock = pemBlock("RSA ", rsaLines);
    const rsaBody = deepBody(rsaBlock, 15384);
    expect(15384 + rsaBlock.length).toBeGreaterThan(WINDOW);
    const rsaRaw = rawOf(rsaBody);
    expect.soft(rsaLines.filter((line) => rsaRaw.includes(line))).toEqual([]);
    expect.soft(rsaRaw).toContain(maskToken(rsaBlock));

    const headerAndPayload = `${JWT_HEADER}.eyJ${"c3ViIjoiMTIzNDU2Nzg5MCIs".repeat(25)}`;
    const jwt = `${headerAndPayload}.${"Sig4nAtUrE".repeat(3)}`;
    const jwtStart = WINDOW - 2 - (headerAndPayload.length + 1);
    const jwtBody = deepBody(jwt, jwtStart);
    const jwtRaw = rawOf(jwtBody);
    const leakedSlices: string[] = [];
    for (let i = 0; i + 40 <= headerAndPayload.length; i++) {
      const slice = headerAndPayload.slice(i, i + 40);
      if (jwtRaw.includes(slice)) leakedSlices.push(slice);
    }
    expect.soft(leakedSlices).toEqual([]);
    expect.soft(jwtRaw).toContain(maskToken(jwt));
  });

  it(
    "bounds_the_cost_of_mapping_a_hostile_body",
    () => {
      const hostile = [
        repeatTo("-----BEGIN PRIVATE KEY-----\n", HOSTILE_LENGTH),
        repeatTo("-----BEGIN RSA PRIVATE KEY-----", HOSTILE_LENGTH),
        repeatTo("-----BEGIN ENCRYPTED PRIVATE KEY-----", HOSTILE_LENGTH),
        repeatTo("eyJa", HOSTILE_LENGTH),
        `${repeatTo("eyJa", HOSTILE_LENGTH - 2)}.x`,
        repeatTo("eyJa", HOSTILE_LENGTH / 2) + repeatTo(".", HOSTILE_LENGTH / 2),
      ];
      for (const body of hostile) {
        expect(body).toHaveLength(HOSTILE_LENGTH);
        expect(bestElapsedMs(() => rawOf(body))).toBeLessThan(COST_BOUND_MS);
      }
    },
    COST_CASE_TIMEOUT_MS,
  );
});
