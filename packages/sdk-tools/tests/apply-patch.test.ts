/**
 * `apply_patch` (V4A / Codex `*** Begin Patch`) — tool-level tests against a real temp project.
 * Covers Add/Update/Delete/Move, the strict-atomicity guarantee (a mismatch ⇒ zero writes), path
 * security, and the typed error branches.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createApplyPatchTool } from "../src/apply-patch.js";
import { textHandler } from "./text-handler.js";

const roots: string[] = [];
function project(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "apply-v4a-"));
  roots.push(root);
  for (const [p, c] of Object.entries(files)) writeFileSync(join(root, p), c);
  return root;
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const wrap = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;
const run = (root: string, patch: string) =>
  textHandler(createApplyPatchTool({ projectRoot: root }))({ patch }).then((s) => JSON.parse(s));

describe("apply_patch V4A — tool shape", () => {
  it("returns a CustomTool named apply_patch", () => {
    const tool = createApplyPatchTool({ projectRoot: "/nope" });
    expect(tool.name).toBe("apply_patch");
    expect(tool.description).toContain("Begin Patch");
  });
});

describe("apply_patch V4A — Add / Update / Delete / Move", () => {
  it("Add File creates the file with a trailing newline", async () => {
    const root = project();
    const r = await run(
      root,
      wrap("*** Add File: src/new.ts\n+export const x = 1;\n+const y = 2;"),
    );
    expect(r).toEqual({ ok: true, files_patched: ["src/new.ts"] });
    expect(readFileSync(join(root, "src/new.ts"), "utf-8")).toBe(
      "export const x = 1;\nconst y = 2;\n",
    );
  });

  it("Update File applies a context-anchored change", async () => {
    const root = project({ "a.ts": "top\nfunction main\nold\nbottom\n" });
    const r = await run(root, wrap("*** Update File: a.ts\n@@ function main\n-old\n+new"));
    expect(r.ok).toBe(true);
    expect(readFileSync(join(root, "a.ts"), "utf-8")).toBe("top\nfunction main\nnew\nbottom\n");
  });

  it("Delete File removes the file", async () => {
    const root = project({ "gone.ts": "bye\n" });
    const r = await run(root, wrap("*** Delete File: gone.ts"));
    expect(r).toEqual({ ok: true, files_patched: ["gone.ts"] });
    expect(existsSync(join(root, "gone.ts"))).toBe(false);
  });

  it("Update File + Move to writes the new content at the destination and removes the original", async () => {
    const root = project({ "old.ts": "a\nb\n" });
    const r = await run(root, wrap("*** Update File: old.ts\n*** Move to: sub/new.ts\n@@\n-a\n+A"));
    expect(r).toEqual({ ok: true, files_patched: ["sub/new.ts"] });
    expect(existsSync(join(root, "old.ts"))).toBe(false);
    expect(readFileSync(join(root, "sub/new.ts"), "utf-8")).toBe("A\nb\n");
  });
});

describe("apply_patch V4A — strict atomicity", () => {
  it("a mismatch in the SECOND hunk leaves the FIRST file untouched (zero writes)", async () => {
    const root = project({ "a.ts": "keep\n", "b.ts": "real\n" });
    // hunk 1 (a.ts) is valid; hunk 2 (b.ts) context does not match → whole patch must abort.
    const patch = wrap(
      "*** Update File: a.ts\n@@\n-keep\n+CHANGED\n*** Update File: b.ts\n@@\n-does-not-exist\n+x",
    );
    const r = await run(root, patch);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("patch_failed");
    // a.ts MUST be unchanged — the plan aborted before any write.
    expect(readFileSync(join(root, "a.ts"), "utf-8")).toBe("keep\n");
    expect(readFileSync(join(root, "b.ts"), "utf-8")).toBe("real\n");
  });
});

describe("apply_patch V4A — security + errors", () => {
  it("refuses a forbidden path (.env)", async () => {
    const root = project();
    const r = await run(root, wrap("*** Add File: .env\n+SECRET=1"));
    expect(r).toEqual({ ok: false, error: "forbidden_path", path: ".env" });
  });

  it("refuses a traversal path", async () => {
    const root = project();
    const r = await run(root, wrap("*** Add File: ../escape.ts\n+x"));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("path_traversal");
  });

  it("returns not_found when updating a missing file", async () => {
    const root = project();
    const r = await run(root, wrap("*** Update File: missing.ts\n@@\n-a\n+b"));
    expect(r).toEqual({ ok: false, error: "not_found", path: "missing.ts" });
  });

  it("returns parse_error for a malformed patch", async () => {
    const root = project();
    const r = await run(root, "not a patch at all");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("parse_error");
  });
});

describe("apply_patch V4A — M18 review fixes (security + robustness)", () => {
  it("blocks a NESTED forbidden secret (sub/.env), not just a top-level one", async () => {
    const root = project();
    const r = await run(root, wrap("*** Add File: sub/.env\n+SECRET=1"));
    expect(r).toEqual({ ok: false, error: "forbidden_path", path: "sub/.env" });
  });

  it("blocks a nested .git path (e.g. a git hook) at any depth", async () => {
    const root = project();
    const r = await run(root, wrap("*** Add File: sub/.git/hooks/pre-commit\n+rm -rf /"));
    expect(r).toEqual({ ok: false, error: "forbidden_path", path: "sub/.git/hooks/pre-commit" });
  });

  it("blocks an ABSOLUTE path to a secret inside the project (no bypass)", async () => {
    const root = project();
    const r = await run(root, wrap(`*** Add File: ${join(root, ".env")}\n+SECRET=1`));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("forbidden_path");
    expect(existsSync(join(root, ".env"))).toBe(false);
  });

  it("rejects two Update hunks on the SAME file (no silent lost-update)", async () => {
    const root = project({ "a.ts": "x\ny\n" });
    const r = await run(
      root,
      wrap("*** Update File: a.ts\n@@\n-x\n+X\n*** Update File: a.ts\n@@\n-y\n+Y"),
    );
    expect(r).toEqual({ ok: false, error: "duplicate_target", path: "a.ts" });
    expect(readFileSync(join(root, "a.ts"), "utf-8")).toBe("x\ny\n"); // untouched
  });

  it("rejects Add over an existing file (no silent clobber)", async () => {
    const root = project({ "there.ts": "keep\n" });
    const r = await run(root, wrap("*** Add File: there.ts\n+clobbered"));
    expect(r).toEqual({ ok: false, error: "file_exists", path: "there.ts" });
    expect(readFileSync(join(root, "there.ts"), "utf-8")).toBe("keep\n");
  });

  it("returns not_found when deleting a nonexistent file", async () => {
    const root = project();
    const r = await run(root, wrap("*** Delete File: ghost.ts"));
    expect(r).toEqual({ ok: false, error: "not_found", path: "ghost.ts" });
  });

  it("maps an fs error (updating a directory) to a typed io_error, not a crash", async () => {
    const root = project();
    mkdtempSync(join(root, "plaindir-")); // a directory named plaindir-XXXX
    // Update a directory path → EISDIR on read → must be a typed error, never an escaping throw.
    const r = await run(root, wrap("*** Update File: .\n@@\n-x\n+y"));
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe("string"); // io_error or not_found — never an unhandled throw
  });

  it("applies a *** End of File edit of the LAST line (eof anchoring, phantom-newline safe)", async () => {
    const root = project({ "tail.ts": "a\nb\nlast\n" });
    const r = await run(root, wrap("*** Update File: tail.ts\n@@\n-last\n+LAST\n*** End of File"));
    expect(r.ok).toBe(true);
    expect(readFileSync(join(root, "tail.ts"), "utf-8")).toBe("a\nb\nLAST\n");
  });
});

describe("apply_patch V4A — baseDir (#1060)", () => {
  it("anchors Add and Move destinations to baseDir; absolute paths unchanged; .env refused", async () => {
    const root = project();
    mkdirSync(join(root, "proj"));
    const tool = createApplyPatchTool({ projectRoot: root, baseDir: join(root, "proj") });
    const h = textHandler(tool);
    const add = JSON.parse(await h({ patch: wrap("*** Add File: a.txt\n+hi") }));
    expect(add.ok).toBe(true);
    expect(readFileSync(join(root, "proj", "a.txt"), "utf-8")).toContain("hi");
    const mv = JSON.parse(
      await h({ patch: wrap("*** Update File: a.txt\n*** Move to: b.txt\n@@\n-hi\n+yo") }),
    );
    expect(mv.ok).toBe(true);
    expect(existsSync(join(root, "proj", "a.txt"))).toBe(false);
    expect(readFileSync(join(root, "proj", "b.txt"), "utf-8")).toContain("yo");
    await h({ patch: wrap(`*** Add File: ${join(root, "other.txt")}\n+abs`) });
    expect(existsSync(join(root, "other.txt"))).toBe(true);
    const env = JSON.parse(await h({ patch: wrap("*** Add File: .env\n+X=1") }));
    expect(env.error).toBe("forbidden_path");
  });

  it("throws at construction when baseDir is outside projectRoot, naming both", () => {
    const root = project();
    const outside = join(tmpdir(), "elsewhere");
    expect(() => createApplyPatchTool({ projectRoot: root, baseDir: outside })).toThrow(
      new RegExp(`${outside}[\\s\\S]*${root}`),
    );
  });
});
