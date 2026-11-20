import { describe, expect, it, vi } from "vitest";
import { searchSkills } from "../src/index.js";

const json = (v: unknown, init?: ResponseInit) => new Response(JSON.stringify(v), init);
const good = { name: "demo", description: "d", latest: "1.0.0", versions: ["1.0.0"] };

describe("searchSkills", () => {
  it("returns only well-formed entries and encodes q", async () => {
    const f = vi.fn(async () =>
      json([
        good,
        { name: "Bad Name", description: "d", latest: "1.0.0", versions: [] },
        { name: "x" },
        null,
      ]),
    );
    const out = await searchSkills("https://r.example/base/", "a b&c", { fetch: f as never });
    expect(out).toEqual([good]);
    expect((f.mock.calls[0] as unknown[])[0]).toBe("https://r.example/base/v1/skills?q=a%20b%26c");
  });

  it("refuses plain http off loopback without calling fetch", async () => {
    const f = vi.fn();
    await expect(
      searchSkills("http://example.com", "x", { fetch: f as never }),
    ).rejects.toMatchObject({
      code: "insecure_url",
    });
    expect(f).not.toHaveBeenCalled();
  });

  it("caps the response", async () => {
    const f = async () => json([good]);
    await expect(
      searchSkills("https://r.example", "x", { fetch: f as never, maxBytes: 10 }),
    ).rejects.toMatchObject({
      code: "too_large",
    });
  });

  it("times out when fetch never resolves", async () => {
    const f = () => new Promise<Response>(() => {});
    await expect(
      searchSkills("https://r.example", "x", { fetch: f as never, timeoutMs: 20 }),
    ).rejects.toMatchObject({
      code: "unreachable",
    });
  });
});
