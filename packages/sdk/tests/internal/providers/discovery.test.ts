/**
 * Tests for lazy provider discovery (T3.4).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetDiscovery,
  discoverProviderPlugins,
} from "../../../src/internal/providers/discovery.js";
import {
  _resetProvidersForTests,
  getProviderProfile,
} from "../../../src/internal/providers/registry.js";

let tmpHome: string;
let originalHome: string | undefined;

/** M47 — write the explicit trust allowlist the gate requires. */
function trust(...names: string[]): void {
  const dir = join(tmpHome, ".theokit", "plugins");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "trusted-providers.json"), JSON.stringify(names));
}

beforeEach(() => {
  _resetDiscovery();
  _resetProvidersForTests();
  tmpHome = mkdtempSync(join(tmpdir(), "discovery-test-"));
  originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
});
afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  if (originalHome !== undefined) process.env.HOME = originalHome;
});

describe("discoverProviderPlugins (T3.4)", () => {
  it("idempotent — second call no-op", async () => {
    // B-064. The body used to end in `expect(true).toBe(true)` with "nothing to assert beyond not
    // throwing" — but idempotence IS observable. An untrusted plugin is warned about once per name
    // (B-686 replaced the process latch with a per-name `warned` set), so counting those warnings is
    // what makes removing that set fail this test rather than pass it silently.
    const dir = join(tmpHome, ".theokit", "plugins", "model-providers", "untrusted-probe");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.mjs"), "export default {};");
    _resetDiscovery();

    let warnings = 0;
    const write = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
      if (String(chunk).includes("untrusted-probe")) warnings += 1;
      return true;
    }) as never);

    try {
      await discoverProviderPlugins();
      const afterFirst = warnings;
      await discoverProviderPlugins();

      expect(afterFirst, "the first call must actually scan the plugins root").toBe(1);
      expect(warnings, "the second call warns once per name: no second warning").toBe(afterFirst);
    } finally {
      write.mockRestore();
    }
  });

  it("no directory: no-op", async () => {
    await discoverProviderPlugins();
    expect(getProviderProfile("anything")).toBeUndefined();
  });

  it("EC-9: loads valid ESM plugin via file:// URL", async () => {
    const pluginDir = join(tmpHome, ".theokit", "plugins", "model-providers", "mistral-fake");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, "index.mjs"),
      `export default {
  name: "mistral-fake",
  version: "1.0.0",
  kind: "model-provider",
  profile: {
    name: "mistral",
    apiMode: "chat_completions",
    envVars: ["MISTRAL_API_KEY"],
    authType: "api_key",
    baseUrl: "https://api.mistral.ai",
    fallbackModels: ["mistral-large"],
  },
};
`,
    );

    trust("mistral-fake"); // M47 — the gate requires explicit trust
    await discoverProviderPlugins();
    expect(getProviderProfile("mistral")?.apiMode).toBe("chat_completions");
  });

  it("skips broken plugin without crashing", async () => {
    const pluginDir = join(tmpHome, ".theokit", "plugins", "model-providers", "broken");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "index.mjs"), `throw new Error("syntax error in plugin");\n`);

    trust("broken"); // M47 — trusted but broken: the load-error tolerance path
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await discoverProviderPlugins();
    const calls = stderrSpy.mock.calls.map((c) => c[0] as string).join("");
    expect(calls).toContain("failed to load");
    stderrSpy.mockRestore();
  });
});
