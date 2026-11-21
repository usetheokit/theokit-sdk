/**
 * RED tests for T1.1 — `atomicWriteJson<T>` typed helper.
 * Includes EC-4 (auto-mkdir parent directory).
 */

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { atomicWriteJson } from "../../../src/internal/persistence/atomic-write.js";
import { withUmask } from "../../helpers/with-umask.js";

/** Permission bits of `path`, without the node type. */
function fileMode(target: string): number {
  return statSync(target).mode & 0o777;
}

describe("atomicWriteJson", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-write-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes JSON with default 2-space indent", async () => {
    const path = join(dir, "config.json");
    await atomicWriteJson(path, { foo: "bar", nested: { count: 1 } });
    const content = readFileSync(path, "utf-8");
    expect(content).toBe('{\n  "foo": "bar",\n  "nested": {\n    "count": 1\n  }\n}\n');
  });

  it("appends trailing newline by default", async () => {
    const path = join(dir, "config.json");
    await atomicWriteJson(path, { a: 1 });
    const content = readFileSync(path, "utf-8");
    expect(content.endsWith("\n")).toBe(true);
  });

  it("respects indent option", async () => {
    const path = join(dir, "config.json");
    await atomicWriteJson(path, { a: 1 }, { indent: 4 });
    expect(readFileSync(path, "utf-8")).toBe('{\n    "a": 1\n}\n');
  });

  it("respects trailingNewline=false option", async () => {
    const path = join(dir, "config.json");
    await atomicWriteJson(path, { a: 1 }, { trailingNewline: false });
    const content = readFileSync(path, "utf-8");
    expect(content.endsWith("\n")).toBe(false);
    expect(content).toBe('{\n  "a": 1\n}');
  });

  it("throws TypeError on undefined data", async () => {
    const path = join(dir, "config.json");
    await expect(atomicWriteJson(path, undefined)).rejects.toThrow(TypeError);
  });

  it("EC-4: auto-creates missing parent directories", async () => {
    const path = join(dir, "nested", "deep", "config.json");
    await atomicWriteJson(path, { a: 1 });
    expect(readFileSync(path, "utf-8")).toBe('{\n  "a": 1\n}\n');
  });

  it("leaves no .tmp files on success", async () => {
    const path = join(dir, "config.json");
    await atomicWriteJson(path, { a: 1 });
    const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("propagates circular reference errors", async () => {
    const path = join(dir, "config.json");
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    // Measured: the V8 TypeError from JSON.stringify. Asserting it distinguishes "the value could
    // not be serialised" from "the write failed", which is the whole point of the case.
    await expect(atomicWriteJson(path, circular)).rejects.toThrow(/Converting circular structure/);
  });
});

/**
 * M107 T1.1 — `{ mode?, exclusive? }` in the already-published options bag.
 *
 * ## The default is byte-identical, and that is NOT free (EC-3)
 *
 * Today `replaceFileAtomic` does `open(tmp, "w", 0o600)` **without `fchmod`**. The fileMode argument of
 * `open` is filtered by the `umask`, which only **clears** bits — so today's on-disk mode depends on the
 * process `umask`. Measured on this machine BEFORE the change (`node` reproducing the
 * `atomic-write.ts:106-122`):
 *
 * ```
 * umask 0o002  ->  tmp=0o600  final=0o600
 * umask 0o022  ->  tmp=0o600  final=0o600
 * umask 0o200  ->  tmp=0o400  final=0o400      <-- the owner write bit is cleared by the umask
 * ```
 *
 * An **unconditional** `chmod` on the descriptor would take the `umask 0o200` case from `0o400` to `0o600` —
 * an on-disk change for **every** caller that asked for nothing, including unknown external
 * consumers. That is why the mode reassertion is **conditional on `mode !== undefined`**, and
 * `test_without_options_the_behavior_is_identical` asserts the two measured numbers above, not a pretty
 * number. It is the test that fails if the reassertion becomes unconditional.
 *
 * ## Why reassert, then
 *
 * When the caller ASKS for a mode, the `umask` must not have the last word silently — that was
 * exactly the reason written in the local workaround this item exists to erase. The reassertion goes on the
 * DESCRIPTOR, before the `rename`, and never after: chmod-ing after the rename would leave the file
 * briefly carrying the umask's mode, which is the anti-pattern measured in
 * prior implementations of this pattern. The chosen shape passes fileMode as an
 * `open` parameter.
 */
