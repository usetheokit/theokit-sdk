// Child for instance-lock.test.ts: takes over a stale lock, with a barrier so that both children
// have read the stale lock before either takes it. Runs the TypeScript source (no build, no skip).
// argv: dir barrierDir id

import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";

register(
  "data:text/javascript," +
    encodeURIComponent(
      `export async function resolve(s, c, n) { try { return await n(s, c); } catch (e) { if (s.endsWith(".js")) return n(s.slice(0, -3) + ".ts", c); throw e; } }`,
    ),
);

const [dir, barrier, id] = process.argv.slice(2);
const { acquireWithHooks } = await import("../../src/internal/persistence/instance-lock.ts");
const waitFor = async (pred) => {
  const end = Date.now() + 15000;
  while (!pred()) {
    if (Date.now() > end) throw new Error("barrier timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const count = (prefix) => readdirSync(barrier).filter((f) => f.startsWith(prefix)).length;

let outcome;
try {
  const lock = await acquireWithHooks(dir, undefined, {
    afterStaleRead: async () => {
      writeFileSync(join(barrier, `read.${id}`), "");
      await waitFor(() => count("read.") >= 2);
    },
  });
  outcome = { ok: true, path: lock.path };
} catch (e) {
  outcome = { ok: false, name: e?.name, message: String(e?.message) };
}
writeFileSync(join(barrier, `result.${id}`), JSON.stringify(outcome));
// stay alive (holding any lock) until both children reported
await waitFor(() => count("result.") >= 2 && existsSync(join(barrier, `result.${id}`)));
