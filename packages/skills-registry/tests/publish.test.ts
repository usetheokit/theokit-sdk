import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSkillPackage, publishSkill, type SkillPackage } from "../src/index.js";

const TOKEN = "tok-SECRET-123";
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "skill-build-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const md = (extra = "name: demo\ndescription: A demo\nversion: 1.2.0\n") =>
  `---\n${extra}---\nbody\n`;

describe("buildSkillPackage", () => {
  it("packs files base64 with / paths", async () => {
    await writeFile(join(dir, "SKILL.md"), md());
    await mkdir(join(dir, "refs"));
    await writeFile(join(dir, "refs", "a.txt"), "hi");
    const pkg = await buildSkillPackage(dir);
    expect(pkg).toMatchObject({ name: "demo", version: "1.2.0", description: "A demo" });
    expect(pkg.files).toEqual([
      { path: "SKILL.md", contentBase64: Buffer.from(md()).toString("base64") },
      { path: "refs/a.txt", contentBase64: Buffer.from("hi").toString("base64") },
    ]);
  });

  it("refuses a symbolic link, naming it", async () => {
    await writeFile(join(dir, "SKILL.md"), md());
    await symlink("/etc/hostname", join(dir, "link.txt"));
    await expect(buildSkillPackage(dir)).rejects.toMatchObject({
      code: "unsafe_path",
      message: expect.stringContaining("link.txt"),
    });
  });

  it("refuses a missing SKILL.md, missing fields and bad values", async () => {
    await writeFile(join(dir, "other.txt"), "x");
    await expect(buildSkillPackage(dir)).rejects.toMatchObject({ code: "invalid_skill_md" });
    const cases: [string, string][] = [
      ["name: demo\nversion: 1.0.0\n", "invalid_skill_md"],
      ["name: demo\ndescription: d\n", "invalid_skill_md"],
      ["name: demo\ndescription: d\nversion: 1.0\n", "invalid_version"],
      ["name: Bad_Name\ndescription: d\nversion: 1.0.0\n", "invalid_name"],
    ];
    for (const [fm, code] of cases) {
      await writeFile(join(dir, "SKILL.md"), md(fm));
      await expect(buildSkillPackage(dir)).rejects.toMatchObject({ code });
    }
  });

  it("refuses a folder over 1 MiB", async () => {
    await writeFile(join(dir, "SKILL.md"), md());
    await writeFile(join(dir, "big.bin"), Buffer.alloc(1024 * 1024 + 1));
    await expect(buildSkillPackage(dir)).rejects.toMatchObject({ code: "too_large" });
  });
});

const pkg: SkillPackage = {
  name: "demo",
  version: "1.2.0",
  description: "d",
  files: [{ path: "SKILL.md", contentBase64: Buffer.from(md()).toString("base64") }],
};

describe("publishSkill", () => {
  it("PUTs with the bearer token and resolves on 201", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 201 }));
    await expect(
      publishSkill("https://r.example", pkg, { token: TOKEN, fetch: f as never }),
    ).resolves.toEqual({
      name: "demo",
      version: "1.2.0",
    });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://r.example/v1/skills/demo/1.2.0");
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("refuses plain http off loopback and never calls fetch", async () => {
    const f = vi.fn();
    await expect(
      publishSkill("http://example.com", pkg, { token: TOKEN, fetch: f as never }),
    ).rejects.toMatchObject({
      code: "insecure_url",
    });
    expect(f).not.toHaveBeenCalled();
  });

  it("maps statuses without leaking the token", async () => {
    const cases: [number, string, string][] = [
      [409, "version_exists", "{}"],
      [401, "unauthorized", "{}"],
      [400, "rejected", JSON.stringify({ error: `bad package ${TOKEN}` })],
    ];
    for (const [status, code, body] of cases) {
      const f = async () => new Response(body, { status });
      const err = await publishSkill("https://r.example", pkg, {
        token: TOKEN,
        fetch: f as never,
      }).catch((e) => e);
      expect(err.code).toBe(code);
      expect(err.message).not.toContain(TOKEN);
    }
    const f = async () => new Response(JSON.stringify({ error: "name taken" }), { status: 400 });
    await expect(
      publishSkill("https://r.example", pkg, { token: TOKEN, fetch: f as never }),
    ).rejects.toMatchObject({
      message: "name taken",
    });
  });

  it("times out when fetch never resolves", async () => {
    const f = () => new Promise<Response>(() => {});
    await expect(
      publishSkill("https://r.example", pkg, { token: TOKEN, fetch: f as never, timeoutMs: 20 }),
    ).rejects.toMatchObject({ code: "unreachable" });
  });
});
