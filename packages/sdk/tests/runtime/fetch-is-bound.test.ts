/**
 * `fetch` must be bound before it is stored or passed.
 *
 * `this.fetchImpl = options.fetch ?? fetch` detaches the global from its receiver. Node's undici
 * tolerates that; **workerd does not** — calling it as a property of another object, or as a bare
 * function in a module where `this` is `undefined`, throws:
 *
 *     Illegal invocation: function called with incorrect `this` reference.
 *     See https://developers.cloudflare.com/workers/observability/errors/
 *
 * Measured on 2026-09-28, and reached only after two other filesystem defects were cleared, so it is
 * the fourth layer of one deploy (theokit#705, theokit B-321..B-323):
 *
 *     agent turn failed (AGENT_ERROR): openrouter transport failure on /v1/chat/completions:
 *     Illegal invocation: function called with incorrect `this` reference.
 *
 * ## Why a sweep and not one file
 *
 * The turn that failed went through `internal/llm/openai.ts`. Thirteen call sites across eleven files
 * write the same expression, so fixing the one that happened to run would leave twelve identical
 * landmines — every other provider, the memory adapter, the credential resolver, the cloud-run client.
 * That is the shape a consumer of this package pays for one deploy at a time.
 *
 * ## Why `.bind(globalThis)` and not a call-site `(0, f)(…)`
 *
 * The comma trick fixes one invocation and has to be remembered at each. Binding once, where the
 * reference is taken, fixes every call that reference will ever receive — and `boundFetch` is the one
 * place that knows the rule, so the sweep below can assert it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { boundFetch } from "../../src/internal/runtime-fetch.js";

const SRC = new URL("../../src", import.meta.url).pathname;

/** Every `.ts` under `src`, so a file added later is swept without editing this list. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return extname(entry.name) === ".ts" && !entry.name.endsWith(".d.ts") ? [full] : [];
  });
}

/** Source with comments removed, so prose naming the expression is not read as the expression. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** The detached forms: `?? fetch`, `?? globalThis.fetch`, `= fetch;`. */
const DETACHED = /\?\?\s*(globalThis\.)?fetch\b|=\s*globalThis\.fetch\s*;|=\s*fetch\s*;/;

describe("runtime fetch is bound", () => {
  it("binds the global to its own receiver", () => {
    // The property that fails on workerd, asserted where it can be: a bound function reports a
    // receiver that is not the object it gets attached to.
    const holder = { f: boundFetch() };

    expect(holder.f.name).toContain("fetch");
    // `bind` produces a new function object, so it is not the global itself — which is the whole
    // point: the global would take `holder` as its `this`.
    expect(holder.f).not.toBe(globalThis.fetch);
  });

  it("returns an override untouched", () => {
    // COUNTERPROOF: a test double must reach the transport as itself. Binding an injected fetch would
    // break every suite that asserts on the function it passed in.
    const injected = (async () => new Response("x")) as unknown as typeof fetch;

    expect(boundFetch(injected)).toBe(injected);
  });

  it("no source file takes a detached reference to the global", () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !file.endsWith("runtime-fetch.ts"))
      .filter((file) => DETACHED.test(code(readFileSync(file, "utf8"))))
      .map((file) => file.slice(SRC.length + 1));

    expect(
      offenders,
      "these files store or pass the global `fetch` detached from its receiver. Node tolerates it; " +
        "workerd throws `Illegal invocation: function called with incorrect this reference`, so every " +
        "one of them is a deploy that fails on the first request through it. Use `boundFetch(...)`",
    ).toEqual([]);
  });

  it("the sweep actually reads the tree", () => {
    // COUNTERPROOF FIRST in spirit: an empty file list satisfies the case above trivially. Measured
    // when written, the tree held well over a thousand `.ts` files and thirteen offenders.
    const files = sourceFiles(SRC);

    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => f.endsWith("internal/llm/openai.ts"))).toBe(true);
  });

  it("the matcher is not satisfied by prose", () => {
    // This file's own docblock quotes the forbidden expression to explain it. Without stripping
    // comments the sweep would report every file that documents the rule.
    expect(
      DETACHED.test(code("/** was `options.fetch ?? fetch` once. */\nexport const x = 1;\n")),
    ).toBe(false);
    expect(DETACHED.test(code("const f = options.fetch ?? fetch;\n"))).toBe(true);
  });
});
