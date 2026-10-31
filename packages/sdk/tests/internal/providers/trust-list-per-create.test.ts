/**
 * B-686 (FR-004, NFR-003): the trust gate is read on every `Agent.create`, not once per process.
 *
 * Provider discovery used to latch after its first call (`discoveryState.done`), so a name the
 * operator trusted between two creates stayed invisible until a restart, and the untrusted warning
 * told them to restart. Each fixture entry appends one byte to a sentinel at module evaluation, so
 * "imported" and "imported once" are read from the sentinel's length, never from a registration.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Agent } from "../../../src/agent.js";
import { setDiagnosticsSink } from "../../../src/internal/diagnostics.js";
import { _resetDiscovery } from "../../../src/internal/providers/discovery.js";
import { _resetProvidersForTests } from "../../../src/internal/providers/registry.js";
import { useTempCwd } from "../../helpers/temp-workspace.js";

useTempCwd("theokit-trust-per-create-");

const STUB_KEY = `sk-test-${"0".repeat(40)}`;

function providerSentinel(name: string): string {
  return join(homedir(), `${name}.provider.sentinel`);
}

/** A provider plugin whose evaluation appends one byte to its sentinel. */
function providerFixture(name: string): void {
  const dir = join(homedir(), ".theokit", "plugins", "model-providers", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "index.mjs"),
    `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(providerSentinel(name))}, "x");
export default {
  name: ${JSON.stringify(name)},
  version: "1.0.0",
  kind: "model-provider",
  profile: { name: ${JSON.stringify(name)}, apiMode: "chat_completions", envVars: [], authType: "api_key",
             baseUrl: "https://fixture.invalid/v1", fallbackModels: [${JSON.stringify(`${name}/m`)}] },
};
`,
  );
}

function writeTrustFile(content: string): void {
  const dir = join(homedir(), ".theokit", "plugins");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "trusted-providers.json"), content);
}

async function createAndDispose(): Promise<void> {
  const agent = await Agent.create({
    apiKey: STUB_KEY,
    model: { id: "o4-mini" },
    providers: { routes: [{ capability: "chat", provider: "openai" }] },
    local: { cwd: process.cwd() },
  });
  await agent.dispose?.();
}

/** Run `body` with a sink capturing every diagnostic; the forwarding sink is restored after. */
async function withCapturedDiagnostics(body: (messages: string[]) => Promise<void>): Promise<void> {
  const messages: string[] = [];
  setDiagnosticsSink((message) => {
    messages.push(message);
  });
  try {
    await body(messages);
  } finally {
    setDiagnosticsSink((message) => {
      process.stderr.write(message);
    });
  }
}

beforeEach(() => {
  _resetDiscovery();
  _resetProvidersForTests();
  vi.stubEnv("THEOKIT_TRUSTED_PROVIDERS", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  _resetDiscovery();
  _resetProvidersForTests();
});

describe("the provider trust gate is read on each Agent.create", () => {
  it("imports a provider trusted between two creates on the second create only", async () => {
    providerFixture("late-trusted");
    await createAndDispose();
    expect(existsSync(providerSentinel("late-trusted"))).toBe(false);

    vi.stubEnv("THEOKIT_TRUSTED_PROVIDERS", "late-trusted");
    await createAndDispose();
    expect(existsSync(providerSentinel("late-trusted"))).toBe(true);
  });

  it("warns once per untrusted provider name across two creates", async () => {
    providerFixture("never-trusted");
    await withCapturedDiagnostics(async (messages) => {
      await createAndDispose();
      await createAndDispose();
      expect(messages.filter((m) => m.includes('"never-trusted"'))).toHaveLength(1);
    });
  });

  it("the warning names the trust file and the env and no longer says restart", async () => {
    providerFixture("needs-trust");
    await withCapturedDiagnostics(async (messages) => {
      await createAndDispose();
      const warning = messages.find((m) => m.includes('"needs-trust"')) ?? "";
      expect(warning).toContain("trusted-providers.json");
      expect(warning).toContain("THEOKIT_TRUSTED_PROVIDERS");
      expect(warning).not.toContain("then restart the process");
    });
  });

  it("a trusted provider is imported once across three creates", async () => {
    providerFixture("steady");
    writeTrustFile(JSON.stringify(["steady"]));
    await createAndDispose();
    await createAndDispose();
    await createAndDispose();
    expect(readFileSync(providerSentinel("steady"), "utf8")).toHaveLength(1);
  });

  it("a malformed trust file still trusts nothing on a later create", async () => {
    providerFixture("first");
    providerFixture("second");
    writeTrustFile(JSON.stringify(["first"]));
    await createAndDispose();
    expect(existsSync(providerSentinel("first"))).toBe(true);

    writeTrustFile("{ not json !!");
    await withCapturedDiagnostics(async (messages) => {
      await createAndDispose();
      expect(existsSync(providerSentinel("second"))).toBe(false);
      expect(messages.join("")).toContain("not valid JSON");
    });
  });
});
