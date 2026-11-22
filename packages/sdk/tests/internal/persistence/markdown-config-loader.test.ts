/**
 * Tests for loadMarkdownEntities (T0.2).
 *
 * 12 cases: 8 base + EC-8/9/10/11 from edge-case review.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  loadMarkdownEntities,
  splitFrontmatter,
} from "../../../src/internal/persistence/markdown-config-loader.js";

const HookSchema = z.object({
  event: z.enum(["preToolUse", "postToolUse"]),
  matcher: z.string().min(1),
  command: z.string().min(1),
  enabled: z.boolean().optional().default(true),
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "md-loader-"));
});
afterEach(() => {
  // Restore perms before rm to avoid EACCES during cleanup
  try {
    chmodSync(dir, 0o755);
  } catch {}
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

describe("loadMarkdownEntities — flat pattern", () => {
  it("returns [] when dir does not exist (ENOENT graceful)", async () => {
    const result = await loadMarkdownEntities({
      dir: join(dir, "nope"),
      schema: HookSchema,
      errorCodePrefix: "hook",
    });
    expect(result).toEqual([]);
  });

  it("loads 3 .md files with valid frontmatter", async () => {
    for (const name of ["a", "b", "c"]) {
      write(
        `${name}.md`,
        `---\nevent: preToolUse\nmatcher: ^shell$\ncommand: echo ${name}\n---\nbody for ${name}`,
      );
    }
    const result = await loadMarkdownEntities({ dir, schema: HookSchema, errorCodePrefix: "hook" });
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.slug).sort()).toEqual(["a", "b", "c"]);
    expect(result.every((r) => r.frontmatter.enabled === true)).toBe(true);
  });

  it("extracts body and trims", async () => {
    write(
      "h.md",
      `---\nevent: preToolUse\nmatcher: ^s$\ncommand: echo\n---\n\nThis is the body.\n`,
    );
    const result = await loadMarkdownEntities({ dir, schema: HookSchema, errorCodePrefix: "hook" });
    expect(result[0]?.body).toBe("This is the body.");
  });

  it("empty body is allowed", async () => {
    write("h.md", `---\nevent: preToolUse\nmatcher: ^s$\ncommand: echo\n---\n`);
    const result = await loadMarkdownEntities({ dir, schema: HookSchema, errorCodePrefix: "hook" });
    expect(result).toHaveLength(1);
    expect(result[0]?.body).toBe("");
  });

  it("throws missing_frontmatter when no --- block", async () => {
    write("h.md", `event: preToolUse\nmatcher: ^s$\ncommand: echo`);
    await expect(
      loadMarkdownEntities({ dir, schema: HookSchema, errorCodePrefix: "hook" }),
    ).rejects.toThrow(/missing_frontmatter|Missing or malformed frontmatter/);
  });

  it("throws frontmatter_invalid when required field missing", async () => {
    write("h.md", `---\nevent: preToolUse\nmatcher: ^s$\n---\nbody`);
    await expect(
      loadMarkdownEntities({ dir, schema: HookSchema, errorCodePrefix: "hook" }),
    ).rejects.toThrow(/frontmatter_invalid|Invalid frontmatter/);
  });

  it("(EC-8) body markdown with --- horizontal rule does NOT confuse splitter", async () => {
    write(
      "h.md",
      `---\nevent: preToolUse\nmatcher: ^s$\ncommand: echo\n---\n## section\n\nsome prose\n\n---\n\nmore prose after horizontal rule`,
    );
    const result = await loadMarkdownEntities({ dir, schema: HookSchema, errorCodePrefix: "hook" });
    expect(result[0]?.body).toContain("horizontal rule");
    expect(result[0]?.frontmatter.matcher).toBe("^s$");
  });

  it("(EC-9) +++ (Hugo/TOML-style) is rejected as missing frontmatter", async () => {
    write("h.md", `+++\nevent = "preToolUse"\nmatcher = "^s$"\n+++\nbody`);
    await expect(
      loadMarkdownEntities({ dir, schema: HookSchema, errorCodePrefix: "hook" }),
    ).rejects.toThrow(/missing_frontmatter|Missing or malformed/);
  });

  it("(EC-10) truncated frontmatter without closing --- throws missing_frontmatter", async () => {
    write("h.md", `---\nevent: preToolUse\nmatcher: ^s$\n`); // no closing ---
    await expect(
      loadMarkdownEntities({ dir, schema: HookSchema, errorCodePrefix: "hook" }),
    ).rejects.toThrow(/missing_frontmatter|Missing or malformed/);
  });
});

describe("loadMarkdownEntities — nested pattern (plugins)", () => {
  it("loads PLUGIN.md from subdirs", async () => {
    mkdirSync(join(dir, "openrouter"), { recursive: true });
    writeFileSync(
      join(dir, "openrouter", "PLUGIN.md"),
      `---\nevent: preToolUse\nmatcher: ^x$\ncommand: echo\n---\n`,
      "utf8",
    );
    const result = await loadMarkdownEntities({
      dir,
      schema: HookSchema,
      pattern: "nested",
      errorCodePrefix: "plugin",
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.slug).toBe("openrouter");
  });

  it("silently skips subdir without PLUGIN.md", async () => {
    mkdirSync(join(dir, "openrouter"), { recursive: true });
    mkdirSync(join(dir, "anthropic"), { recursive: true });
    writeFileSync(
      join(dir, "openrouter", "PLUGIN.md"),
      `---\nevent: preToolUse\nmatcher: ^x$\ncommand: echo\n---\n`,
      "utf8",
    );
    // anthropic has no PLUGIN.md
    const result = await loadMarkdownEntities({
      dir,
      schema: HookSchema,
      pattern: "nested",
      errorCodePrefix: "plugin",
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.slug).toBe("openrouter");
  });
});

/** Root bypasses directory-mode permission bits, so chmod 0o000 does not produce EACCES. */
const RUNNING_AS_ROOT = process.getuid?.() === 0;

