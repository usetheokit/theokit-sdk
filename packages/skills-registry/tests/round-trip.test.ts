import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSkillsRegistryHandler,
  downloadSkill,
  installSkill,
  publishSkill,
  type SkillPackage,
  searchSkills,
} from "../src/index.js";

const TOKEN = "tok-SECRET-123";
const URL_ = "http://127.0.0.1:4000";
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "skill-roundtrip-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

const pkg = (version: string): SkillPackage => ({
  name: "demo",
  version,
  description: "A demo skill",
  files: [
    {
      path: "SKILL.md",
      contentBase64: Buffer.from(
        `---\nname: demo\nversion: ${version}\n---\nv${version}\n`,
      ).toString("base64"),
    },
  ],
});

describe("round trip through the handler", () => {
  it("publishes, searches, downloads and installs the stable version by default", async () => {
    const handler = createSkillsRegistryHandler({ dir: join(root, "store"), token: TOKEN });
    const f = ((input: string | URL | Request, init?: RequestInit) =>
      handler(new Request(input, init))) as typeof fetch;
    await publishSkill(URL_, pkg("1.0.0"), { token: TOKEN, fetch: f });
    await publishSkill(URL_, pkg("1.1.0-beta.1"), { token: TOKEN, fetch: f });

    const hits = await searchSkills(URL_, "dem", { fetch: f });
    expect(hits).toEqual([
      {
        name: "demo",
        description: "A demo skill",
        latest: "1.1.0-beta.1",
        versions: ["1.0.0", "1.1.0-beta.1"],
      },
    ]);
    expect(await searchSkills(URL_, "zzz", { fetch: f })).toEqual([]);

    const downloaded = await downloadSkill(URL_, "demo", { fetch: f });
    expect(downloaded.version).toBe("1.0.0");
    const skills = join(root, "skills");
    await installSkill(skills, downloaded, { registry: URL_ });
    expect(await readFile(join(skills, "demo", "SKILL.md"), "utf8")).toContain("v1.0.0");

    const beta = await downloadSkill(URL_, "demo@1.1.0-beta.1", { fetch: f });
    expect(beta.version).toBe("1.1.0-beta.1");
  });
});
