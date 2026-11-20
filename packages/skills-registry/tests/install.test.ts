import { createHash } from "node:crypto";
import * as realFs from "node:fs/promises";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const renameHook = vi.hoisted(() => ({
  failOn: undefined as undefined | ((to: string, from: string) => boolean),
}));
vi.mock("node:fs/promises", async (orig) => {
  const real = await orig<typeof import("node:fs/promises")>();
  return {
    ...real,
    rename: async (from: string, to: string) => {
      if (renameHook.failOn?.(to, from)) throw new Error("simulated rename failure");
      return real.rename(from, to);
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

void realFs;

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const b64 = (s: string) => Buffer.from(s).toString("base64");
const skillMd = (name: string, extra = "") =>
  `---\nname: ${name}\ndescription: d\n${extra}---\nbody\n`;

function pack(
  name: string,
  version: string,
  files?: { path: string; contentBase64: string }[],
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      name,
      version,
      description: "d",
      files: files ?? [{ path: "SKILL.md", contentBase64: b64(skillMd(name)) }],
    }),
  );
}

function fakeFetch(versions: string[], bodies: Record<string, Uint8Array> = {}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const m = /\/v1\/skills\/([^/]+)(?:\/([^/]+)\/package)?$/.exec(url);
    if (!m) return new Response("", { status: 404 });
    const name = m[1] as string;
    if (!m[2]) {
      const list = versions.map((v) => {
        const body = bodies[v] ?? pack(name, v);
        return { version: v, sha256: sha(body) };
      });
      return Response.json({ name, versions: list });
    }
    return new Response(bodies[m[2]] ?? pack(name, m[2]));
  }) as typeof fetch;
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "skills-reg-"));
  renameHook.failOn = undefined;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const URL_ = "https://registry.example";

describe("versions", () => {
  it("compares large numeric components without Number", () => {
    expect(compareSkillVersions("1.0.99999999999999999999", "1.0.100000000000000000000")).toBe(-1);
    expect(compareSkillVersions("9007199254740993.0.0", "9007199254740992.0.0")).toBe(1);
    expect(compareSkillVersions("1.0.0-9007199254740993", "1.0.0-9007199254740992")).toBe(1);
    expect(compareSkillVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(compareSkillVersions("1.0.0+a", "1.0.0+b")).toBe(0);
    expect(() => compareSkillVersions("1.0", "1.0.0")).toThrow(SkillsRegistryError);
  });

  it("picks the highest stable release by default and the exact prerelease when asked", async () => {
    const f = fakeFetch(["1.0.0", "1.1.0-beta.1", "1.0.1"]);
    expect((await downloadSkill(URL_, "demo", { fetch: f })).version).toBe("1.0.1");
    expect((await downloadSkill(URL_, "demo@1.1.0-beta.1", { fetch: f })).version).toBe(
      "1.1.0-beta.1",
    );
    await expect(downloadSkill(URL_, "demo@2.0.0", { fetch: f })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(downloadSkill(URL_, "Bad_Name", { fetch: f })).rejects.toMatchObject({
      code: "invalid_name",
    });
  });
});

describe("download and verify", () => {
  it("rejects a digest mismatch", async () => {
    const f = (async (input: string | URL | Request) =>
      String(input).endsWith("/package")
        ? new Response(pack("demo", "1.0.0"))
        : Response.json({
            versions: [{ version: "1.0.0", sha256: "0".repeat(64) }],
          })) as typeof fetch;
    await expect(downloadSkill(URL_, "demo", { fetch: f })).rejects.toMatchObject({
      code: "digest_mismatch",
    });
  });

  it("stops reading a body over the cap", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(256 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(chunk);
      },
    });
    const f = (async (input: string | URL | Request) =>
      String(input).endsWith("/package")
        ? new Response(stream)
        : Response.json({
            versions: [{ version: "1.0.0", sha256: "0".repeat(64) }],
          })) as typeof fetch;
    await expect(downloadSkill(URL_, "demo", { fetch: f })).rejects.toMatchObject({
      code: "too_large",
    });
    expect(pulled).toBeLessThanOrEqual(MAX_PACKAGE_BYTES / chunk.length + 3);
    expect(() =>
      verifySkillPackage(new Uint8Array(MAX_PACKAGE_BYTES + 1), {
        name: "demo",
        version: "1.0.0",
        sha256: "x",
      }),
    ).toThrow(expect.objectContaining({ code: "too_large" }));
  });

  it("refuses insecure URLs and accepts loopback http", async () => {
    await expect(
      downloadSkill("http://example.com", "demo", { fetch: fakeFetch(["1.0.0"]) }),
    ).rejects.toMatchObject({
      code: "insecure_url",
    });
    expect(
      (await downloadSkill("http://127.0.0.1:9000", "demo", { fetch: fakeFetch(["1.0.0"]) })).name,
    ).toBe("demo");
  });

  it("maps a failing fetch to unreachable", async () => {
    const f = (async () => {
      throw new Error("down");
    }) as typeof fetch;
    await expect(downloadSkill(URL_, "demo", { fetch: f })).rejects.toMatchObject({
      code: "unreachable",
    });
  });

  it.each([
    ["name differs", skillMd("other")],
    ["duplicate name", skillMd("demo", "name: other\n")],
    ["name after duplicate", `---\nname: other\nname: demo\n---\n`],
    ["malformed name", "---\nname: [demo]\n---\n"],
    ["multi-line name", "---\nname: demo\n  other\n---\n"],
    ["no frontmatter", "hello"],
  ])("rejects a SKILL.md with %s", async (_l, md) => {
    const body = pack("demo", "1.0.0", [{ path: "SKILL.md", contentBase64: b64(md) }]);
    const f = fakeFetch(["1.0.0"], { "1.0.0": body });
    await expect(downloadSkill(URL_, "demo", { fetch: f })).rejects.toMatchObject({
      code: "invalid_skill_md",
    });
  });

  it("accepts a quoted name", () => {
    const body = pack("demo", "1.0.0", [
      { path: "SKILL.md", contentBase64: b64('---\nname: "demo"\n---\n') },
    ]);
    expect(
      verifySkillPackage(body, { name: "demo", version: "1.0.0", sha256: sha(body) }).files,
    ).toHaveLength(1);
  });
});

