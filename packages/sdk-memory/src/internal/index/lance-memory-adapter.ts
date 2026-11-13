import {
  type LanceIndex,
  LanceMemoryAdapter as SharedLanceMemoryAdapter,
} from "@theokit/sdk/internal/memory-store";

/**
 * Presents a `LanceIndex` as a `MemoryIndex`, so a consumer written against the SQLite index runs
 * unchanged on `backend: "lance"`.
 *
 * `sync`, `search`, `status` and `close` are the SDK's adapter, inherited rather than copied
 * (#1068), so they behave the same whether or not this package is installed: `sync()` walks
 * nothing and says so with `supported: false`, `search()` blends Lance's vector score with a
 * term-overlap text score through the caller's `vectorWeight` / `textWeight`, and `status()`
 * reports zero counts with `countsExact: false`. It always queries the `default` namespace.
 *
 * The one member this class adds is {@link LanceMemoryAdapter.unwrap}. The SDK's adapter
 * deliberately has no such member; this package published one, so it stays here. An index opened
 * with `IndexManager.open({ backend: "lance" })` is the SDK's adapter and does not have it: to
 * write facts, open a `LanceIndex` and either use it directly or wrap it with this class.
 *
 * Requires `@lancedb/lancedb`, an optional peer dependency, loaded when the index is opened.
 */
export class LanceMemoryAdapter extends SharedLanceMemoryAdapter {
  readonly #lance: LanceIndex;

  constructor(inner: LanceIndex) {
    super(inner);
    this.#lance = inner;
  }

  /** The wrapped `LanceIndex`, for `addFacts`, `countFacts` and `removeFacts`. */
  unwrap(): LanceIndex {
    return this.#lance;
  }
}
