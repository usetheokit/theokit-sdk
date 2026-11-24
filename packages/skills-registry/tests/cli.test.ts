import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BIN = join(import.meta.dirname, "..", "dist", "cli.js");
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "skills-cli-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("theokit-skills-registry", () => {
  it("exits 1 naming the token variable when no token is set", () => {
    const env = { ...process.env };
    delete env.SKILLS_REGISTRY_TOKEN;
    const r = spawnSync(process.execPath, [BIN, "--dir", dir, "--port", "0"], { env, encoding: "utf8" });
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

  it("answers a search on 127.0.0.1 with --port 0", async () => {
    const child = spawn(process.execPath, [BIN, "--dir", dir, "--port", "0"], {
      env: { ...process.env, SKILLS_REGISTRY_TOKEN: "secret-token" },
    });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let out = "";
        child.stdout.on("data", (d) => {
          out += String(d);
          const m = /http:\/\/\S+/.exec(out);
          if (m) resolve(m[0]);
        });
        child.on("exit", () => reject(new Error("exited early")));
      });
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const res = await fetch(`${url}/v1/skills?q=x`);
      expect(res.status).toBe(200);
      const put = await fetch(`${url}/v1/skills/demo/1.0.0`, { method: "PUT", body: "{}" });
      expect(put.status).toBe(401);
    } finally {
      child.kill();
    }
  });
});
