// M33 (agent-builder) — per-subagent config through the LOCAL delegation seam.
//
// The disk loader parsed only name/description/model/tools and silently dropped every other key;
// the local delegation path narrowed an AgentDefinition down to {model.id, tools} when spawning a
// child, so reasoning params / mcp / sandbox never reached it. These tests pin the extended contract:
// the loader parses reasoning_effort (→ model.params[thinking]), mcp (→ mcpServers) and sandbox
// (boolean), rejects unknown/unsupported keys with a typed error, and buildChildCreateOptions forwards
// all three to the child. A test that a field merely parsed is not enough — the spawn assertions prove
// it reaches the built child AgentOptions.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildChildCreateOptions } from "../src/a2a/subagent.js";
import { loadSubagents } from "../src/internal/runtime/skills/subagents-loader.js";

async function withRole<T>(
  name: string,
  contents: string,
  fn: (cwd: string) => Promise<T>,
): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "m33-"));
  const dir = join(cwd, ".theokit", "agents");
  await rm(dir, { recursive: true, force: true });
  await import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }));
  await writeFile(join(dir, `${name}.md`), contents);
  try {
    return await fn(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe("subagent loader — per-agent config (M33)", () => {
  it("parses model + reasoning_effort into a ModelSelection with a thinking param", async () => {
    const md = `---\nname: explorer\ndescription: reads code\nmodel: openai/gpt-4o-mini\nreasoning_effort: low\ntools: [read_file]\n---\nYou are an explorer.`;
    const defs = await withRole("explorer", md, (cwd) => loadSubagents(cwd, true, undefined));
    const model = defs.explorer?.model;
    expect(typeof model === "object" ? model.id : model).toBe("openai/gpt-4o-mini");
    expect(typeof model === "object" ? model.params : undefined).toEqual([
      { id: "thinking", value: "low" },
    ]);
  });

  it("treats an empty reasoning_effort as absent (no empty thinking param)", async () => {
    const md = `---\nname: e\ndescription: d\nmodel: openai/gpt-4o-mini\nreasoning_effort: ""\n---\nbody`;
    const defs = await withRole("e", md, (cwd) => loadSubagents(cwd, true, undefined));
    expect(defs.e?.model).toEqual({ id: "openai/gpt-4o-mini" });
  });

  it("rejects mcp with a typed error — unsupported on the local delegation path (not a silent drop)", async () => {
    // The frontmatter YAML can only express server NAMES, while a child's Agent.create needs a
    // Record<name, config>; resolving that per-subagent on the local path is a follow-up. Rejecting
    // loud beats silently dropping an mcp an operator believed was wired.
    const md = `---\nname: worker\ndescription: does work\nmcp: [docs, fs]\n---\nbody`;
    await expect(
      withRole("worker", md, (cwd) => loadSubagents(cwd, true, undefined)),
    ).rejects.toThrow(/worker\.md.*mcp|mcp.*not yet supported/);
  });

  it("strips surrounding quotes from a quoted model/effort (a common frontmatter footgun)", async () => {
    const md = `---\nname: q\ndescription: d\nmodel: "openai/gpt-4o-mini"\nreasoning_effort: "low"\n---\nbody`;
    const defs = await withRole("q", md, (cwd) => loadSubagents(cwd, true, undefined));
    const model = defs.q?.model;
    expect(typeof model === "object" ? model.id : model).toBe("openai/gpt-4o-mini");
    expect(typeof model === "object" ? model.params?.[0]?.value : undefined).toBe("low");
  });

  it("parses a boolean sandbox", async () => {
    const md = `---\nname: worker\ndescription: does work\nsandbox: true\n---\nbody`;
    const defs = await withRole("worker", md, (cwd) => loadSubagents(cwd, true, undefined));
    expect(defs.worker?.sandbox).toBe(true);
  });

  it("a role omitting the new fields inherits the parent (fields absent)", async () => {
    const md = `---\nname: plain\ndescription: d\ntools: [read_file]\n---\nbody`;
    const defs = await withRole("plain", md, (cwd) => loadSubagents(cwd, true, undefined));
    expect(defs.plain?.model).toBeUndefined();
    expect(defs.plain?.mcpServers).toBeUndefined();
    expect(defs.plain?.sandbox).toBeUndefined();
  });

  it("rejects an unknown frontmatter field with a typed error naming file and field", async () => {
    const md = `---\nname: bad\ndescription: d\nwidgets: 3\n---\nbody`;
    await expect(withRole("bad", md, (cwd) => loadSubagents(cwd, true, undefined))).rejects.toThrow(
      /bad\.md.*widgets|widgets.*bad\.md/,
    );
  });

  it("rejects reasoning_effort without a model (effort is a model param)", async () => {
    const md = `---\nname: bad\ndescription: d\nreasoning_effort: high\n---\nbody`;
    await expect(withRole("bad", md, (cwd) => loadSubagents(cwd, true, undefined))).rejects.toThrow(
      /reasoning_effort/,
    );
  });

  it("rejects reasoning_effort with model: inherit — the inherited id cannot carry the param (no silent drop)", async () => {
    // model: inherit + reasoning_effort would otherwise resolve to "inherit" and silently drop the
    // effort — exactly the silent-gate class this milestone closes. It must be a typed error instead.
    const md = `---\nname: bad\ndescription: d\nmodel: inherit\nreasoning_effort: low\n---\nbody`;
    await expect(withRole("bad", md, (cwd) => loadSubagents(cwd, true, undefined))).rejects.toThrow(
      /reasoning_effort.*concrete model|concrete model/,
    );
  });

  it("rejects a non-boolean sandbox (a granular mode string is unsupported)", async () => {
    const md = `---\nname: bad\ndescription: d\nsandbox: read-only\n---\nbody`;
    await expect(withRole("bad", md, (cwd) => loadSubagents(cwd, true, undefined))).rejects.toThrow(
      /bad\.md.*sandbox|sandbox.*bad\.md/,
    );
  });
});

describe("buildChildCreateOptions — the fields reach the child (M33)", () => {
  const inherited = { apiKey: "k" } as const;

  it("carries the full model including thinking params (not just the id)", () => {
    const opts = buildChildCreateOptions(
      {
        name: "e",
        description: "d",
        instructions: "i",
        model: { id: "openai/gpt-4o-mini", params: [{ id: "thinking", value: "low" }] },
      },
      inherited,
    );
    expect(opts.model).toEqual({
      id: "openai/gpt-4o-mini",
      params: [{ id: "thinking", value: "low" }],
    });
  });

  it("passes local.sandboxOptions.enabled when sandbox is true", () => {
    const opts = buildChildCreateOptions(
      { name: "w", description: "d", instructions: "i", sandbox: true },
      inherited,
    );
    expect(opts.local?.sandboxOptions?.enabled).toBe(true);
  });

  it("a child of a sandboxed parent INHERITS the sandbox when its role omits the field (not default-open)", () => {
    // The default-open bug: a child of a sandboxed parent ran unsandboxed unless every role opted in.
    const opts = buildChildCreateOptions(
      { name: "p", description: "d", instructions: "i" },
      { apiKey: "k", sandbox: true },
    );
    expect(opts.local?.sandboxOptions?.enabled).toBe(true);
  });

  it("an explicit sandbox: false confines-OFF even under a sandboxed parent (distinct from absent)", () => {
    const opts = buildChildCreateOptions(
      { name: "p", description: "d", instructions: "i", sandbox: false },
      { apiKey: "k", sandbox: true },
    );
    expect(opts.local?.sandboxOptions?.enabled).toBe(false);
  });

  it("a child with no role sandbox and an UNsandboxed parent has no local sandbox", () => {
    const opts = buildChildCreateOptions(
      { name: "p", description: "d", instructions: "i" },
      { apiKey: "k", model: { id: "parent/model" } },
    );
    expect(opts.model).toEqual({ id: "parent/model" });
    expect(opts.local).toBeUndefined();
  });
});
