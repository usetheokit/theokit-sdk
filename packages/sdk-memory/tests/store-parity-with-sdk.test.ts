/**
 * The parity that #430 needed and did not have.
 *
 * `Memory.runDreamingSweep` in `@theokit/sdk` replaces its own store with this package's whenever
 * this package is installed, and its docblock promises the swap is invisible: *"the fallback is not
 * a degraded mode — behaviour and thrown errors match — so consumers do not branch on which path
 * ran."*
 *
 * That promise had no test. It was true when written, the SDK's copy moved to a file per memory
 * (#389) and then gained the Claude Code read roots, this package's copy moved neither, and nothing
 * went red — because every existing test read exactly one of the two copies. **A promise without a
 * test is a claim about the past.**
 *
 * Both halves below are needed and neither implies the other: the behavioural case fails if a
 * reimplementation drifts, and the identity case fails the moment a second implementation exists at
 * all — before it has had time to drift.
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sdk from "@theokit/sdk/internal/memory-store";
import * as peer from "@theokit/sdk-memory";
import { describe, expect, it } from "vitest";

const MEMORY_FILE = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: ${name}\nmetadata:\n  type: project\n---\n\n${body}\n`;

describe("the store this package exposes and the SDK's", () => {
  it("test_they_read_the_same_facts_from_the_same_store", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "parity-"));
    await mkdir(sdk.resolveMemoryRoot(cwd), { recursive: true });
    await writeFile(
      join(sdk.resolveMemoryRoot(cwd), "written.md"),
      MEMORY_FILE("written", "A-FACT."),
    );

    const bySdk = (await sdk.readFactsFromMarkdown(cwd)).map((f) => f.text);
    const byPeer = (await peer.readFactsFromMarkdown(cwd)).map((f) => f.text);

    // The assertion that would have failed before the fix: the peer read `[]` here.
    expect(byPeer).toEqual(bySdk);
    expect(byPeer).toContain("A-FACT.");
  });

  // The write direction, and it asserts the KIND survives rather than just the text. The layout the
  // stale copy wrote — a bullet under `## Facts` — is still read, so a text-only assertion passes
  // against the defect and proves nothing. A bullet cannot carry the kind #401 introduced, so this
  // is the property that separates "written in the shared layout" from "merely readable".
  it("test_a_fact_written_through_one_is_read_through_the_other_with_its_kind", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "parity-w-"));
    await peer.appendFactToMarkdown(cwd, { text: "WRITTEN-BY-THE-PEER", kind: "feedback" });

    const bySdk = await sdk.readFactsFromMarkdown(cwd);
    expect(bySdk).toContainEqual(
      expect.objectContaining({ text: "WRITTEN-BY-THE-PEER", kind: "feedback" }),
    );
  });

  // The identity half. Same-named wrappers would satisfy the cases above on the day they are
  // written and drift after — which is the whole history of this defect.
  it("test_each_shared_name_is_one_function_not_two_implementations", () => {
    const shared = Object.keys(sdk).filter(
      (name) => typeof (sdk as Record<string, unknown>)[name] === "function",
    );
    expect(shared.length).toBeGreaterThan(0);
    for (const name of shared) {
      if (name === "LanceMemoryAdapter") continue;
      expect((peer as Record<string, unknown>)[name]).toBe((sdk as Record<string, unknown>)[name]);
    }
  });

  // The one name that is not the same reference (#1068), and the reason it cannot drift the way a
  // same-named wrapper does. This package published `LanceMemoryAdapter.unwrap()`; the SDK's adapter
  // refuses to carry it (`tests/lint/adapter-is-the-boundary.test.ts` there). So the class here
  // EXTENDS the SDK's and declares that one member. An override of `sync`, `search`, `status` or
  // `close` would be a second implementation, and it would show up below as an own property.
  it("test_the_lance_adapter_is_the_sdks_plus_unwrap_and_nothing_else", () => {
    expect(Object.getPrototypeOf(peer.LanceMemoryAdapter)).toBe(sdk.LanceMemoryAdapter);
    expect(Object.getOwnPropertyNames(peer.LanceMemoryAdapter.prototype).sort()).toEqual([
      "constructor",
      "unwrap",
    ]);
    expect(Object.getOwnPropertyNames(peer.LanceMemoryAdapter).sort()).toEqual([
      "length",
      "name",
      "prototype",
    ]);
  });
});
