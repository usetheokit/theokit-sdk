import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const failRename = vi.hoisted(() => ({ on: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: (from: string, to: string) => {
      if (failRename.on && String(from).includes(".staging-")) {
        return Promise.reject(Object.assign(new Error("EXDEV"), { code: "EXDEV" }));
      }
      return actual.rename(from, to);
    },
  };
});

import {
  compareSkillVersions,
  downloadSkill,
  installSkill,
  MAX_PACKAGE_BYTES,
  SkillsRegistryError,
  verifySkillPackage,
} from "../src/index.js";

const REG = "https://registry.example.com";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const b64 = (s: string) => Buffer.from(s).toString("base64");
const skillMd = (name: string) => `---\nname: ${name}\ndescription: d\n---\n# ${name}\n`;

function pack(version: string, files?: { path: string; contentBase64: string }[], name = "demo") {
  const body = new TextEncoder().encode(
    JSON.stringify({
      name,
      version,
      description: "d",
      files: files ?? [{ path: "SKILL.md", contentBase64: b64(skillMd(name)) }],
    }),
  );
  return { body, sha256: sha(body), version };
}

function fakeFetch(packs: ReturnType<typeof pack>[], bodyOverride?: Uint8Array): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/package")) {
      const v = decodeURIComponent(url.split("/").slice(-2)[0] as string);
      const p = packs.find((x) => x.version === v);
      return new Response(bodyOverride ?? p?.body, { status: p ? 200 : 404 });
    }
    return Response.json({
      versions: packs.map((p) => ({ version: p.version, sha256: p.sha256 })),
    });
  }) as typeof fetch;
}

