/**
 * The context manager confines a repository-supplied source path to the project root.
 *
 * `.theokit/context/*.md` frontmatter carries a `path:`, so the value is REPOSITORY-CONTROLLED —
 * untrusted whenever the repository came from somewhere else. `loadSources` guarded it with
 * `absolute.startsWith(resolvePath(cwd))`, which fails in two ways:
 *
 *   1. No separator boundary. With `cwd = /home/user/proj`, the value `../proj-evil/secret.md`
 *      resolves to `/home/user/proj-evil/secret.md`, which starts with `/home/user/proj`.
 *   2. Lexical, not `realpath` — a symlink whose name is inside the root and whose target is not
 *      passes the prefix test.
 *
 * The obvious escapes (`../../etc/passwd`, `/etc/passwd`) ARE refused by the prefix test, and
 * refusing them is what made the check look correct in review. That is why this file asserts the
 * sibling-directory case FIRST: it is the one a reader would not think to try.
 *
 * The manager marks an out-of-root source `excluded` rather than throwing, so every assertion here
 * is on the source's status, not on a rejection.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileContextManager } from "../src/internal/runtime/context/context-manager.js";

let root: string;
let project: string;

/** Write a `.theokit/context/<slug>.md` whose frontmatter names `path`. */
function declareSource(slug: string, path: string): void {
  const dir = join(project, ".theokit", "context");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${slug}.md`),
    `---\nname: ${slug}\npath: ${path}\n---\n\nsource declaration\n`,
    "utf8",
  );
}

async function snapshotOf(): Promise<{ included: string[]; raw: string }> {
  const manager = new FileContextManager(project, { manager: "file" }, true);
  await manager.initialize();
  const snap = await manager.snapshot();
  return {
    included: snap.sources.filter((s) => s.status === "included").map((s) => s.name),
    raw: JSON.stringify(snap),
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "theokit-ctx-containment-"));
  project = join(root, "proj");
  mkdirSync(project, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the context manager confines a repository-supplied source path", () => {
  it("test_a_sibling_directory_that_extends_the_project_name_is_excluded", async () => {
    // `<project>-evil` shares a string prefix with `<project>` and is NOT inside it. This is the
    // case a prefix test admits, and no `..` traversal past the parent is needed to reach it.
    const sibling = `${project}-evil`;
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, "secret.md"), "SENTINEL-SIBLING", "utf8");
    declareSource("leak", `../${basename(project)}-evil/secret.md`);

    const snap = await snapshotOf();

    // The SECURITY property is that the bytes never arrive. Measured against the pre-fix code, they
    // did: the prefix guard admitted the path and the file was read into the snapshot.
    expect(
      snap.raw,
      "the content of a file outside the project root reached the context snapshot — the guard " +
        "compares a raw string prefix with no separator boundary, so `<cwd>-evil` is admitted",
    ).not.toContain("SENTINEL-SIBLING");
    // And the REPORTED status must agree with the verdict, which is a separate defect: the
    // exclusion used to be computed and then overwritten to `included` by the aggregator mapping.
    expect(snap.included).not.toContain("leak");
  });

  it("test_a_symlink_inside_the_root_that_targets_outside_is_excluded", async () => {
    writeFileSync(join(root, "outside.md"), "SENTINEL-OUTSIDE", "utf8");
    symlinkSync(join(root, "outside.md"), join(project, "link.md"));
    declareSource("linked", "link.md");

    const snap = await snapshotOf();

    expect(
      snap.raw,
      "the content behind a symlink that targets outside the root reached the snapshot — the guard " +
        "compares lexically instead of after realpath",
    ).not.toContain("SENTINEL-OUTSIDE");
    expect(snap.included).not.toContain("linked");
  });

  it("test_a_source_inside_the_root_is_still_included", async () => {
    // Anti-vacuity floor: a guard that refused everything would satisfy both assertions above.
    // Single token on purpose: the manager tokenizes content and re-joins with "", so a sentinel
    // containing whitespace does not survive the round-trip. Measured — an earlier version of this
    // assertion used "in-root content" and failed for that reason, not for a containment reason.
    writeFileSync(join(project, "notes.md"), "SENTINEL-INSIDE-THE-ROOT", "utf8");
    declareSource("notes", "notes.md");

    const snap = await snapshotOf();
    expect(snap.included).toContain("notes");
    expect(snap.raw).toContain("SENTINEL-INSIDE-THE-ROOT");
  });
});
