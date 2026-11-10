import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";

import { SkillsManager } from "../src/internal/runtime/skills/skills-manager.js";
import { removeTempDirRobustSync } from "./helpers/temp-workspace.js";

function writeSkill(root: string, name: string): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(
    join(root, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: d ${name}\n---\n\nBody of ${name}.\n`,
  );
}

async function manager(enabled: string[] | undefined): Promise<SkillsManager> {
  const dir = mkdtempSync(join(tmpdir(), "b547-"));
  onTestFinished(() => removeTempDirRobustSync(dir));
  writeSkill(dir, "keep");
  writeSkill(dir, "drop");
  const m = new SkillsManager(dir, enabled, true, dir, [
    { name: "inl", description: "i", source: "inline", instructions: "x" } as never,
  ]);
  await m.initialize();
  return m;
}

it("a skill left out of skills.enabled cannot be listed or read", async () => {
  const m = await manager(["keep"]);
  expect((await m.list()).map((s) => s.name)).toEqual(["keep"]);
  expect(await m.get("drop")).toBeUndefined();
  expect(await m.get("inl")).toBeUndefined();
  expect((await m.get("keep"))?.instructions).toContain("Body of keep");
});

it("omitting enabled keeps every skill", async () => {
  const m = await manager(undefined);
  expect((await m.list()).map((s) => s.name).sort()).toEqual(["drop", "inl", "keep"]);
});
