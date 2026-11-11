#!/usr/bin/env node
// Mirror tools/* and path-safety .d.ts → .d.cts so the CJS condition in
// package.json `exports` resolves to a real `.d.cts` file. Without this,
// attw flags the sub-exports as "Masquerading as ESM" because CJS imports
// land on a `.d.ts` (ESM-shape) declaration file.
//
// Type-only TS code is syntax-identical between .d.ts and .d.cts; copying
// the file is sufficient.

import { copyFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist");

/** Recursively walk a dir collecting .d.ts files (excluding already-paired .d.cts). */
async function* walkDts(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkDts(full);
    } else if (entry.name.endsWith(".d.ts")) {
      yield full;
    }
  }
}

// B-101 — `walkDts` above walks INSIDE a listed target (a directory entry recurses through
// it looking for `.d.ts` files); it is never used to DISCOVER the target list itself. That is
// deliberate, not an oversight: mirroring every `.d.ts` under `dist/` would include internal
// declarations no `package.json` `exports` entry points at, and mirroring those is waste, not
// harm, but waste nobody asked for. The explicit list below is scoped to what is actually
// published.
//
// Because the list is explicit and hand-maintained, nothing forces it to agree with
// `package.json` `exports` — that was B-101's actual defect (adding a sub-entry here, or to
// `tsconfig.tools-dts.json`, was silently optional; only `publint` noticed, ~10 minutes into
// `pnpm -w run validate`). `scripts/check-subentry-consistency.mjs` closes that gap: it derives
// the expected target set FROM `package.json` `exports` and fails fast (wired into the root
// `check` script) when this list — or `tsconfig.tools-dts.json`'s `include`, or
// `tsup.config.ts`'s `entry` — falls out of sync with what is published.
const targets = [
  // M1-5: SDKMessage readers sub-path.
  join(DIST, "messages.d.ts"),
  // M2-1: compaction sub-path.
  join(DIST, "compaction.d.ts"),
  // M2-4: models sub-path.
  join(DIST, "models.d.ts"),
  // #326: the provider registry as public API.
  join(DIST, "providers.d.ts"),
  // M4-1: skills sub-path.
  join(DIST, "skills.d.ts"),
  // M4-2: project sub-path.
  join(DIST, "project.d.ts"),
  // M4-6: subagents sub-path.
  join(DIST, "subagents.d.ts"),
  // tools — EXTRACTED to @theokit/sdk-tools (SDK 2.0 split, Phase 5).
  join(DIST, "path-safety.d.ts"),
  join(DIST, "task-store.d.ts"),
  join(DIST, "workflow.d.ts"),
  join(DIST, "eval.d.ts"),
  join(DIST, "subscription"),
  // Public tool-input sanitization sub-path.
  join(DIST, "sanitize"),
  // M42 auth subsystem sub-path.
  join(DIST, "auth"),
  join(DIST, "concurrency.d.ts"),
  join(DIST, "retry.d.ts"),
  // V2-3: persistence sub-path.
  join(DIST, "persistence.d.ts"),
  // T1.3: MCP OAuth sub-path (PKCE + refresh + token storage).
  join(DIST, "mcp-auth.d.ts"),
  join(DIST, "mcp-events.d.ts"),
  // Sub-path exports that need CTS mirrors.
  join(DIST, "rag"),
  join(DIST, "a2a"),
  join(DIST, "client"),
  join(DIST, "sandbox"),
  // SE31: filesystem provider seam sub-path.
  join(DIST, "filesystem"),
  // M14: interactive provider seam sub-path (was missing → `.d.cts` never
  // mirrored, so `exports["./interactive"].require.types` 404'd; attw +
  // publint both flagged it).
  join(DIST, "interactive"),
  join(DIST, "server"),
  // B-103: the sanctioned public context barrel. Same failure mode the `interactive`
  // comment above records — without a mirror, `exports["./context"].require.types`
  // points at a file that does not exist and attw + publint both flag it.
  join(DIST, "context"),
  // EC-1 absorbed: internal sub-paths exposed for extracted packages.
  join(DIST, "internal", "persistence"),
  // theokit#160: the embedding runtime shared with @theokit/sdk-memory.
  join(DIST, "internal", "memory", "adapters"),
  // #430: the markdown memory store shared with @theokit/sdk-memory, for the same reason.
  join(DIST, "internal", "memory", "storage"),
  join(DIST, "internal", "plugins"),
  join(DIST, "internal", "observability"),
  join(DIST, "internal", "security"),
];

for (const target of targets) {
  const dtsFiles = [];
  try {
    const stat = (await import("node:fs/promises")).stat;
    const info = await stat(target);
    if (info.isDirectory()) {
      for await (const file of walkDts(target)) dtsFiles.push(file);
    } else if (target.endsWith(".d.ts")) {
      dtsFiles.push(target);
    }
  } catch {
    // Skip missing targets — tsup may not have built them yet.
    continue;
  }
  for (const dts of dtsFiles) {
    const cts = dts.replace(/\.d\.ts$/, ".d.cts");
    await copyFile(dts, cts);
  }
}
