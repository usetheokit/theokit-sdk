/**
 * A persisted A2A identity: created on first use, then read back from the same file (#1558).
 */

import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { replaceFileAtomic } from "../internal/persistence/atomic-write.js";
import { type A2AIdentity, generateA2AIdentity } from "./sealed-transport.js";

// First loads of one file share one promise, across store instances in this process.
const pending = new Map<string, Promise<A2AIdentity>>();

function parseIdentity(text: string, file: string): A2AIdentity {
  const parsed = JSON.parse(text) as Partial<A2AIdentity> | null;
  if (typeof parsed?.publicKey !== "string" || typeof parsed.privateKey !== "string") {
    throw new Error(`a2a identity file is malformed: ${file}`);
  }
  return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
}

async function loadOrCreate(file: string): Promise<A2AIdentity> {
  if (existsSync(file)) return parseIdentity(await readFile(file, "utf8"), file);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const identity = generateA2AIdentity();
  await replaceFileAtomic(file, JSON.stringify(identity), { mode: 0o600 });
  return identity;
}

/**
 * Identity persisted to a JSON file: created on first `load()` (file mode 0600, a new parent
 * directory 0700), read back afterwards. Concurrent first loads in one process resolve to the same
 * identity; separate processes sharing one file are not coordinated. A malformed file rejects
 * rather than being replaced.
 *
 * @experimental
 * @public
 */
export function jsonIdentityStore(file: string): { load(): Promise<A2AIdentity> } {
  const key = resolve(file);
  return {
    load() {
      const inflight = pending.get(key);
      if (inflight) return inflight;
      const run = loadOrCreate(file).finally(() => pending.delete(key));
      pending.set(key, run);
      return run;
    },
  };
}