async function code(p: Promise<unknown> | (() => unknown)): Promise<string | undefined> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    return e instanceof SkillsRegistryError ? e.code : `other:${String(e)}`;
  }
  return undefined;
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "skills-registry-"));
  failRename.on = false;
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("versions", () => {
  it("orders by semver precedence", () => {
    expect(compareSkillVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(compareSkillVersions("1.0.0-alpha.2", "1.0.0-alpha.10")).toBe(-1);
    expect(compareSkillVersions("1.0.0+a", "1.0.0+b")).toBe(0);
    expect(() => compareSkillVersions("1.0", "1.0.0")).toThrow(SkillsRegistryError);
  });

  it("compares large numeric components without precision loss", () => {
    const big = "9007199254740993";
    const bigger = "9007199254740992";
    expect(compareSkillVersions(`${big}.0.0`, `${bigger}.0.0`)).toBe(1);
    expect(compareSkillVersions(`1.${bigger}.0`, `1.${big}.0`)).toBe(-1);
    expect(compareSkillVersions(`1.0.${big}`, `1.0.${big}`)).toBe(0);
    expect(compareSkillVersions("1.0.0", "1.0.123456789012345678901234567890")).toBe(-1);
    expect(compareSkillVersions(`1.0.0-${big}`, `1.0.0-${bigger}`)).toBe(1);
    expect(compareSkillVersions("1.0.0-9", "1.0.0-10")).toBe(-1);
  });
});

describe("downloadSkill", () => {
  const packs = [pack("1.0.0"), pack("1.1.0-beta.1"), pack("1.0.1")];
  it("picks the highest release by default and a pinned prerelease on request", async () => {
    expect((await downloadSkill(REG, "demo", { fetch: fakeFetch(packs) })).version).toBe("1.0.1");
    const pre = await downloadSkill(REG, "demo@1.1.0-beta.1", { fetch: fakeFetch(packs) });
    expect(pre.version).toBe("1.1.0-beta.1");
  });

  it("rejects insecure registry URLs and accepts loopback http", async () => {
    expect(
      await code(downloadSkill("http://example.com", "demo", { fetch: fakeFetch(packs) })),
    ).toBe("insecure_url");
    expect(
      (await downloadSkill("http://127.0.0.1:9000", "demo", { fetch: fakeFetch(packs) })).name,
    ).toBe("demo");
  });

  it("fails with digest_mismatch", async () => {
    const f = fakeFetch(packs, new TextEncoder().encode("{}"));
    expect(await code(downloadSkill(REG, "demo@1.0.1", { fetch: f }))).toBe("digest_mismatch");
  });

  it("fails with too_large without reading past the cap", async () => {
    let pulls = 0;
    const chunk = new Uint8Array(MAX_PACKAGE_BYTES);
    const f = (async (input: string | URL | Request) => {
      if (String(input).endsWith("/package")) {
        const body = new ReadableStream<Uint8Array>({
          pull(c) {
            pulls++;
            c.enqueue(chunk);
          },
        });
        return new Response(body);
      }
      return Response.json({ versions: [{ version: "1.0.0", sha256: "0".repeat(64) }] });
    }) as typeof fetch;
    expect(await code(downloadSkill(REG, "demo", { fetch: f }))).toBe("too_large");
    expect(pulls).toBeLessThanOrEqual(3);
  });

  it("fails with invalid_skill_md when SKILL.md names another skill", async () => {
    const p = pack("1.0.0", [{ path: "SKILL.md", contentBase64: b64(skillMd("other")) }]);
    expect(await code(downloadSkill(REG, "demo", { fetch: fakeFetch([p]) }))).toBe(
      "invalid_skill_md",
    );
  });

  it.each([
    ["duplicate name", "---\nname: other\nname: demo\n---\n"],
    ["duplicate name reversed", "---\nname: demo\nname: other\n---\n"],
    ["duplicate other key", "---\nname: demo\ndescription: a\ndescription: b\n---\n"],
    ["malformed name", "---\nname: De Mo\n---\n"],
    ["empty name", "---\nname:\n---\n"],
    ["unbalanced quote", "---\nname: \"demo\n---\n"],
    ["malformed line", "---\nname: demo\nnot a key\n---\n"],
  ])("fails with invalid_skill_md for %s", async (_l, md) => {
    const p = pack("1.0.0", [{ path: "SKILL.md", contentBase64: b64(md) }]);
    expect(await code(downloadSkill(REG, "demo", { fetch: fakeFetch([p]) }))).toBe(
      "invalid_skill_md",
    );
  });

  it("reports not_found and invalid_name", async () => {
    expect(await code(downloadSkill(REG, "demo@9.9.9", { fetch: fakeFetch(packs) }))).toBe(
      "not_found",
    );
    expect(await code(downloadSkill(REG, "../x", { fetch: fakeFetch(packs) }))).toBe(
      "invalid_name",
    );
    expect(await code(downloadSkill(REG, "demo@x", { fetch: fakeFetch(packs) }))).toBe(
      "invalid_version",
    );
  });
});

describe("unsafe paths", () => {
  it.each([
    "../x",
    "/etc/x",
    "a\\b",
    "C:x",
    "a//b",
    "a/./../b",
  ])("rejects %s and writes nothing", async (path) => {
    const p = pack("1.0.0", [
      { path: "SKILL.md", contentBase64: b64(skillMd("demo")) },
      { path: path, contentBase64: b64("x") },
    ]);
    expect(
      await code(() =>
        verifySkillPackage(p.body, { name: "demo", version: "1.0.0", sha256: p.sha256 }),
      ),
    ).toBe("unsafe_path");
    const forged = {
      name: "demo",
      version: "1.0.0",
      sha256: p.sha256,
      files: [{ path, bytes: new Uint8Array(1) }],
    };
    expect(await code(installSkill(dir, forged, { registry: REG }))).toBe("unsafe_path");
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("installSkill", () => {
  const verify = (v: string) => {
    const p = pack(v);
    return verifySkillPackage(p.body, { name: "demo", version: v, sha256: p.sha256 });
  };

  it("writes files and .origin.json, and a second version replaces the first", async () => {
    const one = verify("1.0.0");
    const { dir: target } = await installSkill(dir, one, { registry: REG });
    expect(target).toBe(join(dir, "demo"));
    expect(await readFile(join(target, "SKILL.md"), "utf8")).toContain("name: demo");
    expect(JSON.parse(await readFile(join(target, ".origin.json"), "utf8"))).toEqual({
      registry: REG,
      name: "demo",
      version: "1.0.0",
      sha256: one.sha256,
    });
    await installSkill(dir, verify("1.0.1"), { registry: REG });
    expect(JSON.parse(await readFile(join(target, ".origin.json"), "utf8")).version).toBe("1.0.1");
    expect(await readdir(dir)).toEqual(["demo"]);
  });

  it("keeps the previous version when the final rename fails", async () => {
    await installSkill(dir, verify("1.0.0"), { registry: REG });
    failRename.on = true;
    expect(await code(installSkill(dir, verify("1.0.1"), { registry: REG }))).toBe(
      "install_failed",
    );
    failRename.on = false;
    expect(JSON.parse(await readFile(join(dir, "demo", ".origin.json"), "utf8")).version).toBe(
      "1.0.0",
    );
    expect(await readdir(dir)).toEqual(["demo"]);
  });
});
