import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { publishSkill, type SkillPackage, searchSkills } from "../src/index.js";

const ROOT = join(import.meta.dirname, "..");
const BIN = join(ROOT, "dist", "cli.js");
const TOKEN = "secret-token";
let dir: string;
const children: ChildProcess[] = [];

beforeAll(() => {
  if (!existsSync(BIN)) execFileSync("pnpm", ["exec", "tsup"], { cwd: ROOT, stdio: "pipe" });
  dir = mkdtempSync(join(tmpdir(), "skills-cli-"));
}, 120_000);
afterEach(() => {
  for (const c of children.splice(0)) c.kill();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function start(): Promise<string> {
  const child = spawn(process.execPath, [BIN, "--dir", dir, "--port", "0"], {
    env: { ...process.env, SKILLS_REGISTRY_TOKEN: TOKEN },
  });
  children.push(child);
  return new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (d) => {
      out += String(d);
      const m = /http:\/\/\S+/.exec(out);
      if (m) resolve(m[0]);
    });
    child.on("exit", () => reject(new Error("exited early")));
  });
}

function pkg(name: string, bytes = 10): SkillPackage {
  const md = `---\nname: ${name}\ndescription: A demo\nversion: 1.0.0\n---\nbody\n`;
  const files = [{ path: "SKILL.md", contentBase64: Buffer.from(md).toString("base64") }];
  if (bytes > 10) files.push({ path: "big.bin", contentBase64: "A".repeat(bytes) });
  return { name, version: "1.0.0", description: "A demo", files };
}

describe("theokit-skills-registry", () => {
  it("exits 1 naming the token variable when no token is set", () => {
    const env = { ...process.env };
    delete env.SKILLS_REGISTRY_TOKEN;
    const r = spawnSync(process.execPath, [BIN, "--dir", dir, "--port", "0"], {
      env,
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("SKILLS_REGISTRY_TOKEN");
  });

  it("rejects a bad port", () => {
    const r = spawnSync(process.execPath, [BIN, "--dir", dir, "--port", "abc"], {
      env: { ...process.env, SKILLS_REGISTRY_TOKEN: "t" },
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--port");
  });

  it("answers a search on 127.0.0.1 with --port 0 and refuses an unauthenticated PUT", async () => {
    const url = await start();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await fetch(`${url}/v1/skills?q=x`)).status).toBe(200);
    const put = await fetch(`${url}/v1/skills/demo/1.0.0`, { method: "PUT", body: "{}" });
    expect(put.status).toBe(401);
  });

  it("publishes with the bearer token, then finds and downloads the skill", async () => {
    const url = await start();
    await publishSkill(url, pkg("round-trip"), { token: TOKEN });
    const hits = await searchSkills(url, "round-trip");
    expect(hits.map((h) => h.name)).toEqual(["round-trip"]);
    const res = await fetch(`${url}/v1/skills/round-trip/1.0.0/package`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SkillPackage;
    expect(body.files[0]?.path).toBe("SKILL.md");
    const head = await fetch(`${url}/v1/skills/round-trip/1.0.0/package`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("answers 413 for a body over the package limit", async () => {
    const url = await start();
    const res = await fetch(`${url}/v1/skills/huge/1.0.0`, {
      method: "PUT",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(pkg("huge", 1_200_000)),
    });
    expect(res.status).toBe(413);
  });
});
