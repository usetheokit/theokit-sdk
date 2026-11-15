import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { lanceStoragePath } from "../lance-index.js";
import { refreshLanceHandles } from "./lance-handles.js";
import type { MemoryRoot } from "./memory-root.js";

/**
 * What a chunk keeps once a fact is cut out; `null` when nothing but structure is left, `undefined`
 * when the chunk does not hold the fact. The fact must be a whole line (bare, or as a `- ` bullet),
 * so removing `cat` never touches `concatenate`. A fact split across chunks is not matched.
 */
export function residualAfterRemoval(chunk: string, fact: string): string | null | undefined {
  if (fact === "") return undefined;
  const lines = chunk.split("\n");
  const at = lines.findIndex((l) => {
    const t = l.trim();
    return t === fact || (t.startsWith("- ") && t.slice(2).trim() === fact);
  });
  if (at === -1) return undefined;
  const rest = lines.filter((_, i) => i !== at);
  // Headings, fences, blank lines and front matter keys are structure, not memory.
  const meaningful = rest.some(
    (l) => !/^\s*(#.*|---|(name|description|metadata|node_type|type):.*|-?)\s*$/.test(l),
  );
  return meaningful ? rest.join("\n") : null;
}

interface LanceTableLike {
  delete: (predicate: string) => Promise<void>;
  update: (opts: { where: string; values: Record<string, string> }) => Promise<unknown>;
  query: () => {
    where: (p: string) => { select: (c: string[]) => { toArray: () => Promise<unknown[]> } };
  };
}
interface LanceLike {
  connect: (uri: string) => Promise<{
    tableNames: () => Promise<string[]>;
    openTable: (name: string) => Promise<LanceTableLike>;
  }>;
}

const quote = (v: string): string => `'${v.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;

/**
 * Take a removed fact out of the root's Lance table. Only `source = 'memory'` rows are considered,
 * because those are what the sqlite-to-Lance migration copies from the markdown store. A row that
 * is the fact is deleted; a migrated chunk that merely contains it (heading, bullet, other facts)
 * is rewritten without it, or deleted when nothing but structure is left. Its vector is kept, so
 * ranking is approximate until the table is re-embedded. Every open handle is then refreshed.
 *
 * `stillStored`: another entry in the store has the same text, so its rows must stay.
 *
 * @internal
 */
export async function forgetInLance(
  root: MemoryRoot,
  text: string,
  stillStored: boolean,
): Promise<void> {
  const path = lanceStoragePath(root);
  if (stillStored || !existsSync(path)) return;
  let lance: LanceLike;
  try {
    lance = createRequire(import.meta.url)("@lancedb/lancedb") as LanceLike;
  } catch {
    return; // not installed: no Lance table this process could have written
  }
  const conn = await lance.connect(path);
  if (!(await conn.tableNames()).includes("facts")) return;
  const table = await conn.openTable("facts");
  const rows = (await table
    .query()
    .where("source = 'memory'")
    .select(["id", "text"])
    .toArray()) as Array<{ id: string; text: string }>;
  for (const row of rows) {
    const residual = residualAfterRemoval(row.text, text);
    const where = `id = ${quote(row.id)} AND source = 'memory'`;
    if (residual === null) await table.delete(where);
    else if (residual !== undefined) await table.update({ where, values: { text: residual } });
  }
  await refreshLanceHandles(path);
}