describe("install", () => {
  const verified = (version: string, extra: { path: string; contentBase64: string }[] = []) => {
    const body = pack("demo", version, [
      { path: "SKILL.md", contentBase64: b64(skillMd("demo")) },
      ...extra,
    ]);
    return verifySkillPackage(body, { name: "demo", version, sha256: sha(body) });
  };

  it("writes files and .origin.json, and a second install replaces it", async () => {
    const skills = join(dir, "skills");
    const { dir: out } = await installSkill(
      skills,
      verified("1.0.0", [{ path: "a/b.txt", contentBase64: b64("x") }]),
      {
        registry: URL_,
      },
    );
    expect(out).toBe(join(skills, "demo"));
    expect(await readFile(join(out, "a/b.txt"), "utf8")).toBe("x");
    expect(JSON.parse(await readFile(join(out, ".origin.json"), "utf8"))).toMatchObject({
      registry: URL_,
      name: "demo",
      version: "1.0.0",
    });
    await installSkill(skills, verified("2.0.0"), { registry: URL_ });
    expect(JSON.parse(await readFile(join(out, ".origin.json"), "utf8")).version).toBe("2.0.0");
    await expect(readFile(join(out, "a/b.txt"))).rejects.toThrow();
    expect(await readdir(skills)).toEqual(["demo"]);
  });

  it.each([
    "../x",
    "/etc/x",
    "a\\b",
    "C:x",
    "a//b",
    "a/./../b",
    ".origin.json",
  ])("refuses path %s and writes nothing", async (path) => {
    const skills = join(dir, "skills");
    const body = pack("demo", "1.0.0", [
      { path: "SKILL.md", contentBase64: b64(skillMd("demo")) },
      { path, contentBase64: b64("x") },
    ]);
    expect(() =>
      verifySkillPackage(body, { name: "demo", version: "1.0.0", sha256: sha(body) }),
    ).toThrow(expect.objectContaining({ code: "unsafe_path" }));
    const forged = {
      name: "demo",
      version: "1.0.0",
      sha256: "x",
      files: [{ path, bytes: new Uint8Array(1) }],
    };
    await expect(installSkill(skills, forged, { registry: URL_ })).rejects.toMatchObject({
      code: "unsafe_path",
    });
    await expect(readdir(skills)).rejects.toThrow();
  });

  it("keeps the previous version when the final rename fails", async () => {
    const skills = join(dir, "skills");
    await installSkill(skills, verified("1.0.0"), { registry: URL_ });
    renameHook.failOn = (to, from) => to === join(skills, "demo") && from.endsWith("new");
    await expect(installSkill(skills, verified("2.0.0"), { registry: URL_ })).rejects.toMatchObject(
      {
        code: "install_failed",
      },
    );
    expect(JSON.parse(await readFile(join(skills, "demo", ".origin.json"), "utf8")).version).toBe(
      "1.0.0",
    );
    expect(await readdir(skills)).toEqual(["demo"]);
  });
});
