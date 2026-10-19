import { describe, expect, it } from "vitest";
import * as diary from "../../src/internal/memory/dreaming/diary.js";
import * as indexDb from "../../src/internal/memory/index-db.js";
import * as helpers from "../../src/internal/memory/index-manager-helpers.js";
import * as lance from "../../src/internal/memory/lance-index.js";
import * as migrate from "../../src/internal/memory/migrate-sqlite-to-lance.js";
import * as ceiling from "../../src/internal/memory/storage/fact-ceiling.js";
import * as barrel from "../../src/internal/memory/storage/index.js";
import * as store from "../../src/internal/memory/storage/markdown-store.js";
import * as root from "../../src/internal/memory/storage/memory-root.js";
import * as sessionLoader from "../../src/internal/memory/storage/session-loader.js";
import * as sessionWriter from "../../src/internal/memory/storage/session-summary-writer.js";
import * as transcripts from "../../src/internal/memory/storage/transcript-store.js";
import * as wiki from "../../src/internal/memory/storage/wiki-loader.js";

/*
 * The shared markdown store (#430).
 *
 * `@theokit/sdk-memory` used to carry a full copy of this store, and `Memory.runDreamingSweep`
 * swaps this implementation for the peer's whenever the peer is installed — so the copy that ran
 * was not the copy anyone maintained. It stayed on the pre-#389 layout and stopped finding the
 * files this one writes; the symptom was `factsBefore: 0`, which reads exactly like an empty store.
 *
 * The sub-path below is what lets the satellite import this store instead of copying it, the same
 * remedy theokit#160 applied to the embedding runtime in the same package pair.
 *
 * The barrel spans SEVEN modules now — the corpus walk joined the cluster once the satellite's
 * copy of it was found to skip the per-memory files entirely.
 *
 * (Was: SIX.) Root resolution moved out of the store into `memory-root.ts`
 * (#463), and the session/wiki/transcript cluster joined it once the satellite's byte-identical
 * copies were replaced by re-exports — the same remedy #430 applied to `markdown-store`, extended
 * to the four modules that were still copies. The guarantee below is unchanged: every name the
 * barrel offers is the function itself, from whichever module owns it.
 */
describe("the internal/memory-store sub-path", () => {
  // A name that leaves the store but never reaches the barrel is a name the satellite has to
  // reimplement, which is how the copy grew in the first place.
  it("test_it_offers_every_function_the_store_exports", () => {
    const exported = Object.keys(store).filter(
      (name) => typeof (store as Record<string, unknown>)[name] === "function",
    );
    expect(exported.length).toBeGreaterThan(0);
    for (const name of exported) expect(barrel).toHaveProperty(name);

    for (const mod of [root, sessionWriter, sessionLoader, wiki, transcripts, ceiling]) {
      const names = Object.keys(mod).filter(
        (name) => typeof (mod as Record<string, unknown>)[name] === "function",
      );
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) expect(barrel).toHaveProperty(name);
    }
  });

  // The accepted input's counterpart (rules/testing.md § 4.2): re-exports must be the SAME
  // functions, not same-named wrappers — a wrapper is a second implementation wearing the name.
  it("test_each_re_export_is_the_source_function_itself", () => {
    const sources = {
      ...store,
      ...ceiling,
      ...root,
      ...sessionWriter,
      ...sessionLoader,
      ...wiki,
      ...transcripts,
      ...helpers,
      ...indexDb,
      ...diary,
      ...lance,
      ...migrate,
    } as Record<string, unknown>;
    for (const [name, value] of Object.entries(barrel)) {
      expect(sources).toHaveProperty(name);
      expect(value).toBe(sources[name]);
    }
  });
});