describe("loadMarkdownEntities — EACCES distinguished from ENOENT (EC-11)", () => {
  // B-126: this was `if (process.getuid?.() === 0) return;` inside the test body, which reports PASS
  // on a root runner having asserted nothing — an environment where chmod cannot restrict access was
  // indistinguishable from one where the guard fired correctly. Gated at collection time instead, the
  // same shape `tests/chaos/partition-fs.test.ts` already uses for the identical root problem.
  it.skipIf(RUNNING_AS_ROOT)(
    "EACCES (chmod 000) throws ConfigurationError with code <prefix>_dir_read_error",
    async () => {
      chmodSync(dir, 0o000);
      try {
        const promise = loadMarkdownEntities({ dir, schema: HookSchema, errorCodePrefix: "hook" });
        await expect(promise).rejects.toMatchObject({
          code: "hook_dir_read_error",
        });
      } finally {
        chmodSync(dir, 0o755);
      }
    },
  );
});

describe("splitFrontmatter", () => {
  const ok: [string, { frontmatter: string; body: string }][] = [
    ["---\na: 1\n---\nbody", { frontmatter: "a: 1", body: "body" }],
    ["---\r\na: 1\r\n---\r\nbody", { frontmatter: "a: 1", body: "body" }],
    ["---  \n\n a: 1\n---  \n\n# hr\n---\nx", { frontmatter: "\n a: 1", body: "\n# hr\n---\nx" }],
    ["---\n\n---\nbody", { frontmatter: "", body: "body" }],
    ["---\n---\nbody", { frontmatter: "", body: "body" }],
    ["---\na: 1\n---", { frontmatter: "a: 1", body: "" }],
    // Trailing whitespace on a fence line is deliberately tolerated: `---   ` is a fence.
    ["---\na: 1\n---   ", { frontmatter: "a: 1", body: "" }],
    ["---   \na: 1\n---\nbody", { frontmatter: "a: 1", body: "body" }],
    // `--- x` is text after the dashes, not a fence, so it stays inside the frontmatter.
    ["---\na: 1\n--- x\n---\nbody", { frontmatter: "a: 1\n--- x", body: "body" }],
  ];
  for (const [raw, expected] of ok) {
    it(`splits to the expected frontmatter and body: ${JSON.stringify(raw)}`, () => {
      expect(splitFrontmatter(raw, "x.md", "t")).toEqual(expected);
    });
  }

  for (const raw of [
    "---\na: 1\n",
    "--- x\na: 1\n---\n",
    "--\na: 1\n---\n",
    "",
    "+++\na: 1\n+++\n",
  ]) {
    it(`rejects as missing or malformed: ${JSON.stringify(raw)}`, () => {
      expect(() => splitFrontmatter(raw, "x.md", "t")).toThrow(/Missing or malformed frontmatter/);
    });
  }

  it("rejects long whitespace-heavy malformed input quickly", () => {
    const raw = `---\n${"\n ".repeat(50_000)}`;
    const t = Date.now();
    expect(() => splitFrontmatter(raw, "x.md", "t")).toThrow(/Missing or malformed frontmatter/);
    expect(Date.now() - t).toBeLessThan(1000);
  });
});
