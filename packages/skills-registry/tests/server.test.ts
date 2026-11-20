import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSkillsRegistryHandler, type SkillPackage } from "../src/index.js";

const TOKEN = "tok-SECRET-123";
const BASE = "http://registry.test";
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "skill-server-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const pkg = (version = "1.0.0", extra: { path: string; contentBase64: string }[] = []) =>
  ({
    name: "demo",
    version,
    description: "A demo",
    files: [
      {
        path: "SKILL.md",
        contentBase64: Buffer.from("---\nname: demo\n---\nbody\n").toString("base64"),
      },
      ...extra,
    ],
  }) satisfies SkillPackage;

const put = (body: string | Uint8Array, version = "1.0.0", token = TOKEN) =>
  new Request(`${BASE}/v1/skills/demo/${version}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}` },
    body,
  });

const stored = async () => (await readdir(dir)).sort();

describe("createSkillsRegistryHandler", () => {
  it("publishes, lists and serves the stored bytes with the publish-time digest", async () => {
    const h = createSkillsRegistryHandler({ dir, token: TOKEN });
    const body = JSON.stringify(pkg());
    expect((await h(put(body))).status).toBe(201);
    const list = (await (await h(new Request(`${BASE}/v1/skills/demo`))).json()) as {
      versions: { version: string; size: number }[];
    };
    expect(list).toMatchObject({ name: "demo", description: "A demo" });
    expect(list.versions).toHaveLength(1);
    expect(list.versions[0]).toMatchObject({ version: "1.0.0", size: Buffer.byteLength(body) });
    const res = await h(new Request(`${BASE}/v1/skills/demo/1.0.0/package`));
    expect(await res.text()).toBe(body);
    expect((await h(new Request(`${BASE}/v1/skills/nope`))).status).toBe(404);
  });

  it("answers 409 for a second publish and keeps the stored bytes", async () => {
    const h = createSkillsRegistryHandler({ dir, token: TOKEN });
    const first = JSON.stringify(pkg());
    await h(put(first));
    const second = JSON.stringify({ ...pkg(), description: "changed" });
    expect((await h(put(second))).status).toBe(409);
    const res = await h(new Request(`${BASE}/v1/skills/demo/1.0.0/package`));
    expect(await res.text()).toBe(first);
  });

  it("lets only one of several concurrent publishes win", async () => {
    const h = createSkillsRegistryHandler({ dir, token: TOKEN });
    const codes = (await Promise.all([1, 2, 3, 4].map(() => h(put(JSON.stringify(pkg())))))).map(
      (r) => r.status,
    );
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(3);
    expect(await readdir(dir)).toEqual(["demo"]);
  });

  it("answers 401 with www-authenticate for a wrong or missing token and stores nothing", async () => {
    const h = createSkillsRegistryHandler({ dir, token: TOKEN });
    const res = await h(put(JSON.stringify(pkg()), "1.0.0", "wrong"));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    const none = await h(
      new Request(`${BASE}/v1/skills/demo/1.0.0`, { method: "PUT", body: "{}" }),
    );
    expect(none.status).toBe(401);
    expect(await stored()).toEqual([]);
  });

  it("answers 413 for a body of 1 MiB + 1 byte", async () => {
    const h = createSkillsRegistryHandler({ dir, token: TOKEN });
    const res = await h(put(new Uint8Array(1024 * 1024 + 1)));
    expect(res.status).toBe(413);
    expect(await stored()).toEqual([]);
  });

  it("answers 413 without a content-length once the stream passes the cap", async () => {
    const h = createSkillsRegistryHandler({ dir, token: TOKEN, maxPackageBytes: 10 });
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(6));
        c.enqueue(new Uint8Array(6));
        c.close();
      },
    });
    const req = new Request(`${BASE}/v1/skills/demo/1.0.0`, {
      method: "PUT",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect((await h(req)).status).toBe(413);
  });

  it("answers 400 for a ../ path and stores nothing", async () => {
    const h = createSkillsRegistryHandler({ dir, token: TOKEN });
    const bad = pkg("1.0.0", [{ path: "../evil", contentBase64: "eA==" }]);
    const res = await h(put(JSON.stringify(bad)));
    expect(res.status).toBe(400);
    expect(await stored()).toEqual([]);
  });

  it("answers 400 when the package differs from the URL, or is not JSON", async () => {
    const h = createSkillsRegistryHandler({ dir, token: TOKEN });
    expect((await h(put(JSON.stringify(pkg("1.0.1"))))).status).toBe(400);
    expect((await h(put("not json"))).status).toBe(400);
    expect((await h(put("{}", "not-semver"))).status).toBe(400);
    expect(await stored()).toEqual([]);
  });

  it("answers 500 and reports method and path when storage throws", async () => {
    const file = join(dir, "file");
    await writeFile(file, "x");
    const onError = vi.fn();
    const h = createSkillsRegistryHandler({ dir: join(file, "sub"), token: TOKEN, onError });
    const res = await h(put(JSON.stringify(pkg())));
    expect(res.status).toBe(500);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(onError.mock.calls[0]?.[1]).toEqual({ method: "PUT", path: "/v1/skills/demo/1.0.0" });
    expect(await readFile(file, "utf8")).toBe("x");
  });

  it("logs to stderr by default without the token", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const file = join(dir, "file");
      await writeFile(file, "x");
      const h = createSkillsRegistryHandler({ dir: join(file, TOKEN), token: TOKEN });
      expect((await h(put(JSON.stringify(pkg())))).status).toBe(500);
      const out = write.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain("PUT /v1/skills/demo/1.0.0");
      expect(out).not.toContain(TOKEN);
    } finally {
      write.mockRestore();
    }
  });
});