describe("M107 T1.1 — atomicWriteJson honours mode and exclusive", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "m107-atomic-mode-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("test_without_options_the_behavior_is_identical", async () => {
    // Arrange — the two modes MEASURED before the change, per umask.
    const measuredBefore = new Map([
      [0o002, 0o600],
      [0o200, 0o400],
    ]);

    for (const [mask, expected] of measuredBefore) {
      await withUmask(mask, async () => {
        const noBag = join(dir, `sem-bag-${mask.toString(8)}.json`);
        const emptyBag = join(dir, `bag-empty-${mask.toString(8)}.json`);

        // Act
        await atomicWriteJson(noBag, { a: 1 });
        await atomicWriteJson(emptyBag, { a: 1 }, {});

        // Assert — content AND mode identical to before the change, under the SAME umask.
        expect(readFileSync(noBag, "utf-8")).toBe('{\n  "a": 1\n}\n');
        expect(readFileSync(emptyBag, "utf-8")).toBe('{\n  "a": 1\n}\n');
        expect(fileMode(noBag)).toBe(expected);
        expect(fileMode(emptyBag)).toBe(expected);
      });
    }
  });

  it("test_mode_is_honored_even_when_the_umask_would_clear_the_bit", async () => {
    // Arrange — `umask 0o200` clears the owner write bit. Without the reassertion on the descriptor, the
    // file comes out `0o400` (measured) and the caller's request is lost SILENTLY.
    const path = join(dir, "explicitly-requested.json");

    await withUmask(0o200, async () => {
      // Act
      await atomicWriteJson(path, { a: 1 }, { mode: 0o600 });

      // Assert
      expect(fileMode(path)).toBe(0o600);
    });
  });

  it("test_a_mode_more_permissive_than_the_default_is_honoured", async () => {
    // Arrange — the primitive imposes no policy: it changes the DEFAULT, not the caller's freedom.
    const path = join(dir, "permissive.json");

    await withUmask(0o002, async () => {
      // Act
      await atomicWriteJson(path, { a: 1 }, { mode: 0o644 });

      // Assert — without honouring `mode` it would come out `0o600` (today's fixed literal).
      expect(fileMode(path)).toBe(0o644);
    });
  });

  it("test_an_invalid_mode_propagates_the_system_error", async () => {
    // Arrange — NEGATIVE CASE (distinct from an edge case): the mode is invalid, not extreme.
    const path = join(dir, "fileMode-invalid.json");

    // Act + Assert — the system error PROPAGATES; it is not converted into an SDK type nor swallowed
    // (`.claude/rules/error-handling.md § 2`). And nothing was written to the destination.
    // Measured: RangeError from fs, naming the argument.
    await expect(atomicWriteJson(path, { a: 1 }, { mode: -1 })).rejects.toThrow(
      /The value of "mode" is out of range/,
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  it("test_a_rename_failure_leaves_no_temp_file", async () => {
    // Arrange — REGRESSION (not RED): the destination is a NON-EMPTY directory, so the `rename` fails.
    // What is proven is that temp-file cleanup still holds on the new path.
    const path = join(dir, "occupied-target");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "occupant.txt"), "x");

    // Act + Assert
    // Measured: EISDIR — the target path is a directory, which is what this case sets up.
    await expect(atomicWriteJson(path, { a: 1 }, { mode: 0o600 })).rejects.toMatchObject({
      code: "EISDIR",
    });
    expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("test_two_concurrent_writers_on_the_same_destination_produce_no_partial_file", async () => {
    // Arrange — atomicity under multiple writers is the module's contract, and `mode`/`exclusive`
    // touch CREATION, which is where a race would manifest.
    const path = join(dir, "contended.json");
    const conteudos = [0, 1, 2, 3, 4, 5, 6, 7];

    // Act
    await Promise.all(conteudos.map(async (n) => atomicWriteJson(path, { n }, { mode: 0o600 })));

    // Assert (happens-before observation, after the barrier) — the file contains EXACTLY one of the
    // contents, never a mixture, and no temp file was left behind.
    const lido = JSON.parse(readFileSync(path, "utf-8")) as { n: number };
    expect(conteudos).toContain(lido.n);
    expect(fileMode(path)).toBe(0o600);
    expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });
});
