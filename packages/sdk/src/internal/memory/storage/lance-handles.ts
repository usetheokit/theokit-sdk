import { resolve } from "node:path";

/**
 * The Lance tables this process has open, by storage path. A Lance handle keeps reading the table
 * version it opened until told to check out the latest one, so a write made through another
 * connection (a fact removal) is invisible to an agent already holding a handle. Removal walks this
 * registry and refreshes every handle at the path it changed.
 *
 * @internal
 */
const open = new Map<string, Set<WeakRef<{ checkoutLatest: () => Promise<void> }>>>();

/** Register an open table; returns the function that unregisters it. */
export function registerLanceHandle(
  storagePath: string,
  table: { checkoutLatest: () => Promise<void> },
): () => void {
  const key = resolve(storagePath);
  const ref = new WeakRef(table);
  let refs = open.get(key);
  if (refs === undefined) open.set(key, (refs = new Set()));
  refs.add(ref);
  return () => void refs.delete(ref);
}

/** Make every open handle at `storagePath` read the latest table version. */
export async function refreshLanceHandles(storagePath: string): Promise<void> {
  for (const ref of open.get(resolve(storagePath)) ?? []) {
    await ref.deref()?.checkoutLatest();
  }
}
