/** Shared output fan-out for {@link SandboxTerminal} implementations. */

type Listener = (data: Uint8Array) => void;

/**
 * Holds data that arrives before the first listener and hands it to that listener on subscribe.
 * `onData`'s returned function unsubscribes.
 */
export function createOutputHub(): {
  emit(data: Uint8Array): void;
  onData(listener: Listener): () => void;
} {
  const listeners = new Set<Listener>();
  let pending: Uint8Array[] = [];
  return {
    emit(data) {
      if (listeners.size === 0) pending.push(data);
      else for (const l of [...listeners]) l(data);
    },
    onData(listener) {
      listeners.add(listener);
      const buffered = pending;
      pending = [];
      for (const b of buffered) listener(b);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
