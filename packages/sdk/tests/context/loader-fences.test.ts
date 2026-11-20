// Every loader routes through the one splitter, so CRLF, a closing fence at end of file and an
// unterminated fence behave the same everywhere, each loader keeping its own error code.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadMarkdownEntities } from "../../src/internal/persistence/markdown-config-loader.js";
import { parseSkillFrontmatter } from "../../src/internal/runtime/skills/skill-frontmatter.js";
import { loadSubagents } from "../../src/internal/runtime/skills/subagents-loader.js";

const crlf = (s: string) => s.replace(/\n/g, "\r\n");

async function withDir<T>(sub: string, body: string, fn: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "loader-fences-"));
  const dir = join(cwd, sub);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "a.md"), body);
  try {
    return await fn(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe("skill frontmatter", () => {
  const ok = "---\nname: s\ndescription: d\n---\nbody\n";
  it("reads CRLF like LF", () => {
    expect(parseSkillFrontmatter(crlf(ok), "s")).toEqual(parseSkillFrontmatter(ok, "s"));
  });
  it("accepts a closing fence at end of file", () => {
    expect(parseSkillFrontmatter("---\nname: s\ndescription: d\n---", "s").name).toBe("s");
  });
  it("reports an unterminated fence as missing_frontmatter", () => {
    expect(() => parseSkillFrontmatter("---\nname: s\ndescription: d\n", "s")).toThrowError(
      expect.objectContaining({ code: "missing_frontmatter" }),
    );
  });
});

describe("markdown-config frontmatter", () => {
  const schema = z.object({ command: z.string() });
  const load = (cwd: string) =>
    loadMarkdownEntities({ dir: join(cwd, "h"), schema, errorCodePrefix: "hook" });
  it("reads CRLF and an end-of-file closing fence", async () => {
    await withDir("h", crlf("---\ncommand: echo\n---"), async (cwd) => {
      expect((await load(cwd))[0]?.frontmatter.command).toBe("echo");
    });
  });
  it("reports an unterminated fence with the loader's own code", async () => {
    await withDir("h", "---\ncommand: echo\nbody", async (cwd) => {
      await expect(load(cwd)).rejects.toMatchObject({ code: "hook_missing_frontmatter" });
    });
  });
});

describe("subagent frontmatter", () => {
  const agent = "---\nname: a\ndescription: does things\n---\nprompt";
  it("reads CRLF and an end-of-file fence", async () => {
    await withDir(".theokit/agents", crlf(agent), async (cwd) => {
      const r = await loadSubagents(cwd, true, undefined);
      expect(r.a?.prompt).toBe("prompt");
    });
  });
  it("reports an unterminated fence as subagent_missing_frontmatter", async () => {
    await withDir(".theokit/agents", "---\nname: a\ndescription: d\nprompt", async (cwd) => {
      await expect(loadSubagents(cwd, true, undefined)).rejects.toMatchObject({
        code: "subagent_missing_frontmatter",
      });
    });
  });
});
